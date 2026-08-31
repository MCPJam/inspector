import type { Context } from "hono";
import type { ChatRewind } from "@/shared/chat-v2";
import type {
  McpToolResultImageRenderingPolicy,
  ModelVisibleMcpToolResults,
} from "@mcpjam/sdk/host-config/internal";
import { logger } from "./logger";
import { getRequestLogger } from "./request-logger";
import type { UIMessageChunk } from "ai";
import {
  PERSIST_RECEIPT_PART_TYPE,
  type PersistReceiptData,
} from "@/shared/persist-receipt";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { LiveChatTraceUsage } from "@/shared/live-chat-trace";

const DEFAULT_INGEST_TIMEOUT_MS = 5_000;
/**
 * Backoff before retry 1 and retry 2. Only transient failures are retried, so
 * the ceiling is deliberately low — this runs while the SSE stream is held open
 * waiting to close.
 */
const INGEST_RETRY_DELAYS_MS = [500, 1_500] as const;
/**
 * Ceiling on the retry sequence: attempts and backoff together never push the
 * persist past this. A real deadline, not a nominal one — each attempt's
 * timeout is clamped to the budget that remains, so a receipt-gated stream
 * close cannot hang past it.
 *
 * A caller that asks for a per-attempt timeout LONGER than this still gets one
 * full attempt (it asked for that wait explicitly); the budget then bounds the
 * retries rather than truncating the request the caller configured. No live
 * caller does this today — every rail takes the 5s default.
 */
const INGEST_TOTAL_BUDGET_MS = 15_000;
const MAX_RESPONSE_PREVIEW_CHARS = 200;

export type PersistChatFailureKind =
  | "timeout"
  | "http_error"
  /** 2xx whose body could not be read, or carried no version to sync to. */
  | "protocol_error"
  | "exception";

/**
 * What actually happened to a turn's persist.
 *
 * The server awaits the ingest and holds this result in hand; before this
 * existed it threw the result away and returned `void`, leaving the client to
 * infer success by polling a version counter from the outside. Every failure
 * mode was silent, which is how hosted turns went missing without anyone —
 * user, client, or log — being told.
 */
export type PersistChatOutcome =
  | { outcome: "saved"; version: number; sessionDocId?: string }
  /** The backend recognized this exact turnId as already applied. As good as saved. */
  | { outcome: "duplicate"; version: number; sessionDocId?: string }
  /** Legacy count-based replay skip (old backend, or a payload with no turnId). */
  | { outcome: "skipped"; version?: number; sessionDocId?: string }
  | { outcome: "conflict"; currentVersion?: number }
  | {
      outcome: "failed";
      failureKind: PersistChatFailureKind;
      status?: number;
    }
  | {
      outcome: "not-attempted";
      reason: "no-convex-url" | "no-auth" | "no-session-id";
    };

/**
 * Headers worth forwarding from the browser request to the Convex ingestion
 * endpoint so that usage-insights enrichment (device, language) works.
 */
const ENRICHMENT_HEADERS_TO_FORWARD = [
  "user-agent",
  "accept-language",
] as const;

/**
 * Pick enrichment-relevant headers from an incoming request so they can be
 * forwarded to the Convex `/ingest-chat` endpoint.
 */
export function pickEnrichmentHeaders(
  reqHeaders: { get(name: string): string | null | undefined } | Headers
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ENRICHMENT_HEADERS_TO_FORWARD) {
    const value =
      typeof reqHeaders.get === "function" ? reqHeaders.get(name) : undefined;
    if (value) {
      result[name] = value;
    }
  }
  return result;
}

export interface ResumeConfig {
  systemPrompt?: string;
  temperature?: number;
  requireToolApproval?: boolean;
  respectToolVisibility?: boolean;
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
  selectedServers?: string[];
  /**
   * Agent-Playground FIRST-TURN PINS (`origin: "api"` sessions).
   *
   * Hand-mirrored from `chatResumeConfigValidator` in the backend. These four
   * are the fields the ingest boundary protects with `preserveAgentResumePins`
   * — first-write-wins, so a continuation cannot swap the model, the tool
   * policy, or the target out from under a session that already pinned them.
   * The route's own `CONFIG_ON_CONTINUATION` check is the friendly error; this
   * is the guarantee.
   *
   * Adding a field here is NOT enough to make it persist: the backend's HTTP
   * ingest projects `resumeConfig` through an explicit allowlist, so a new key
   * that is not in `AGENT_RESUME_PIN_KEYS` (and its projection) validates,
   * returns 200, and is silently dropped.
   */
  modelId?: string;
  toolMode?: AgentTurnToolMode;
  environmentId?: string;
  serverIds?: string[];
}

