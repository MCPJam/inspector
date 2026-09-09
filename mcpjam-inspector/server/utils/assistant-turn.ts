/**
 * Assistant turn engine (Stage 1 of horizontally-safe synthetic scenario
 * sessions — see plan v3 §A "engine extraction").
 *
 * `runAssistantTurn` is the shared assistant-turn driver for both the live
 * chat path (`/api/web/chat-v2`, `/api/mcp/chat-v2`) and the upcoming
 * synthetic-chat runner. It owns the Convex `/stream` + local-tool
 * execution loop now implemented as the streamSink-aware
 * {@link runChatEngineLoop} primitive.
 *
 * After Stage 1.1, the engine no longer lives inside
 * `handleMCPJamFreeChatModel`: that function is a thin Response-returning
 * wrapper around the same `runChatEngineLoop` that `runAssistantTurn`
 * calls. The synthetic-runner path (`streamSink: "none"`) runs the
 * agent loop inline against a no-op writer — it does NOT build a
 * `Response` and drain it. The transcript flows back via the captured
 * `messageHistory` and the engine's `onConversationComplete` tap.
 */
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type {
  AssistantModelMessage,
  ToolModelMessage,
  ToolSet,
  UIMessageChunk,
} from "ai";
import type { MCPClientManager, Harness } from "@mcpjam/sdk";
import type { ModelVisibleMcpToolResults } from "@mcpjam/sdk/host-config/internal";
import type { ModelDefinition } from "@/shared/types";
import { isHostedCatalogModel } from "../services/hosted-model-catalog.js";
import type { LiveChatTraceUsage } from "@/shared/live-chat-trace";
import type {
  ProgressiveToolPlan,
  ToolDiscoveryState,
} from "@/shared/progressive-tool-discovery";
import {
  runChatEngineLoop,
  type MCPJamHandlerOptions,
} from "./mcpjam-stream-handler.js";
import type { ChatOrigin, PersistedTurnTrace } from "./chat-ingestion.js";
import { runHarnessTurn } from "./harness/run-harness-turn.js";
import { getHarnessAdapter } from "./harness/registry.js";
import {
  externalAccountHostModelRefusalReason,
  harnessModelEligibleForRuntime,
} from "./harness/harness-availability.js";
import type { HarnessSessionCommitPayload } from "./harness/harness-session-state.js";
import { logger } from "./logger.js";

/**
 * Authentication context for `runAssistantTurn`.
 *
 * The caller forwards the inbound `authorization` header from the browser
 * request directly to Convex. `clientIp` is the originating IP for the
 * per-IP guest spend cap (see `mcpjam-stream-handler.ts` doc on `clientIp`).
 */
export type RunAssistantTurnAuthContext = {
  kind: "user_bearer";
  /** Full `authorization` header value, e.g. `"Bearer …"`. */
  token: string;
  /** Originating client IP for the per-IP guest spend cap. */
  clientIp?: string | null;
};

/** Where streamed chunks go. */
export type RunAssistantTurnStreamSink = "ui" | "none";

/** Whether `runAssistantTurn` runs the chat-ingestion path itself. */
export type RunAssistantTurnPersistMode = "handler" | "caller";

export interface RunAssistantTurnOptions {
  messages: ModelMessage[];
  projectId?: string;
  scenarioId?: string;
  accessVersion?: number;

  modelDefinition: ModelDefinition;
  systemPrompt: string;
  temperature?: number;

  selectedServerIds?: string[];
  /**
   * Optional display names for the selected servers. Reserved for the
   * upcoming synthetic runner adapter so a generated `chatSessions.row`
   * can resolve `serverIds → serverNames` without re-querying the
   * manager. Stage 1 does not consume this; persist when present.
   */
  selectedServerNames?: string[];

  mcpClientManager: MCPClientManager;

  authContext: RunAssistantTurnAuthContext;

  /**
   * Source-of-traffic marker forwarded into chat-ingestion. Mirrors
   * the existing `MCPJamHandlerOptions.sourceType` union but kept
   * narrowed to the public values to avoid silent string churn.
   */
  sourceType: "direct" | "scenario" | "eval" | "swarm";
  /**
   * Product-surface discriminator forwarded into chat-ingestion. Required
   * so each caller (eval runner, session simulation, MCP route) explicitly
   * picks the surface — see `ChatOrigin` in `chat-ingestion.ts`.
   */
  origin: ChatOrigin;
  /**
   * Surface marker forwarded into chat-ingestion. Stage 1 only wires
   * the type-narrow union; existing callers still send the string
   * verbatim into `persistChatSessionToConvex`.
   */
  surface?: "preview" | "share_link";

