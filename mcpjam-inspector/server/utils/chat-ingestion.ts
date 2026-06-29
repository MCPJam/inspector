import type { Context } from "hono";
import type {
  McpToolResultImageRenderingPolicy,
  ModelVisibleMcpToolResults,
} from "@mcpjam/sdk/host-config/internal";
import { logger } from "./logger";
import { getRequestLogger } from "./request-logger";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { LiveChatTraceUsage } from "@/shared/live-chat-trace";

const DEFAULT_INGEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_PREVIEW_CHARS = 200;

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

interface ResumeConfig {
  systemPrompt?: string;
  temperature?: number;
  requireToolApproval?: boolean;
  respectToolVisibility?: boolean;
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
  selectedServers?: string[];
}

/**
 * Direct-chat host configuration sent alongside the transcript so the backend
 * can dedupe per-turn config into `hostConfigs`. Mirrors the `HostConfigPayload`
 * shape accepted by the Convex `/ingest-chat` route. Only emitted for direct
 * chats (serverShare and chatbox flows skip it).
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
}

// Mirrors mcpjam-backend `chatOriginValidator`. Required at every writer
// boundary so a new surface can't be added without explicitly choosing one.
// Backend still accepts undefined for historical-row compatibility; the
// inspector pins to the closed set.
export type ChatOrigin = "playground" | "mcpjam_agent" | "chatbox" | "eval";

interface PersistChatSessionOptions {
  chatSessionId: string;
  modelId: string;
  modelSource: "mcpjam" | "byok" | "local_byok";
  authHeader?: string;
  projectId?: string;
  sourceType?: "chatbox" | "direct" | "eval";
  origin: ChatOrigin;
  directVisibility?: "private" | "project";
  surface?: "preview" | "share_link";
  chatboxId?: string;
  accessVersion?: number;
  serverId?: string;
  visitorDisplayName?: string;
  sessionMessages?: unknown[];
  messages?: unknown[];
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
  turnTrace?: PersistedTurnTrace;
  /**
   * §3: chat-backed Claude Code harness resume-state commit. Applied ATOMICALLY
   * with the transcript inside the ingest mutation (a failed sidecar commit
   * rolls back the transcript write). Opaque pass-through.
   */
  harnessSessionCommit?: {
    ownerType: "direct-chat" | "chatbox-chat";
    chatSessionId: string;
    chatboxId?: string;
    leaseId: string;
    expectedStateVersion: number;
    harnessId: "claude-code";
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
   * `chatboxSynthesisRuns` parent for progress polling.
   */
  synthetic?: boolean;
  personaId?: string;
  personaLabel?: string;
  /** Durable roster row id; stamped onto `chatSessions.personaRefId`. */
  personaRefId?: string;
  synthesisRunId?: string;
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

export async function persistChatSessionToConvex(
  options: PersistChatSessionOptions,
  c?: Context
): Promise<void> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl || !options.chatSessionId) {
    return;
  }
  if (!options.authHeader) return;

  const timeoutMs = options.timeoutMs ?? DEFAULT_INGEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const ingestHeaders: Record<string, string> = {
    "content-type": "application/json",
    authorization: options.authHeader,
    ...options.forwardHeaders,
  };

  try {
    const response = await fetch(`${convexUrl}/ingest-chat`, {
      method: "POST",
      headers: ingestHeaders,
      signal: controller.signal,
      body: JSON.stringify({
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
        ...(options.chatboxId ? { chatboxId: options.chatboxId } : {}),
        ...(options.chatboxId && Number.isFinite(options.accessVersion)
          ? { accessVersion: options.accessVersion }
          : {}),
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
        ...(options.assistantText
          ? { assistantText: options.assistantText }
          : {}),
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
        ...(options.synthesisRunId
          ? { synthesisRunId: options.synthesisRunId }
          : {}),
      }),
    });

    if (!response.ok) {
      const responsePreview = await readResponsePreview(response);
      const isVersionConflict =
        response.status === 409 &&
        (response.headers.get("content-type")?.includes("application/json")
          ? false
          : responsePreview.includes("VERSION_CONFLICT"));
      let failureKind: "version_conflict" | "http_error" = "http_error";

      if (response.status === 409) {
        let jsonCode: string | undefined;
        try {
          const cloned = response.clone();
          const json = (await cloned.json()) as { code?: string };
          jsonCode = json?.code;
        } catch {
          // ignored — use text fallback
        }
        if (
          jsonCode === "VERSION_CONFLICT" ||
          isVersionConflict ||
          responsePreview.includes("VERSION_CONFLICT")
        ) {
          failureKind = "version_conflict";
        }
      }

      if (c) {
        const reqLogger = getRequestLogger(c, "utils.chat-ingestion");
        reqLogger.event("chat.session.persist.failed", {
          failureKind,
          statusCode: response.status,
          sourceType: options.sourceType,
          origin: options.origin,
        });
      } else {
        const logMessage =
          failureKind === "version_conflict"
            ? "[chat-session-persistence] Chat session version conflict"
            : `[chat-session-persistence] Failed to persist chat session (${response.status}): ${responsePreview}`;
        logger.warn(logMessage, { status: response.status, responsePreview });
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
      if (c) {
        const reqLogger = getRequestLogger(c, "utils.chat-ingestion");
        reqLogger.event("chat.session.persist.failed", {
          failureKind: "timeout",
          sourceType: options.sourceType,
          origin: options.origin,
        });
      } else {
        logger.warn(
          "[chat-session-persistence] Timed out persisting chat session",
          { timeoutMs }
        );
      }
      return;
    }

    if (c) {
      const reqLogger = getRequestLogger(c, "utils.chat-ingestion");
      reqLogger.event(
        "chat.session.persist.failed",
        {
          failureKind: "exception",
          sourceType: options.sourceType,
          origin: options.origin,
        },
        { error: error instanceof Error ? error : undefined }
      );
    } else {
      logger.warn("[chat-session-persistence] Error persisting chat session", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    clearTimeout(timeoutId);
  }
}