/**
 * Tool-effects policy for an agent Playground turn.
 *
 * `read_only` advertises only tools whose `annotations.readOnlyHint === true`;
 * `auto` advertises everything the target exposes and may therefore cause
 * external side effects through arbitrary third-party tools. The hint is
 * SERVER-ASSERTED — a server is free to mislabel a mutating tool — so this is
 * a policy the host applies, not a guarantee the host can verify.
 */
export type AgentTurnToolMode = "read_only" | "auto";

/**
 * Direct-chat host configuration sent alongside the transcript so the backend
 * can dedupe per-turn config into `hostConfigs`. Mirrors the `HostConfigPayload`
 * shape accepted by the Convex `/ingest-chat` route. Only emitted for direct
 * chats (serverShare and scenario flows skip it).
 *
 * Phase 3 read switch: `hostStyle` carries the real host style. HostConfig v2
 * treats this as an extensible string (Claude, ChatGPT, Cursor, Codex, custom
 * hosts, etc.); old inspector builds that send `"direct"` are still accepted
 * by the backend and normalized there.
 */
export type DirectChatHostStyle = string;
export interface DirectHostConfig {
  hostStyle: DirectChatHostStyle;
  systemPrompt: string;
  modelId: string;
  temperature: number;
  requireToolApproval: boolean;
  /**
   * Optional SEP-1865 visibility filter switch. Undefined means "use the
   * spec default" — the backend's hostConfigV2 canonicalizer drops
   * `undefined` so pre-feature rows stay byte-identical.
   */
  respectToolVisibility?: boolean;
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
  selectedServerIds: string[];
}

/**
 * Build a contract-safe direct `hostConfig` payload from the inspector's
 * loose runtime values. Coerces undefined `systemPrompt` / `temperature` /
 * `requireToolApproval` / `selectedServerIds` into the types the backend's
 * `isHostConfigPayload` guard requires — without this, paths like GPT-5 (where
 * `resolvedTemperature` is undefined) would fail the guard and skip with
 * `missing_field`.
 *
 * `hostStyle` defaults to `"claude"` when the caller doesn't supply one.
 * Old call sites that used to hardcode `"direct"` should pass the
 * resolved chat-tab host style instead — see ChatTabV2's hydration
 * from project default for the source of truth.
 */
export function buildDirectHostConfig(input: {
  modelId: string;
  hostStyle?: DirectChatHostStyle;
  systemPrompt?: string;
  requestedTemperature?: number;
  resolvedTemperature?: number;
  requireToolApproval?: boolean;
  respectToolVisibility?: boolean;
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
  selectedServerIds?: string[];
}): DirectHostConfig {
  const {
    modelId,
    hostStyle,
    systemPrompt,
    requestedTemperature,
    resolvedTemperature,
    requireToolApproval,
    respectToolVisibility,
    modelVisibleMcpToolResults,
    mcpToolResultImageRendering,
    selectedServerIds,
  } = input;
  return {
    hostStyle: hostStyle ?? "claude",
    systemPrompt: systemPrompt ?? "",
    modelId,
    temperature:
      typeof resolvedTemperature === "number"
        ? resolvedTemperature
        : typeof requestedTemperature === "number"
        ? requestedTemperature
        : 0.7,
    requireToolApproval: requireToolApproval === true,
    // Pass through verbatim so undefined-vs-set semantics survive into
    // the backend canonicalizer (drops undefined; keeps explicit false).
    ...(respectToolVisibility !== undefined ? { respectToolVisibility } : {}),
    ...(modelVisibleMcpToolResults !== undefined
      ? { modelVisibleMcpToolResults }
      : {}),
    ...(mcpToolResultImageRendering !== undefined
      ? { mcpToolResultImageRendering }
      : {}),
    selectedServerIds: selectedServerIds ?? [],
  };
}