  /** See `PrepareChatV2Options.approvalMode`. Default `"prompt"`. */
  approvalMode?: "prompt" | "auto-deny";
  /**
   * Required-tool-approval policy on the underlying engine. Forwarded
   * verbatim to `handleMCPJamFreeChatModel` so the dispatch-time
   * approval gate at mcpjam-stream-handler.ts:834–843 fires when set.
   */
  requireToolApproval?: boolean;
  /** Host/client policy for eligible MCP tool-result content/resources. */
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  /**
   * Host-level SEP-1865 `_meta.ui.visibility` switch, forwarded to the HARNESS
   * engine only (`MCPJamHandlerOptions.respectToolVisibility` is read by
   * `runHarnessTurn` and by nothing else — the emulated engine consumes the
   * tool set `prepareChatV2` already built under this same policy).
   *
   * Exposed here because a harness turn REBUILDS its MCP tool set from the
   * manager (`projectSelectedMcpServersAsHostTools`). A caller that omits this
   * does not get "the host's default" — it gets the SDK's, which is how an
   * explicit visibility opt-out came to be ignored on host-executed delivery.
   * Only an explicit `false` opts out; `undefined`/`true` filter (spec default).
   */
  respectToolVisibility?: MCPJamHandlerOptions["respectToolVisibility"];
  /**
   * Resolved MCP Tasks seam for this turn, forwarded to the HARNESS engine only
   * (same read-site rule as `respectToolVisibility` above).
   *
   * The MODE is resolved by the CALLER — each surface owns its own row in the
   * policy matrix (`task-seam.ts`) — and is never re-derived downstream.
   * Absent keeps a harness turn on the pre-existing no-`_meta` path,
   * byte-for-byte; dropping it on a surface whose host DID enable tasks
   * silently degrades that surface to the same path with no way to notice.
   */
  tasks?: MCPJamHandlerOptions["tasks"];

  /**
   * Which real agent harness runs this turn. Absent ⇒ MCPJam's emulated engine
   * ({@link runChatEngineLoop}). `"claude-code"` ⇒ the real Claude Code runtime
   * via {@link runHarnessTurn} (requires the host's computer). Sourced from the
   * resolved host config's `harness` field.
   */
  harness?: Harness;

  streamSink: RunAssistantTurnStreamSink;
  persistMode: RunAssistantTurnPersistMode;

  // --- The fields below are pass-throughs to `handleMCPJamFreeChatModel`
  //     that the live-chat callers already supply today. Exposed here so
  //     a thin wrapper can forward them without losing behavior. ---

  /** Pre-built advertised tool set (output of `prepareChatV2`). */
  tools: ToolSet;
  chatSessionId?: string;
  progressivePlan?: ProgressiveToolPlan;
  discoveryState?: ToolDiscoveryState;
  abortSignal?: AbortSignal;
  heartbeatIntervalMs?: number;
  maxSteps?: number;

  /**
   * Callback invoked when the chat-ingestion handler path runs. Only
   * consumed when `persistMode === "handler"`; ignored when
   * `persistMode === "caller"` (the caller is responsible for writing
   * its own `chatSessions` row using the returned transcript).
   */
  onConversationComplete?: MCPJamHandlerOptions["onConversationComplete"];
  /** Optional stream-cleanup hook (e.g. MCPClientManager teardown). */
  onStreamComplete?: MCPJamHandlerOptions["onStreamComplete"];
  onStreamWriterReady?: MCPJamHandlerOptions["onStreamWriterReady"];
  onLiveTextDelta?: MCPJamHandlerOptions["onLiveTextDelta"];
  /**
   * PR 5b-pre: chunk-level + step-level callbacks. Pass-throughs to
   * `MCPJamHandlerOptions`. Eval's PR 5b backend stream runner uses
   * these to emit SSE events from engine signals; chat / synthetic
   * omit. See `MCPJamHandlerOptions.onToolCall` etc. for shape +
   * timing.
   */
  onToolCall?: MCPJamHandlerOptions["onToolCall"];
  onToolResult?: MCPJamHandlerOptions["onToolResult"];
  onStepFinish?: MCPJamHandlerOptions["onStepFinish"];
  /**
   * PR 5b-followup-2: structured-error pass-through. Eval's backend
   * stream runner uses this to surface guardrail detail (429
   * daily-cap, hosted-model setup errors, etc.) on its `error` SSE
   * event — `streamSink: "none"` consumers don't otherwise see the
   * structured Convex `/stream` response body because the writer-side
   * `error` chunk goes to the no-op writer. Chat / synthetic omit.
   */
  onEngineError?: MCPJamHandlerOptions["onEngineError"];