/**
 * Shape of a single completed chat turn's trace as it flows from the stream
 * producers (`streamDirectChatWithLiveTrace`, `handleMCPJamFreeChatModel`)
 * through `persistChatSessionToConvex` to the Convex `/ingest-chat` handler.
 * Kept in one place so the producer callbacks and the wire body can't drift.
 */
export interface PersistedTurnTrace {
  turnId: string;
  promptIndex: number;
  startedAt: number;
  endedAt: number;
  spans: EvalTraceSpan[];
  usage?: LiveChatTraceUsage;
  finishReason?: string;
  modelId: string;
  /**
   * Which skills and which environment this turn ran with, echoed from the
   * backend's per-entry `provenance` rows (see
   * `services/environments/runtime.ts` `turnSkillProvenance`).
   *
   * Carried INSIDE the turn trace, not beside it, for two reasons. The binding
   * is per-TURN — a session live-follows Latest, so an edit changes what the
   * NEXT turn runs. And `buildIngestBody` serializes `turnTrace` whole, so
   * these fields reach the wire with NO change to the body builder: do not
   * "fix" that by adding them to its spread.
   *
   * Ids are opaque strings here. The backend normalizes and tenancy-checks
   * every one and strips what fails, so this side never needs to.
   */
  skillsAtTurn?: Array<Record<string, unknown>>;
  environmentAtTurn?: {
    environmentId: string;
    name: string;
    revision: number;
  };
}

// Mirrors mcpjam-backend `chatOriginValidator`. Required at every writer
// boundary so a new surface can't be added without explicitly choosing one.
// Backend still accepts undefined for historical-row compatibility; the
// inspector pins to the closed set. `swarm` is the journey-execution surface
// (single-host synthetic sessions launched by a project member).
export type ChatOrigin =
  | "playground"
  | "mcpjam_agent"
  | "scenario"
  | "eval"
  | "swarm"
  // Agent Playground turn route. Validator ships with backend PR 4; this
  // mirror must exist before anything emits `"api"`.
  | "api";

interface PersistChatSessionOptions {
  chatSessionId: string;
  modelId: string;
  modelSource: "mcpjam" | "byok" | "local_byok";
  authHeader?: string;
  projectId?: string;
  sourceType?: "scenario" | "direct" | "eval" | "swarm";
  origin: ChatOrigin;
  directVisibility?: "private" | "project";
  surface?: "preview" | "share_link";
  scenarioId?: string;
  serverId?: string;
  visitorDisplayName?: string;
  sessionMessages?: unknown[];
  messages?: unknown[];
  /**
   * The system prompt as SENT — turn-injected sections included.
   *
   * Evidence, not configuration. It is what the Raw view and
   * `get_chat_session` show, so it has to be the string the model actually
   * received: the host prompt plus whatever the turn added (the server-skill
   * catalog, widget model context, the environment block, sandbox notices).
   *
   * NOT the same field as `resumeConfig.systemPrompt`, which is the RAW host
   * prompt a resumed turn replays. Turn-injected content is true of the turn
   * that happened and not of the next one, so the two must not be merged —
   * see the comment at the hosted persist call.
   */
  systemPrompt?: string;
  responseMessages?: unknown[];
  assistantText?: string;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  usage?: { inputTokens: number; outputTokens: number };
  finishReason?: string;
  startedAt: number;
  lastActivityAt?: number;
  timeoutMs?: number;
  resumeConfig?: ResumeConfig;
  expectedVersion?: number;
  rewind?: ChatRewind;
  turnTrace?: PersistedTurnTrace;
  /**
   * §3: chat-backed harness resume-state commit. Applied ATOMICALLY with the
   * transcript inside the ingest mutation (a failed sidecar commit rolls back
   * the transcript write). Opaque pass-through. `harnessId` is a lane-key
   * dimension (the backend keys per-harness), so it carries the full union.
   */
  harnessSessionCommit?: {
    // `swarm-chat` is the journey-runner continuity lane; the backend derives
    // its journeyRunId/hostId from this ingest's top-level swarm attribution.
    ownerType: "direct-chat" | "scenario-chat" | "swarm-chat";
    chatSessionId: string;
    scenarioId?: string;
    leaseId: string;
    expectedStateVersion: number;
    harnessId: "claude-code" | "codex";
    harnessSessionId: string;
    resumeState: unknown;
    computerId: string;
    runtimeFingerprint: string;
    skillsHash?: string;
  };
  hostConfig?: DirectHostConfig;
  /** Headers from the original browser request to forward for usage enrichment (user-agent, accept-language, geo headers). */
  forwardHeaders?: Record<string, string>;
  /**
   * Multi-server MCP tool snapshot present when this ingestion fired. The
   * backend fans it out to per-server `serverInspections` rows for cross-run
   * diffing. Optional: if absent, the backend skips inspection bookkeeping
   * for this session/turn.
   */
  toolSnapshot?: unknown;
  /**
   * Synthetic-session tagging propagated from
   * `server/services/sessionSimulation/runner.ts` into the Convex
   * `chatSessions` row. The backend uses these to (a) badge the thread
   * "Synthetic" in the Sessions list, (b) default
   * `visitorDisplayName = personaLabel` when omitted, (c) exclude the
   * row from semantic clustering, and (d) join the row back to its
   * `scenarioSynthesisRuns` parent for progress polling.
   */
  synthetic?: boolean;
  personaId?: string;
  personaLabel?: string;
  /** Durable roster row id; stamped onto `chatSessions.personaRefId`. */
  personaRefId?: string;
  /**
   * Swarm (journey-execution) attribution. `journeyRunId` is the parent
   * journey run; `hostId` is the pinned host this synthetic session ran
   * against. The backend derives journeyRefId / personaRefId /
   * hostConfigIdAtStart from these + the launcher bearer, LAUNCHER-gates the
   * write, and requires `chatSessionId` to match the claimed attempt.
   */
  journeyRunId?: string;
  hostId?: string;
  /**
   * Opaque swarm execution-target id (Project Environments). Echoed verbatim
   * from the pinned snapshot target so the backend can bind the session to the
   * exact target when two targets share a host. Absent for legacy runs and
   * pre-environments snapshots (the backend's host-only fallback still keys
   * those).
   */
  targetId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeSenderUserId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readSenderUserId(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }

  const senderUserId = normalizeSenderUserId(message.senderUserId);
  if (senderUserId) {
    return senderUserId;
  }

  const metadata = message.metadata;
  if (!isRecord(metadata)) {
    return undefined;
  }

  return normalizeSenderUserId(metadata.senderUserId);
}

/**
 * AI SDK model-message conversion intentionally drops UI-only metadata. For
 * shared direct sessions, carry the current authenticated user's
 * `senderUserId` from the incoming UI transcript onto the persisted trace by
 * user-message ordinal so other collaborators can render the same per-message
 * avatar after the stream is saved. The incoming transcript is client-
 * controlled, so the extracted id is only trusted when it matches the
 * server-authenticated principal for this request.
 */