  /**
   * Typed mid-stream failure telemetry pass-through. Callers with a request
   * context pass a request-scoped reporter; when omitted, the engine's
   * system-reporter fallback applies (requestId: null on the emitted rows).
   */
  failureReporter?: MCPJamHandlerOptions["failureReporter"];

  /**
   * Browser-rendered MCP App eval PR 2: per-step advertised-tool narrowing
   * pass-through. The eval runner uses this to hide `computer` /
   * `finish_widget` until a widget has rendered. Chat / synthetic omit.
   */
  prepareAdvertisedTools?: MCPJamHandlerOptions["prepareAdvertisedTools"];

  /**
   * Harness MCP-proxy plane strategy — how a harness turn's cloud sandbox
   * reaches THIS inspector's MCP servers. `runHarnessTurn` REQUIRES it whenever
   * a harness host has selected MCP servers (it throws otherwise). The live-chat
   * routes set it directly on their handler options; eval/synthetic drive the
   * harness through this facade, so it must be a pass-through here too. Emulated
   * turns and harness turns with no MCP servers ignore it.
   */
  harnessMcpProxy?: MCPJamHandlerOptions["harnessMcpProxy"];

  /**
   * Resolved per-server `toolPolicy` decisions and the sink for the calls the
   * MCP proxy refuses. Eval drives the harness through this facade, so both
   * must be pass-throughs; every other caller omits them and keeps today's
   * unpoliced path.
   */
  harnessToolPolicy?: MCPJamHandlerOptions["harnessToolPolicy"];
  /**
   * The eval iteration this turn executes, when there is one. Threaded through
   * to the harness turn, where it becomes the authorized claim on the proxy
   * tokens that lets firsthand tool-call evidence be recorded.
   */
  evalIterationId?: MCPJamHandlerOptions["evalIterationId"];
  /** Reports back what the run FROZE about evidence, as the mint saw it. */
  onHarnessEvidenceDecision?: MCPJamHandlerOptions["onHarnessEvidenceDecision"];
  onHarnessPolicyBlocks?: MCPJamHandlerOptions["onHarnessPolicyBlocks"];

  /**
   * Swarm (journey-execution) continuity identity. Forwarded to the harness
   * turn so a swarm harness session claims/commits the `swarm-chat` owner lane
   * (keyed on `journeyRunId` + `hostId` + `chatSessionId`) instead of misfiling
   * under `direct-chat`. Set only by the swarm runner; other callers omit both.
   */
  journeyRunId?: MCPJamHandlerOptions["journeyRunId"];
  hostId?: MCPJamHandlerOptions["hostId"];

  /**
   * Pinned harness skills for env-based swarm targets (Project Environments).
   * Pass-through to `runHarnessTurn`: when set (even empty) the harness turn
   * skips the live skills fetch and delivers exactly these pinned artifacts.
   */
  pinnedHarnessSkills?: MCPJamHandlerOptions["pinnedHarnessSkills"];

  /**
   * The disposable box this session already owns (B-isolation phase 6).
   * Pass-through to `runHarnessTurn`: present ⇒ the harness runs on THAT box
   * instead of reserving the acting member's personal computer. Set only by
   * the swarm runner, per attempt; every other caller omits it and keeps the
   * personal path unchanged.
   */
  harnessSandboxBinding?: MCPJamHandlerOptions["harnessSandboxBinding"];

  /**
   * MCPJam's SERVER-EXECUTED built-ins (`web_search`, …) for the harness path.
   *
   * Separate from `tools`: the harness forwards these to the runtime as tool
   * specs and runs their `execute()` on MCPJam's server when the runtime calls
   * one, whereas MCP-server tools reach the runtime through `.mcp.json`
   * instead. `runHarnessTurn` reads them off `builtInTools`, so a caller that
   * only sets `tools` silently gives a harness turn no built-ins at all.
   */
  builtInTools?: MCPJamHandlerOptions["builtInTools"];

  /**
   * Resolved Project-Environment skills for this turn (Phase 1.4).
   * Pass-through to `runHarnessTurn`: when set (even empty) the harness turn
   * delivers exactly these and skips the live project-wide fetch. Ranks below
   * `pinnedHarnessSkills` — see `harness/skill-delivery.ts`.
   */
  runtimeSkillsOverride?: MCPJamHandlerOptions["runtimeSkillsOverride"];

  /**
   * The Project Environment this turn resolved — the GRANT BOUNDARY for project
   * secrets. Pass-through to `runHarnessTurn`, which needs it to answer whether
   * a BROKERED credential is actually granted to this run's box: the backend
   * composes a box's egress transform from the environment's `secretSelection`,
   * so a project-wide answer would report a secret the box never receives.
   *
   * An id, never a resolved spec carrying values — see the option's docblock on
   * `MCPJamHandlerOptions`. Absent ⇒ no grant, which is a normal state and not
   * a failure.
   */
  environmentId?: MCPJamHandlerOptions["environmentId"];

  /**
   * Why `environmentId` is absent on a run that HAS one (eval replay). Copy
   * only — see the option's docblock on `MCPJamHandlerOptions`.
   */
  environmentUnresolvedReason?: MCPJamHandlerOptions["environmentUnresolvedReason"];

  /**
   * Override the Convex endpoint path. Stage 1 keeps this wired so
   * `handleHostedOrgChatModel` (org BYOK delegation chain) keeps
   * working — `runAssistantTurn` is the same engine, and the org BYOK
   * path needs `/stream/org` + `extraBodyFields: { providerKey }`.
   */
  endpointPath?: string;
  extraHeaders?: Record<string, string>;
  extraBodyFields?: Record<string, unknown>;
}

/**
 * Outputs of a completed assistant turn.
 *
 * - `messages` is the full conversation history (input + assistant
 *   responses + tool results) — same shape passed to
 *   `onConversationComplete`.
 * - `assistantMessages`, `toolCalls`, `toolResults` are pre-extracted
 *   views over `messages` for synthetic-runner convenience; live-chat
 *   callers can ignore them.
 * - `response` is populated only when `streamSink === "ui"`; the
 *   wrapper returns it back to Hono as the SSE response.
 */
export interface RunAssistantTurnResult {
  messages: ModelMessage[];
  assistantMessages: AssistantModelMessage[];
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
  }>;
  toolResults: Array<{
    toolCallId: string;
    toolName?: string;
    output: unknown;
  }>;
  turnTrace?: PersistedTurnTrace;
  usage?: LiveChatTraceUsage;
  finishReason?: string;
  /** Set only for `streamSink: "ui"`. */
  response?: Response;
  /**
   * §3 harness resume-state commit produced by a successful harness turn (the
   * 3rd `onConversationComplete` arg). Present only for a continuity-backed
   * harness turn; the emulated engine and non-continuity harness turns leave it
   * undefined. A `persistMode: "caller"` consumer (the synthetic/swarm runner)
   * MUST forward this into its own `persistChatSessionToConvex` call so the
   * resume-state rides `/ingest-chat` atomically with the transcript — otherwise
   * the harness lease is never committed/released and the next turn 409s.
   */
  harnessSessionCommit?: HarnessSessionCommitPayload;
}

function extractAssistantMessages(
  messages: ModelMessage[],
): AssistantModelMessage[] {
  const out: AssistantModelMessage[] = [];
  for (const msg of messages) {
    if (msg?.role === "assistant") {
      out.push(msg as AssistantModelMessage);
    }
  }
  return out;
}

function extractToolCalls(
  messages: ModelMessage[],
): RunAssistantTurnResult["toolCalls"] {
  const out: RunAssistantTurnResult["toolCalls"] = [];
  for (const msg of messages) {
    if (msg?.role !== "assistant") continue;
    const content = (msg as AssistantModelMessage).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type === "tool-call") {
        out.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        });
      }
    }
  }
  return out;
}

function extractToolResults(
  messages: ModelMessage[],
): RunAssistantTurnResult["toolResults"] {
  const out: RunAssistantTurnResult["toolResults"] = [];
  for (const msg of messages) {
    if (msg?.role !== "tool") continue;
    for (const part of (msg as ToolModelMessage).content) {
      if (part.type === "tool-result") {
        out.push({
          toolCallId: part.toolCallId,
          toolName: (part as { toolName?: string }).toolName,
          output: part.output,
        });
      }
    }
  }
  return out;
}

/**
 * Build the `extraBodyFields` payload forwarded to the Convex `/stream`
 * request. (The synthesis attribution keys this used to append were removed
 * with the scenario synthetic surface.)
 */