export function stampSenderUserIdsOnSessionMessages(
  sessionMessages: unknown[],
  sourceMessages: unknown[],
  options?: {
    authenticatedUserId?: string | null;
  }
): unknown[] {
  if (!Array.isArray(sessionMessages) || !Array.isArray(sourceMessages)) {
    return sessionMessages;
  }

  const authenticatedUserId = normalizeSenderUserId(
    options?.authenticatedUserId
  );
  const senderUserIdsByUserOrdinal = sourceMessages
    .filter((message) => isRecord(message) && message.role === "user")
    .map((message) => {
      const senderUserId = readSenderUserId(message);
      return senderUserId === authenticatedUserId ? senderUserId : undefined;
    });

  if (!senderUserIdsByUserOrdinal.some(Boolean)) {
    return sessionMessages;
  }

  let userOrdinal = 0;
  let changed = false;
  const stampedMessages = sessionMessages.map((message) => {
    if (!isRecord(message) || message.role !== "user") {
      return message;
    }

    const senderUserId = senderUserIdsByUserOrdinal[userOrdinal];
    userOrdinal += 1;
    if (!senderUserId || message.senderUserId === senderUserId) {
      return message;
    }

    changed = true;
    return { ...message, senderUserId };
  });

  return changed ? stampedMessages : sessionMessages;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function sanitizeDiagnosticText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const masked = normalized
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(
      /(\bauthorization\b\s*[:=]\s*)(bearer\s+)?([^"',\s}]+)/gi,
      (_match, prefix: string, scheme?: string) =>
        `${prefix}${scheme ?? ""}[redacted-token]`
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._\-+/=]+\b/gi, "$1[redacted-token]")
    .replace(
      /(["']?(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi,
      "$1[redacted-secret]"
    )
    .replace(/\bsk-[A-Za-z0-9]+\b/g, "[redacted-secret]");

  if (masked.length <= MAX_RESPONSE_PREVIEW_CHARS) {
    return masked;
  }

  return `${masked.slice(0, MAX_RESPONSE_PREVIEW_CHARS)}...`;
}

async function readResponsePreview(response: Response): Promise<string> {
  const responseText = await response.text().catch(() => "");
  return sanitizeDiagnosticText(responseText);
}
/**
 * Build the `/ingest-chat` request body once, outside the retry loop — every
 * attempt must post byte-identical bytes so `turnId` dedupe can recognize a
 * retry as the same turn.
 */
function buildIngestBody(options: PersistChatSessionOptions): string {
  return JSON.stringify({
    chatSessionId: options.chatSessionId,
    modelId: options.modelId,
    modelSource: options.modelSource,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.sourceType ? { sourceType: options.sourceType } : {}),
    origin: options.origin,
    ...(options.directVisibility
      ? { directVisibility: options.directVisibility }
      : {}),
    ...(options.surface ? { surface: options.surface } : {}),
    ...(options.scenarioId ? { scenarioId: options.scenarioId } : {}),
    // `accessVersion` is deliberately NOT sent: the backend's ingest
    // query never reads it, and ingestion is deliberately NOT version
    // enforced — it persists a turn that ALREADY ran, so a rebind
    // landing mid-turn must not cost the transcript. Auth here stays the
    // grant check (resolveHostedSessionAccess by scenarioId).
    ...(options.serverId ? { serverId: options.serverId } : {}),
    ...(options.visitorDisplayName
      ? { visitorDisplayName: options.visitorDisplayName }
      : {}),
    ...(options.sessionMessages
      ? { sessionMessages: options.sessionMessages }
      : {}),
    ...(options.messages ? { messages: options.messages } : {}),
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.responseMessages
      ? { responseMessages: options.responseMessages }
      : {}),
    ...(options.assistantText ? { assistantText: options.assistantText } : {}),
    ...(options.toolCalls ? { toolCalls: options.toolCalls } : {}),
    ...(options.toolResults ? { toolResults: options.toolResults } : {}),
    ...(options.usage ? { usage: options.usage } : {}),
    ...(options.finishReason ? { finishReason: options.finishReason } : {}),
    startedAt: options.startedAt,
    ...(options.lastActivityAt
      ? { lastActivityAt: options.lastActivityAt }
      : {}),
    ...(options.resumeConfig ? { resumeConfig: options.resumeConfig } : {}),
    ...(options.expectedVersion !== undefined
      ? { expectedVersion: options.expectedVersion }
      : {}),
    // Turn identity, so the backend dedupes on WHICH turn this is instead of
    // guessing from transcript length. Every live rail already threads a
    // turnTrace, so no call site changes; traceless callers (headless replays)
    // stay on the legacy path.
    ...(options.turnTrace?.turnId ? { turnId: options.turnTrace.turnId } : {}),
    ...(options.rewind ? { rewind: options.rewind } : {}),
    ...(options.turnTrace ? { turnTrace: options.turnTrace } : {}),
    ...(options.harnessSessionCommit
      ? { harnessSessionCommit: options.harnessSessionCommit }
      : {}),
    ...(options.hostConfig ? { hostConfig: options.hostConfig } : {}),
    ...(options.toolSnapshot ? { toolSnapshot: options.toolSnapshot } : {}),
    ...(options.synthetic ? { synthetic: true } : {}),
    ...(options.personaId ? { personaId: options.personaId } : {}),
    ...(options.personaLabel ? { personaLabel: options.personaLabel } : {}),
    ...(options.personaRefId ? { personaRefId: options.personaRefId } : {}),
    ...(options.journeyRunId ? { journeyRunId: options.journeyRunId } : {}),
    ...(options.hostId ? { hostId: options.hostId } : {}),
    ...(options.targetId ? { targetId: options.targetId } : {}),
  });
}

type IngestAttemptResult =
  /**
   * The backend answered definitively; stop here whatever the answer was.
   * `preview`/`error` ride along purely so the caller can log with the same
   * detail the pre-outcome implementation did.
   */
  | {
      kind: "settled";
      outcome: PersistChatOutcome;
      preview?: string;
      error?: Error;
    }
  /** Transient — worth another attempt if the budget allows. */
  | {
      kind: "transient";
      failureKind: PersistChatFailureKind;
      status?: number;
      preview?: string;
      error?: Error;
    };

/**
 * Map a 2xx ingest body onto an outcome.
 *
 * A 2xx we cannot read, or one carrying no `version`, is a `protocol_error` —
 * never a fabricated `saved`. The client syncs its optimistic-concurrency
 * baseline from this version, so inventing one would hand it a baseline that
 * 409s on the very next send.
 */
function classifySuccessBody(body: unknown): PersistChatOutcome {
  const parsed = body as
    | {
        skipped?: boolean;
        duplicateTurn?: boolean;
        version?: number;
        sessionId?: unknown;
      }
    | null
    | undefined;

  if (!parsed || typeof parsed.version !== "number") {
    return { outcome: "failed", failureKind: "protocol_error", status: 200 };
  }
  // The `chatSessions` DOCUMENT id, which every ingest branch returns and the
  // route surfaces as the ONE public `sessionId`. Optional rather than
  // required: the field is not part of the contract the older success-body
  // fixtures assert, and a persist that saved but did not name the row is
  // still a save — the caller reports the id it could not learn as absent
  // rather than failing a committed turn.
  const sessionDocId =
    typeof parsed.sessionId === "string" && parsed.sessionId.length > 0
      ? { sessionDocId: parsed.sessionId }
      : {};
  if (parsed.skipped) {
    // `duplicateTurn` means the backend recognized this exact turn as already
    // applied — a success. A bare `skipped` is the legacy count heuristic
    // deciding the transcript looked like a replay, which may have discarded a
    // real turn; the caller must treat it as a possible loss, not a save.
    return parsed.duplicateTurn
      ? { outcome: "duplicate", version: parsed.version, ...sessionDocId }
      : { outcome: "skipped", version: parsed.version, ...sessionDocId };
  }
  return { outcome: "saved", version: parsed.version, ...sessionDocId };
}

async function attemptChatIngest(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number
): Promise<IngestAttemptResult> {
  // A fresh controller per attempt. Reusing one across retries would poison
  // every later attempt: once aborted, an AbortSignal stays aborted, so retry 1
  // would fail instantly with the timeout that killed retry 0.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body,
    });

    if (response.ok) {
      // The abort signal covers body streaming too, so a slow 2xx body can be
      // cut off by this attempt's timeout. That is a timeout worth retrying —
      // classifying it as a malformed response would burn the one signal that
      // says "try again" on a request that may well have committed.
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (error) {
        if (isAbortError(error)) {
          return { kind: "transient", failureKind: "timeout" };
        }
        parsed = undefined;
      }
      return { kind: "settled", outcome: classifySuccessBody(parsed) };
    }

    if (response.status === 409) {
      let currentVersion: number | undefined;
      let isVersionConflict = false;
      try {
        const json = (await response.clone().json()) as {
          code?: string;
          error?: string;
          currentVersion?: number;
        };
        isVersionConflict =
          json?.error === "VERSION_CONFLICT" ||
          json?.code === "VERSION_CONFLICT";
        currentVersion =
          typeof json?.currentVersion === "number"
            ? json.currentVersion
            : undefined;
      } catch {
        // Fall through to the text probe below.
      }
      const preview = await readResponsePreview(response);
      if (!isVersionConflict) {
        isVersionConflict = preview.includes("VERSION_CONFLICT");
      }
      if (isVersionConflict) {
        return {
          kind: "settled",
          outcome: { outcome: "conflict", currentVersion },
          preview,
        };
      }
      return {
        kind: "settled",
        outcome: {
          outcome: "failed",
          failureKind: "http_error",
          status: response.status,
        },
        preview,
      };
    }

    const preview = await readResponsePreview(response);
    // 5xx is the server having a bad moment; a retry can genuinely succeed.
    // Every other status is a verdict about this request, and repeating it
    // would only burn the deadline.
    if (response.status >= 500) {
      return {
        kind: "transient",
        failureKind: "http_error",
        status: response.status,
        preview,
      };
    }
    return {
      kind: "settled",
      outcome: {
        outcome: "failed",
        failureKind: "http_error",
        status: response.status,
      },
      // A 4xx is the misconfiguration case where the body text is most useful;
      // it was already read above, so dropping it here would waste it.
      preview,
    };
  } catch (error) {
    return {
      kind: "transient",
      failureKind: isAbortError(error) ? "timeout" : "exception",
      ...(error instanceof Error && !isAbortError(error)
        ? { preview: sanitizeDiagnosticText(error.message), error }
        : {}),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function persistChatSessionToConvex(
  options: PersistChatSessionOptions,
  c?: Context
): Promise<PersistChatOutcome> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    return { outcome: "not-attempted", reason: "no-convex-url" };
  }
  if (!options.chatSessionId) {
    return { outcome: "not-attempted", reason: "no-session-id" };
  }
  if (!options.authHeader) {
    return { outcome: "not-attempted", reason: "no-auth" };
  }

  const perAttemptTimeoutMs = options.timeoutMs ?? DEFAULT_INGEST_TIMEOUT_MS;
  const deadline =
    Date.now() + Math.max(perAttemptTimeoutMs, INGEST_TOTAL_BUDGET_MS);
  const ingestHeaders: Record<string, string> = {
    "content-type": "application/json",
    authorization: options.authHeader,
    ...options.forwardHeaders,
  };
  const body = buildIngestBody(options);

  const logFailure = (detail: {
    failureKind: PersistChatFailureKind | "version_conflict";
    status?: number;
    preview?: string;
    error?: Error;
  }) => {
    const { failureKind, status, preview, error } = detail;
    if (c) {
      getRequestLogger(c, "utils.chat-ingestion").event(
        "chat.session.persist.failed",
        {
          failureKind,
          ...(status !== undefined ? { statusCode: status } : {}),
          ...(preview ? { responsePreview: preview } : {}),
          sourceType: options.sourceType,
          origin: options.origin,
        },
        error ? { error } : undefined
      );
      return;
    }
    if (failureKind === "version_conflict") {
      logger.warn("[chat-session-persistence] Chat session version conflict", {
        status,
        responsePreview: preview,
      });
      return;
    }
    if (failureKind === "timeout") {
      logger.warn(
        "[chat-session-persistence] Timed out persisting chat session",
        { timeoutMs: perAttemptTimeoutMs }
      );
      return;
    }
    if (failureKind === "exception") {
      logger.warn("[chat-session-persistence] Error persisting chat session", {
        error: error ? error.message : preview,
      });
      return;
    }
    logger.warn(
      `[chat-session-persistence] Failed to persist chat session${
        status !== undefined ? ` (${status})` : ""
      }${preview ? `: ${preview}` : ""}`,
      { status, responsePreview: preview }
    );
  };

  let lastFailure: {
    failureKind: PersistChatFailureKind;
    status?: number;
    preview?: string;
    error?: Error;
  } = { failureKind: "exception" };

  for (let attempt = 0; ; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    const result = await attemptChatIngest(
      `${convexUrl}/ingest-chat`,
      ingestHeaders,
      body,
      // Truncated rather than allowed to overrun: the caller may be holding a
      // stream open on this promise.
      Math.min(perAttemptTimeoutMs, remainingMs)
    );

    if (result.kind === "settled") {
      const { outcome } = result;
      if (outcome.outcome === "conflict") {
        logFailure({
          failureKind: "version_conflict",
          status: 409,
          preview: result.preview,
        });
      } else if (outcome.outcome === "failed") {
        logFailure({
          failureKind: outcome.failureKind,
          status: outcome.status,
          preview: result.preview,
        });
      } else if (outcome.outcome === "skipped") {
        // Previously invisible: the backend decided this looked like a replay
        // and dropped it, and nobody was told. Its own event so the silent-drop
        // class is measurable rather than inferred.
        if (c) {
          getRequestLogger(c, "utils.chat-ingestion").event(
            "chat.session.persist.skipped",
            {
              sourceType: options.sourceType,
              origin: options.origin,
              hasTurnId: Boolean(options.turnTrace?.turnId),
            }
          );
        } else {
          logger.warn(
            "[chat-session-persistence] Ingest reported the turn as a replay and skipped it"
          );
        }
      }
      return outcome;
    }

    // Keep the first attempt's diagnostics when a later one has none — a
    // retry that dies before reading a body would otherwise erase the only
    // description of what went wrong.
    lastFailure = {
      failureKind: result.failureKind,
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.preview ?? lastFailure.preview
        ? { preview: result.preview ?? lastFailure.preview }
        : {}),
      ...(result.error ?? lastFailure.error
        ? { error: result.error ?? lastFailure.error }
        : {}),
    };

    const backoffMs = INGEST_RETRY_DELAYS_MS[attempt];
    if (backoffMs === undefined) break;
    if (Date.now() + backoffMs >= deadline) break;
    await sleep(backoffMs);
  }

  logFailure(lastFailure);
  return {
    outcome: "failed",
    failureKind: lastFailure.failureKind,
    ...(lastFailure.status !== undefined ? { status: lastFailure.status } : {}),
  };
}