function buildExtraBodyFields(
  opts: RunAssistantTurnOptions,
): Record<string, unknown> | undefined {
  const base = { ...(opts.extraBodyFields ?? {}) };
  return Object.keys(base).length > 0 ? base : undefined;
}

/**
 * Translate `RunAssistantTurnOptions` into the underlying
 * `MCPJamHandlerOptions` shape. Wraps `onConversationComplete` so the
 * `runAssistantTurn` caller (or the result object) always sees the
 * final transcript even when `persistMode: "caller"` suppresses the
 * handler-side persistence.
 */
function buildHandlerOptions(
  opts: RunAssistantTurnOptions,
  captureTranscript: (
    messages: ModelMessage[],
    turnTrace: PersistedTurnTrace,
    harnessSessionCommit?: HarnessSessionCommitPayload,
  ) => void,
): MCPJamHandlerOptions {
  const wrappedOnConversationComplete: MCPJamHandlerOptions["onConversationComplete"] =
    async (fullHistory, turnTrace, harnessSessionCommit) => {
      // Capture the harness resume-state commit (3rd arg) alongside the
      // transcript so a `persistMode: "caller"` consumer can forward it into its
      // own ingest. Dropping it here (the old behavior) silently stranded the
      // harness lease for every synthetic/swarm harness turn.
      captureTranscript(fullHistory, turnTrace, harnessSessionCommit);
      if (
        opts.persistMode === "handler" &&
        typeof opts.onConversationComplete === "function"
      ) {
        // RETURNED, not just awaited. The engine reads this to decide whether
        // the turn was actually saved — it emits the persist receipt from it,
        // and the harness releases its session lease when it is not a success.
        // Swallowing it here would make `undefined` mean both "this caller
        // reports nothing" and "the outcome was dropped in transit", and the
        // engine reads the first meaning: a failed ingest would look saved.
        return await opts.onConversationComplete(
          fullHistory,
          turnTrace,
          harnessSessionCommit,
        );
      }
      return undefined;
    };

  const handlerOptions: MCPJamHandlerOptions = {
    messages: opts.messages,
    modelId: String(opts.modelDefinition.id),
    provider: opts.modelDefinition.provider,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    mcpClientManager: opts.mcpClientManager,
    authHeader: opts.authContext.token,
    ...(opts.temperature !== undefined
      ? { temperature: opts.temperature }
      : {}),
    ...(opts.scenarioId ? { scenarioId: opts.scenarioId } : {}),
    ...(opts.accessVersion !== undefined
      ? { accessVersion: opts.accessVersion }
      : {}),
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.chatSessionId ? { chatSessionId: opts.chatSessionId } : {}),
    ...(opts.sourceType ? { sourceType: opts.sourceType } : {}),
    ...(opts.selectedServerIds
      ? { selectedServers: opts.selectedServerIds }
      : {}),
    // Carry the harness selector through to the handler — runHarnessTurn reads it
    // off MCPJamHandlerOptions and now REQUIRES it. Without this, eval/synthetic/
    // unified harness turns reach runHarnessTurn with harness=undefined (the old
    // `?? "claude-code"` default silently mis-ran a codex eval as claude-code).
    ...(opts.harness ? { harness: opts.harness } : {}),
    // Harness MCP-proxy plane + swarm continuity identity: pass-throughs so an
    // eval/synthetic harness turn driven through this facade can (a) reach MCP
    // (runHarnessTurn REQUIRES harnessMcpProxy when servers are selected) and
    // (b) claim the correct owner lane (`swarm-chat` for swarm).
    ...(opts.harnessMcpProxy ? { harnessMcpProxy: opts.harnessMcpProxy } : {}),
    ...(opts.evalIterationId ? { evalIterationId: opts.evalIterationId } : {}),
    ...(opts.onHarnessEvidenceDecision
      ? { onHarnessEvidenceDecision: opts.onHarnessEvidenceDecision }
      : {}),
    ...(opts.harnessToolPolicy
      ? { harnessToolPolicy: opts.harnessToolPolicy }
      : {}),
    ...(opts.onHarnessPolicyBlocks
      ? { onHarnessPolicyBlocks: opts.onHarnessPolicyBlocks }
      : {}),
    ...(opts.journeyRunId ? { journeyRunId: opts.journeyRunId } : {}),
    ...(opts.hostId ? { hostId: opts.hostId } : {}),
    // Pinned harness skills: presence (even an EMPTY array) is semantic — an
    // empty authoritative set means "run skill-less", never "fall back live".
    ...(opts.pinnedHarnessSkills !== undefined
      ? { pinnedHarnessSkills: opts.pinnedHarnessSkills }
      : {}),
    // The attempt's own disposable box. Absent ⇒ the harness reserves the
    // personal computer, exactly as before.
    ...(opts.harnessSandboxBinding
      ? { harnessSandboxBinding: opts.harnessSandboxBinding }
      : {}),
    // Server-executed built-ins forwarded SEPARATELY so the harness path can
    // hand them to HarnessAgent (mirrors `routes/mcp/chat-v2.ts`).
    ...(opts.builtInTools ? { builtInTools: opts.builtInTools } : {}),
    // Environment skill override: same presence-is-semantic rule as pinned —
    // an empty resolved set means "this environment delivers no skills", never
    // "fall back to the project pool".
    ...(opts.runtimeSkillsOverride !== undefined
      ? { runtimeSkillsOverride: opts.runtimeSkillsOverride }
      : {}),
    // The turn's grant boundary for project secrets. Harness-relevant: the
    // external-account credential check asks whether a BROKERED secret is
    // selected into THIS environment, and an absent id means "no grant" rather
    // than "ask the project".
    ...(opts.environmentId ? { environmentId: opts.environmentId } : {}),
    ...(opts.environmentUnresolvedReason
      ? { environmentUnresolvedReason: opts.environmentUnresolvedReason }
      : {}),
    ...(opts.requireToolApproval !== undefined
      ? { requireToolApproval: opts.requireToolApproval }
      : {}),
    ...(opts.modelVisibleMcpToolResults !== undefined
      ? { modelVisibleMcpToolResults: opts.modelVisibleMcpToolResults }
      : {}),
    // Harness-only tool-CONSTRUCTION inputs (see the option docblocks). Both
    // are forwarded on DEFINEDNESS, not truthiness: `respectToolVisibility:
    // false` IS the opt-out, and would vanish under a truthy check.
    ...(opts.respectToolVisibility !== undefined
      ? { respectToolVisibility: opts.respectToolVisibility }
      : {}),
    ...(opts.tasks !== undefined ? { tasks: opts.tasks } : {}),
    ...(opts.approvalMode !== undefined
      ? { approvalMode: opts.approvalMode }
      : {}),
    onConversationComplete: wrappedOnConversationComplete,
    ...(opts.onStreamComplete
      ? { onStreamComplete: opts.onStreamComplete }
      : {}),
    ...(opts.onStreamWriterReady
      ? { onStreamWriterReady: opts.onStreamWriterReady }
      : {}),
    ...(opts.onLiveTextDelta ? { onLiveTextDelta: opts.onLiveTextDelta } : {}),
    // PR 5b-pre: pass-through chunk-level + step-level callbacks.
    ...(opts.onToolCall ? { onToolCall: opts.onToolCall } : {}),
    ...(opts.onToolResult ? { onToolResult: opts.onToolResult } : {}),
    ...(opts.onStepFinish ? { onStepFinish: opts.onStepFinish } : {}),
    // PR 5b-followup-2: pass-through structured-error callback.
    ...(opts.onEngineError ? { onEngineError: opts.onEngineError } : {}),
    ...(opts.failureReporter ? { failureReporter: opts.failureReporter } : {}),
    // Browser-rendered MCP App eval PR 2: advertised-tool narrowing hook.
    ...(opts.prepareAdvertisedTools
      ? { prepareAdvertisedTools: opts.prepareAdvertisedTools }
      : {}),
    ...(opts.endpointPath ? { endpointPath: opts.endpointPath } : {}),
    ...(opts.extraHeaders ? { extraHeaders: opts.extraHeaders } : {}),
    ...(opts.authContext.clientIp !== undefined &&
    opts.authContext.clientIp !== null
      ? { clientIp: opts.authContext.clientIp }
      : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(opts.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: opts.heartbeatIntervalMs }
      : {}),
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.progressivePlan ? { progressivePlan: opts.progressivePlan } : {}),
    ...(opts.discoveryState ? { discoveryState: opts.discoveryState } : {}),
  };

  const extraBodyFields = buildExtraBodyFields(opts);
  if (extraBodyFields) {
    handlerOptions.extraBodyFields = extraBodyFields;
  }
  return handlerOptions;
}

/**
 * Run a single assistant turn against an MCPJam-provided model.
 *
 * Calls {@link runChatEngineLoop} directly — no intermediate
 * `Response`-draining facade. Behavior by stream sink:
 *
 * - `streamSink: "ui"`: the engine builds an SSE Response identical to
 *   the live `/stream` path. `RunAssistantTurnResult.response` is
 *   populated. The transcript is delivered to the caller's
 *   `onConversationComplete` (when `persistMode: "handler"`) via the
 *   engine's `onFinish` once the caller drains the Response body, NOT
 *   via the synchronous return value. `messages` on the result
 *   reflects the in-flight `messageHistory` reference the engine
 *   mutates, so callers that await the response stream see the final
 *   transcript through it; callers that need a pre-drain snapshot
 *   should consume via `onConversationComplete`.
 *
 * - `streamSink: "none"`: the engine runs inline against a no-op
 *   writer. The agent loop, trace persistence, and the
 *   `onConversationComplete` tap all complete BEFORE
 *   `runChatEngineLoop` returns. `messages` is the populated
 *   `messageHistory` from the engine (NOT a fallback to the input).
 */
export async function runAssistantTurn(
  opts: RunAssistantTurnOptions,
): Promise<RunAssistantTurnResult> {
  let capturedMessages: ModelMessage[] | undefined;
  let capturedTrace: PersistedTurnTrace | undefined;
  let capturedHarnessCommit: HarnessSessionCommitPayload | undefined;

  const handlerOptions = buildHandlerOptions(
    opts,
    (fullHistory, turnTrace, harnessSessionCommit) => {
      capturedMessages = fullHistory;
      capturedTrace = turnTrace;
      capturedHarnessCommit = harnessSessionCommit;
    },
  );

  // A host with a `harness` selected (claude-code | codex) runs the real runtime
  // inside its computer; otherwise the emulated engine. Both satisfy the same
  // ChatEngineLoopResult contract, so everything downstream is identical.
  //
  // Harness is MCPJam-model-only: runHarnessTurn authenticates the model via the
  // deploy/Convex MCPJam credential path, NOT the caller's org-BYOK provider key
  // (it ignores endpointPath / extraBodyFields). Running a BYOK turn through it
  // would use the wrong credentials and mis-account spend, so for BYOK models we
  // fall back to the emulated engine (which honors the org-BYOK path).
  //
  // The interactive web path fails closed at the chat-v2 preflight when a harness
  // host's model is ineligible. This gate is the authoritative one for
  // eval/synthetic (which forward `harness` unconditionally and shouldn't hard-
  // fail a batch): when a harness was requested but the model isn't eligible, we
  // SURFACE the fallback (not a silent emulated swap) so it's visible in logs/
  // traces rather than misread as "observed the real harness".
  const harnessRequested = !!opts.harness;
  const harnessModelId = String(opts.modelDefinition.id);
  // Eligibility is BOTH "MCPJam-provided" AND "the runtime can actually run this
  // model". The interactive routes check supportsModel in their preflight, but
  // eval/synthetic don't — without this a codex turn on an MCPJam-provided but
  // non-Codex model (e.g. anthropic/claude-haiku-4.5) would reach createCodex()
  // with no native model and silently use Codex's default. Mirror the preflight.
  const harnessAdapter = harnessRequested
    ? getHarnessAdapter(opts.harness as string)
    : undefined;
  // Asked of the shared helper rather than spelled out here, because this
  // decision has to match the pre-flight's exactly: a dispatch that says "not
  // eligible" where the pre-flight said "available" does not error — it runs
  // the EMULATED engine and reports the harness's name over it. That is a wrong
  // answer attributed to the wrong runtime, which is worse than a failure.
  //
  // The helper also carries the external-account arm: Cursor's host seeds a
  // `cursor/auto` sentinel that is deliberately not an MCPJam-hosted model, so
  // the hosted-model half would otherwise reject every Cursor turn here and
  // silently fall back. On that arm the helper asks its own question instead —
  // is this the sentinel? — and a `false` from it is NOT a fallback signal; see
  // the throw below.
  const modelEligible = harnessAdapter
    ? harnessModelEligibleForRuntime({
        adapter: harnessAdapter,
        modelId: harnessModelId,
        provider: opts.modelDefinition.provider,
      })
    : isHostedCatalogModel(harnessModelId, opts.modelDefinition.provider);
  const useHarness = harnessRequested && modelEligible;
  if (harnessRequested && !modelEligible) {
    // AN EXTERNAL-ACCOUNT HARNESS HAS NO FALLBACK, so ineligibility here is a
    // hard failure rather than a degrade. The warn-and-emulate below is sound
    // only where the emulated engine is a real substitute — a brokered harness
    // refused for "MCPJam does not host this model" leaves an engine that runs
    // exactly that model, on org BYOK. Neither half of that holds here: the
    // emulated engine cannot run a sentinel at all, and the id a mis-configured
    // host carries is one the runtime would have ignored.
    //
    // What the fallback would produce is the failure this whole rule exists to
    // stop, arriving through the fix for it: a swarm or eval turn on a
    // mis-configured Cursor host runs the EMULATED engine, completes, and is
    // recorded under `executionEngineLabel` = `harness:cursor`. A completed run
    // that reports success and never ran Cursor is indistinguishable in the
    // transcript from one that did — strictly worse than the mis-attributed
    // model id, because there is no longer anything in the record that is
    // wrong-looking. The interactive rails fail closed at
    // `checkHarnessRuntimeAvailable`; this is the same refusal for the paths
    // that never call it (`sessionSimulation/runner.ts` drives turns without a
    // pre-flight, and only its swarm caller admits targets through one).
    //
    // Thrown, not returned: this is a wiring/configuration error, and every
    // caller here already treats a thrown turn as a failed turn.
    const externalAccountRefusal = harnessAdapter
      ? externalAccountHostModelRefusalReason({
          harnessId: harnessAdapter.id,
          modelId: harnessModelId,
        })
      : undefined;
    if (externalAccountRefusal) {
      // Wrapped in the SAME sentence the chat routes build around a pre-flight
      // refusal, so a reader who meets this in a run log and one who meets it in
      // a 503 are reading the same thing.
      throw new Error(
        `This host runs the ${opts.harness} harness, which isn't available: ` +
          `${externalAccountRefusal}.`,
      );
    }
    logger.warn(
      "[assistant-turn] harness requested but model ineligible (not MCPJam-" +
        "provided, or unsupported by the runtime) — falling back to the emulated " +
        "engine (surfaced, not silent)",
      {
        harness: opts.harness,
        modelId: harnessModelId,
        provider: opts.modelDefinition.provider,
        sourceType: opts.sourceType,
      },
    );
  }
  const engineResult = useHarness
    ? await runHarnessTurn(handlerOptions, opts.streamSink)
    : await runChatEngineLoop(handlerOptions, opts.streamSink);

  // For streamSink: "none" the engine has fully run — its
  // onConversationComplete tap (wrapped above) populated
  // capturedMessages/capturedTrace synchronously. For streamSink: "ui"
  // the engine returned a Response without running onFinish yet; the
  // captured fields will populate later, after Hono drains the body.
  //
  // engineResult.messageHistory is the live ref the engine mutates, so
  // it converges to the same content as capturedMessages once the
  // stream drains. We prefer the captured snapshot when available
  // (post-onFinish view) and fall back to the engine ref otherwise —
  // never to opts.messages.
  const messages = capturedMessages ?? engineResult.messageHistory;
  const assistantMessages = extractAssistantMessages(messages);
  const toolCalls = extractToolCalls(messages);
  const toolResults = extractToolResults(messages);

  // For streamSink: "none" we prefer the trace surfaced eagerly on the
  // engine result (set inside onFinish before runChatEngineLoop
  // resolved). For streamSink: "ui" the trace populates the wrapped
  // onConversationComplete callback after the response body is drained.
  const turnTrace = capturedTrace ?? engineResult.turnTrace;

  const result: RunAssistantTurnResult = {
    messages,
    assistantMessages,
    toolCalls,
    toolResults,
    ...(turnTrace ? { turnTrace } : {}),
    ...(turnTrace?.usage ? { usage: turnTrace.usage } : {}),
    ...(turnTrace?.finishReason
      ? { finishReason: turnTrace.finishReason }
      : {}),
    // Surface the harness resume-state commit so a caller-persist consumer can
    // ride it into its own ingest (populated synchronously for streamSink
    // "none"; for "ui" it lands after the body drains, alongside the transcript).
    ...(capturedHarnessCommit
      ? { harnessSessionCommit: capturedHarnessCommit }
      : {}),
  };

  if (opts.streamSink === "ui" && engineResult.response) {
    result.response = engineResult.response;
  }

  return result;
}

// Re-export the chunk type so callers that wire a custom sink (future
// stages) don't have to import from `ai` separately.
export type { UIMessageChunk };