/**
 * A writer that can carry a receipt. Structurally the RAW `createUIMessageStream`
 * writer — deliberately not the handlers' `safeWriter` wrappers, which are
 * flagged closed once the engine finishes and would swallow the part.
 */
type PersistReceiptWriter = { write: (chunk: UIMessageChunk) => void };

/**
 * Translate a persist outcome into the wire shape the client consumes.
 *
 * `not-attempted` returns null: nothing was tried, so there is nothing to
 * report, and emitting a receipt would make a client believe a save was
 * evaluated when it never happened.
 */
export function buildPersistReceiptData(
  outcome: PersistChatOutcome,
  context: { chatSessionId: string; turnId?: string }
): PersistReceiptData | null {
  if (outcome.outcome === "not-attempted") {
    return null;
  }
  const base = {
    chatSessionId: context.chatSessionId,
    ...(context.turnId ? { turnId: context.turnId } : {}),
  };
  switch (outcome.outcome) {
    case "saved":
    case "duplicate":
      return { outcome: outcome.outcome, ...base, version: outcome.version };
    case "skipped":
      return {
        outcome: "skipped",
        ...base,
        ...(outcome.version !== undefined ? { version: outcome.version } : {}),
      };
    case "conflict":
      return {
        outcome: "conflict",
        ...base,
        ...(outcome.currentVersion !== undefined
          ? { currentVersion: outcome.currentVersion }
          : {}),
      };
    case "failed":
      return {
        outcome: "failed",
        ...base,
        failureKind: outcome.failureKind,
      };
  }
}

/**
 * Emit the persist receipt on a ui-sink rail.
 *
 * Adds no latency: the persist already gates the stream close on every live
 * rail, so by the time this runs the answer is known and the stream is still
 * open. Failures here are swallowed — an errored or already-closed stream must
 * not turn finalization into a rejected promise, and a missing receipt degrades
 * to the client's subscription-based fallback rather than breaking the turn.
 */
export function writePersistReceipt(
  writer: PersistReceiptWriter | undefined,
  outcome: PersistChatOutcome,
  context: { chatSessionId: string; turnId?: string }
): void {
  if (!writer) return;
  const data = buildPersistReceiptData(outcome, context);
  if (!data) return;
  try {
    writer.write({
      type: PERSIST_RECEIPT_PART_TYPE,
      data,
      transient: true,
    } as unknown as UIMessageChunk);
  } catch (error) {
    logger.warn("[chat-session-persistence] Failed to emit persist receipt", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
