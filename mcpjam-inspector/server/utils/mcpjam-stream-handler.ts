/**
 * MCPJam Stream Handler
 *
 * Handles the agentic loop for MCPJam-provided models.
 * The LLM lives in Convex (to protect the OpenRouter key),
 * while MCP tools execute locally in this Express server.
 */

import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  parseJsonEventStream,
  pruneMessages,
  type ToolSet,
} from "ai";
import type {
  UIMessageChunk,
  ReasoningUIPart,
  TextPart,
  ToolCallPart,
  ToolModelMessage,
  AssistantModelMessage,
  ToolResultPart,
} from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { zodSchema } from "@ai-sdk/provider-utils";
import type {
  MCPClientManager,
  Harness,
  ToolTaskSeamOptions,
} from "@mcpjam/sdk";
import {
  describeAsSlug,
  describeError,
  isNormalizedError,
  type NormalizedError,
} from "@mcpjam/sdk";
import {
  createSystemStreamFailureReporter,
  oncePerTurn,
  type StreamFailureReporter,
} from "./stream-failure-reporter.js";
import type { ModelVisibleMcpToolResults } from "@mcpjam/sdk/host-config/internal";
import { runHarnessTurn } from "./harness/run-harness-turn.js";
import type { TrustedHarnessSandboxBinding } from "./harness/resolve-sandbox.js";
import type { HarnessSessionCommitPayload } from "./harness/harness-session-state.js";
import type { ExecutionScope } from "./execution-scope.js";
import type { PinnedSkillArtifact } from "../../shared/skill-types.js";
import type { RuntimeSkill } from "./harness/runtime-skills.js";
import type { EffectiveCapabilitySet } from "../services/environments/effective-capabilities.js";
import type { HarnessMcpProxyStrategy } from "./harness/harness-proxy-strategy.js";
import type { HarnessPolicyBlockRecord } from "./harness/harness-proxy-policy-enforcement.js";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";
import type { InsufficientScopeInfo } from "../routes/web/hosted-elicitation.js";
import type { ScopeStepUpRequiredEvent } from "@/shared/scope-step-up";
import {
  buildFinishChunk,
  emitError,
  emitToolApprovalRequest,
  emitToolInput,
  emitToolOutput,
  emitToolOutputDenied,
  safelyInvoke,
} from "./chat-stream-chunks.js";
import { z } from "zod";
import {
  hasUnresolvedToolCalls,
  executeToolCallsFromMessages,
} from "@/shared/http-tool-calls";
import { isMrtrSuspendSignalShape } from "@/shared/mrtr-continuation";
import { isScopeStepUpSuspendSignal } from "./scope-step-up-continuation.js";
import {
  spliceMrtrToolResult,
  hasUnresolvedToolCall,
  type MrtrEngineResume,
} from "./mrtr-hosted-chat.js";
import {
  isClientFulfilledToolName,
  type UiToolApprovalClassification,
} from "@/shared/client-fulfilled-tools";
import {
  scrubUnavailableToolHistoryForBackend,
  scrubMcpAppsToolResultsForBackend,
  scrubChatGPTAppsToolResultsForBackend,
} from "./chat-helpers";
import { normalizeModelMessagesForConvex } from "./normalize-model-messages-for-convex";
import {
  serializeToolsForConvex,
  type ToolDefinition,
} from "./mcpjam-tool-helpers";
import {
  commitNewlyLoaded,
  gateToolsToActiveSubset,
  lookupToolIdByModelName,
  META_TOOL_SEARCH,
  resolveActiveToolNames,
  META_TOOL_NAMES,
  shouldForceInitialToolSearch,
  type ProgressiveToolPlan,
  type ToolDiscoveryState,
} from "@/shared/progressive-tool-discovery";
import { mergeMcpToolOriginMetadata } from "@/shared/mcp-tool-origin-metadata";

function unwrapJsonEnvelope(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return current;
    }
    const record = current as Record<string, unknown>;
    if (record.type !== "json" || !("value" in record)) {
      return current;
    }
    current = record.value;
  }
  return current;
}

function isModelVisibleImageOutput(value: unknown): boolean {
  const output = unwrapJsonEnvelope(value);
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }
  const record = output as Record<string, unknown>;
  if (record.type !== "content" || !Array.isArray(record.value)) {
    return false;
  }
  return record.value.some((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return false;
    }
    const partRecord = part as Record<string, unknown>;
    if (partRecord.type === "text" && typeof partRecord.text === "string") {
      return (
        partRecord.text.startsWith("[image omitted:") ||
        partRecord.text.startsWith("[resource link omitted:") ||
        partRecord.text.startsWith("[embedded image resource omitted:")
      );
    }
    return (
      (partRecord.type === "media" || partRecord.type === "image-data") &&
      typeof partRecord.mediaType === "string" &&
      partRecord.mediaType.startsWith("image/")
    );
  });
}

/**
 * Approval-free check for a tool-call name.
 *
 * The progressive-discovery meta-tools (`search_mcp_tools`,
 * `load_mcp_tools`) are exempt from approval because gating discovery
 * itself behind N approvals defeats the point — see the module docstring.
 * But the exemption is name-only, and we cannot trust the name in
 * isolation: when progressive mode is **off** there are no meta-tools in
 * the toolset, but a real MCP server is free to expose a tool literally
 * named `search_mcp_tools`. Honoring the exemption in that case would
 * silently let a real, approval-required tool execute without the user's
 * confirmation.
 *
 * Require `progressivePlan?.enabled` as a precondition — that's the only
 * mode in which the orchestrator actually mints the meta-tools (and it
 * also fails fast on real-tool name collisions in `prepareChatV2`, so a
 * matching name truly is one of our meta-tools).
 */
function isApprovalFreeMetaToolName(
  name: string,
  progressivePlan: ProgressiveToolPlan | undefined
): boolean {
  if (!progressivePlan?.enabled) return false;
  return META_TOOL_NAMES.includes(name);
}

/**
 * Whether THIS tool call must pause for the user's approval.
 *
 * The turn's `requireToolApproval` flag is the rule for real MCP tools only.
 * WebMCP `ui_*` tools carry their own per-tool policy, pre-computed by the
 * caller into `uiToolApprovals` (from the VALIDATED snapshot's MCP
 * annotations — never from the raw name, which a third-party server could
 * spoof). A destructive UI tool must gate even when the flag is OFF, which is
 * the default: writing this as `requireToolApproval && !isApprovalFree(...)`
 * is what silently let destructive client-fulfilled calls through.
 *
 * Order matters. UI classification wins over the flag in both directions:
 *   - in `requiredNames` → approval, flag or no flag;
 *   - in `freeNames` → never (a read-only snapshot buys nothing by pausing);
 *   - unknown name → a real tool: follow the flag, exempting meta-tools.
 */
function toolCallNeedsApproval(
  name: string,
  progressivePlan: ProgressiveToolPlan | undefined,
  uiToolApprovals: UiToolApprovalClassification | undefined,
  // `boolean | undefined`, not `boolean`: the callers thread through an
  // optional `requireToolApproval`, and this file is server-side (not covered
  // by the client typecheck), so a bare `boolean` param let `undefined` flow
  // in and `return requireToolApproval` hand back `undefined` for a real
  // tool. Coerce so the return is always a real boolean.
  requireToolApproval: boolean | undefined
): boolean {
  if (uiToolApprovals?.requiredNames.has(name)) return true;
  if (uiToolApprovals?.freeNames.has(name)) return false;
  if (isApprovalFreeMetaToolName(name, progressivePlan)) return false;
  return requireToolApproval === true;
}
import { logger } from "./logger";
import {
  applyPrepareAdvertisedTools,
  gateToolsToAdvertisedSubset,
  type PrepareAdvertisedTools,
} from "./advertised-tools";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { normalizeFinishReason } from "@/shared/eval-trace";
import {
  mergeLiveChatTraceUsage,
  type LiveChatTraceUsage,
} from "@/shared/live-chat-trace";
import {
  writePersistReceipt,
  type PersistChatOutcome,
  type PersistedTurnTrace,
} from "./chat-ingestion";
import { StreamTurnDriver } from "./stream-turn-driver.js";
import {
  pushAiSdkTrailingErrorSpan,
  pushBackendStepLlmFailureSpans,
  pushBackendStepSuccessSpans,
  pushBackendStepToolFailureSpans,
  wrapBackendToolsForTrace,
} from "../services/evals/eval-trace-capture";
import {
  emitRequestPayload,
  emitTraceSnapshot,
  generateLiveTraceTurnId,
  getPromptIndex,
  getPromptMessageStartIndex,
  readToolServerId,
  setToolSpanMessageRangesFromResults,
  toTraceRecord,
  writeTraceEvent,
} from "./live-chat-trace-stream";
import {
  buildResolvedModelRequestPayload,
  normalizeSystemPromptForProvider,
} from "./model-request-payload";
import { hashGuestSpendIp } from "./guest-spend-ip.js";
import { isAbortError } from "@/shared/abort-errors";

const DEFAULT_MAX_STEPS = 30;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const STEP_LOG_THRESHOLD = 20;
const GUEST_IP_HASH_HEADER = "x-mcpjam-guest-ip-hash";

function readLinkedMcpResourceWithManager(
  mcpClientManager: MCPClientManager
): (params: {
  serverId: string;
  uri: string;
  options?: { abortSignal?: AbortSignal };
}) => Promise<unknown> {
  return ({ serverId, uri, options }) => {
    const requestOptions = options?.abortSignal
      ? { signal: options.abortSignal }
      : undefined;
    return mcpClientManager.readResource(serverId, { uri }, requestOptions);
  };
}
const streamChunkSchema = zodSchema(z.unknown());

let warnedMissingAbortSignal = false;
/**
 * Dev-only warning fired once per process when the inbound chat request has
 * no abort signal. Real production traffic on Hono always populates
 * `c.req.raw.signal`; absence here means a runtime/adapter change has
 * regressed cancellation. Silent in prod and tests.
 */
export function warnIfChatAbortSignalMissing(
  signal: AbortSignal | undefined,
  source: string
): void {
  if (signal || warnedMissingAbortSignal) return;
  warnedMissingAbortSignal = true;
  if (process.env.NODE_ENV === "production") return;
  if (process.env.NODE_ENV === "test") return;
  logger.warn(
    "[mcpjam-stream-handler] inbound chat request has no AbortSignal; " +
      "client disconnect will not cancel the agentic loop",
    { source }
  );
}

/**
 * Event payloads for the chunk-level + step-level callbacks exposed by
 * the chat engine to its callers. Engine consolidation PR 5b-pre
 * (`~/mcpjam-docs/unification.md`) adds these so eval's backend stream
 * runner can wire SSE events from engine signals when PR 5b collapses
 * `streamIterationViaBackend` onto the shared engine. Chat + synthetic
 * pass nothing today and are unaffected.
 *
 * `promptIndex` mirrors `traceTurn.promptIndex` — eval needs it for
 * trace span correlation; chat / synthetic ignore it.
 */
export interface MCPJamToolCallEvent {
  toolCallId: string;
  toolName: string;
  input: unknown;
  stepIndex: number;
  promptIndex: number;
  serverId: string | undefined;
}

export interface MCPJamToolResultEvent {
  toolCallId: string;
  /** May be undefined when the chunk lacks toolName (older Convex versions). */
  toolName: string | undefined;
  output: unknown;
  /**
   * Browser-rendered MCP App eval PR 14: the raw, unscrubbed implementation
   * result the tool's `execute` returned (the `result:` extra
   * `executeToolCallsFromMessages` stamps on the part for UI hydration).
   * `output` above is the LLM-facing view — for MCP App tools that view is
   * scrubbed of `_meta` / `structuredContent`, which the eval runner's widget
   * render hook needs to feed the OpenAI-compat shim with full fidelity.
   * Undefined for tools that don't carry the raw extra (e.g. `toModelOutput`
   * tools, denial results).
   */
  rawResult?: unknown;
  /** `true` when the tool execution returned an error result (vs. an OK output). */
  isError: boolean;
  stepIndex: number;
  promptIndex: number;
  serverId: string | undefined;
}

export interface MCPJamStepFinishEvent {
  stepIndex: number;
  promptIndex: number;
  /**
   * Cumulative usage for this TURN as of step completion (the engine
   * tracks per-turn aggregates, not per-step deltas). Callers compute
   * per-step deltas across successive `onStepFinish` invocations if
   * they need them. Undefined when the engine has no usage signal for
   * this step.
   */
  turnUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  /**
   * **Step SETTLED, not necessarily successful.** `onStepFinish` fires
   * once per `processOneStep` return, regardless of outcome — including
   * the non-OK HTTP / no-body / decode-error branches that emit an
   * `error` UI chunk + failure trace event and return
   * `didEmitFinish: false`. Callers that map this to a higher-level
   * "step succeeded" SSE event (eval's `step_finish`) MUST gate on
   * `settledWithError === false`, OR consume failure events from the
   * UI/trace stream and treat `onStepFinish` as a settle-once
   * notification.
   *
   * Marcelo's PR 5b-pre review caveat: if PR 5b wires this directly to
   * eval `step_finish` SSE, failed backend steps would emit
   * `step_finish` where the pre-collapse runner only emitted error /
   * failure trace. Surfacing the settle state on the event lets the
   * wire-up decide.
   */
  settledWithError: boolean;
  /**
   * PR 5b-followup-2: snapshot of the engine's per-turn spans as of
   * step settlement. The engine accumulates LLM-step + tool spans on
   * `traceTurn.turnSpans` while the agentic loop runs but only
   * surfaces them post-turn via `PersistedTurnTrace.spans`. Eval's
   * mid-turn `step_finish` `trace_snapshot` (Cursor #5b "Step
   * snapshots omit LLM spans") would otherwise show only prior-turn
   * spans + the runner's local tool-instrumentation spans, dropping
   * the active turn's engine-recorded per-step LLM timing. The shape
   * is a SNAPSHOT (defensive copy) — callers may retain it across
   * step boundaries without race risk against the engine's continued
   * mutation of `traceTurn.turnSpans`. Empty array when the engine
   * has no spans yet for this turn (failed first step, etc).
   */
  turnSpans: EvalTraceSpan[];
}

/**
 * PR 5b-followup-2: structured error event fired when the engine
 * catches an error mid-step and routes it through the writer as an
 * `error` UI chunk. Eval's backend stream runner consumes this to
 * surface guardrail detail (e.g. 429 daily-cap "Daily MCPJam model
 * limit reached. Use BYOK or try again tomorrow.") on its `error`
 * SSE event — without the callback, `streamSink: "none"` consumers
 * only see the engine's generic fallback message because the UI
 * chunk goes to the no-op writer.
 *
 * Three fire sites in the engine:
 *  1. Non-OK Convex `/stream` HTTP response in `processOneStep` —
 *     structured fields populated when the body parsed as
 *     `{ code?, error, details? }` (the standard guardrail shape).
 *  2. `processStream` / tool-execution catch in `processOneStep` —
 *     `message` only (decode / tool-throw error).
 *  3. Outer agentic-loop catch in `runChatEngineLoop` — `message`
 *     only (anything else that escaped the per-step handlers).
 */
export interface MCPJamEngineErrorEvent {
  /**
   * Human-readable display message. For site (1) when the body
   * parsed structured, this is `"<error> <details>"`; otherwise the
   * raw response text or the Error.message.
   */
  message: string;
  /** Structured error code when the body parsed as a guardrail response. */
  code?: string;
  /** Structured details string when the body parsed as a guardrail response. */
  details?: string;
  /** HTTP status when the error came from a non-OK response (site 1 only). */
  httpStatus?: number;
  /**
   * Raw response body / `Error.message` text — always present for
   * logging / debugging. Callers should prefer `message` for display.
   */
  rawText: string;
  promptIndex: number;
  /** Step index when fired inside `processOneStep`; omitted for site (3). */
  stepIndex?: number;
  /**
   * WHICH LAYER was running when this fired — not what the message says.
   *
   * `"setup"` means the turn died before the model stream began: the harness
   * catches its own pre-stream preparation (no `projectId`, no auth bearer,
   * broker credential delivery disabled, a sandbox it could not reserve) in
   * the same block that catches a stream failure, and reports both here.
   * A consumer that assumed every engine error was a provider failure would
   * file our own setup bug as the provider's outage.
   *
   * Derived from a flag the emitter already holds — whether the turn's trace
   * ever started — never from reading the message. Omitted by emitters that
   * cannot distinguish the two, and a consumer must treat that as unknown
   * rather than as either answer.
   */
  phase?: "setup" | "stream";
  /**
   * Classified form of this failure, including its `origin` — whose fault the
   * turn dying was.
   *
   * The hosted 502 that started this work fires at site (1), which has NO
   * Error object at all: just a non-OK `Response` from our own `/stream`
   * endpoint. `describeError` has nothing to classify there, so site (1)
   * classifies from the HTTP status and body shape instead (see
   * {@link describeBackendStreamFailure}). Sites (2) and (3) hold a real
   * error and go through the normal describer.
   */
  normalized?: NormalizedError;
}

/**
 * Classify a non-OK response from MCPJam's own `/stream` backend.
 *
 * There is no error object at this site — the failure IS an HTTP response —
 * so nothing in the describer can reach it. Without this, a hosted 502 on a
 * chat turn produced a raw string and no attribution, which is exactly the
 * failure a user cannot tell apart from their own server dying.
 *
 * The body's guardrail `code` outranks the status, because it is the only
 * direct evidence of ownership on the wire. The backend answers a failure of
 * MCPJam's OWN managed provider credential with the upstream provider's
 * status — `categorizeError` in `convex/stream/routes.ts` returns
 * `{code:"mcpjam_api_error", statusCode:401}` for a revoked Gateway/OpenRouter
 * key and `{code:"mcpjam_rate_limit", statusCode:429}` for MCPJam's quota —
 * so status alone reads a total hosted outage as the user's expired key. See
 * {@link isMcpjamOwnedFailureCode}.
 *
 * Otherwise status drives the verdict:
 *
 * - 401/403 and 429 are the provider walls. With no MCPJam-owned code on the
 *   body they keep the catalog's default `user_config` origin: `/stream`
 *   answers its own auth gate with 401 `auth_required` (sign in) and the spend
 *   precheck with 429 `user_rate_limit`, both genuinely user-owned.
 * - Any other 5xx is OUR backend answering badly, and the origin is set
 *   explicitly rather than taken from the slug. `internal/unknown` is
 *   `ambiguous` by design — it is where unrecognized failures from arbitrary
 *   user servers land — but this call site knows something the slug cannot:
 *   the hop was to MCPJam's own Convex deployment. That is precisely the
 *   "callers that know the failure happened on an internal boundary escalate
 *   it themselves" case the catalog documents.
 */
export function describeBackendStreamFailure(
  status: number | undefined,
  rawText: string,
  code?: string
): NormalizedError {
  const detail = new Error(
    status !== undefined ? `HTTP ${status}: ${rawText}` : rawText
  );

  // Before the status branches: a body that names MCPJam settles ownership no
  // matter which upstream status was mirrored onto it. The slug still comes
  // from the status so the user-facing copy stays accurate ("the provider
  // rejected the key" IS what happened — it was just our key).
  if (isMcpjamOwnedFailureCode(code)) {
    return { ...backendFailureSlug(status, detail), origin: "mcpjam" };
  }

  if (status !== undefined && status >= 500) {
    return { ...backendFailureSlug(status, detail), origin: "mcpjam" };
  }

  return backendFailureSlug(status, detail);
}

/**
 * Classify a mid-stream `{type:"error"}` chunk from MCPJam's own `/stream`
 * backend — the failure delivered as a stream PART, after the headers already
 * said 200.
 *
 * Same code rule as {@link describeBackendStreamFailure}, and deliberately
 * NOT the same status rule. There the status is our own backend's response
 * status, so a 5xx is our outage. Here it is the field the backend copied off
 * the UPSTREAM provider's error (`categorizeError`'s `statusCode`), so an
 * Anthropic 503 arrives as `statusCode: 503` — reading that as "our backend
 * answered 5xx" would page us for someone else's overloaded model. Identical
 * number, opposite meaning; only the delivery path distinguishes them.
 *
 * So the code is the ONLY thing that can assert MCPJam ownership here. Without
 * one the catalog's own verdict stands — which for an unrecognized provider
 * failure is `ambiguous`: visible, measured, never paging.
 */
export function describeStreamErrorChunkFailure(
  status: number | undefined,
  rawText: string,
  code?: string
): NormalizedError {
  const detail = new Error(
    status !== undefined ? `HTTP ${status}: ${rawText}` : rawText
  );

  if (isMcpjamOwnedFailureCode(code)) {
    return { ...backendFailureSlug(status, detail), origin: "mcpjam" };
  }

  return backendFailureSlug(status, detail);
}

/** Status → slug, carrying the catalog's own origin. Shared by both paths. */
function backendFailureSlug(
  status: number | undefined,
  detail: Error
): NormalizedError {
  if (status === 401 || status === 403) {
    return describeAsSlug("provider/auth_error", detail);
  }
  if (status === 429) {
    return describeAsSlug("provider/quota", detail);
  }
  return describeAsSlug("internal/unknown", detail);
}

export interface MCPJamHandlerOptions {
  messages: ModelMessage[];
  modelId: string;
  /**
   * Logical provider for span metadata (OTel `gen_ai.provider.name`, e.g.
   * "anthropic"). Threaded from the caller's model config — never derived from
   * `modelId`. Optional: when omitted, llm/step spans simply lack `provider`.
   */
  provider?: string;
  systemPrompt: string;
  temperature?: number;
  tools: ToolSet;
  /**
   * MCPJam's own server-executed built-in tools (e.g. web_search) as a subset
   * of `tools`. The emulated engine reads them from `tools`; the harness path
   * needs them SEPARATELY because the harness's MCP-server tools arrive via
   * `.mcp.json` — only these host-executed tools are forwarded to
   * `HarnessAgent({ tools })`, where the runtime calls them and the agent runs
   * their `execute()` back on this server. Excludes appTools (no execute —
   * browser-fulfilled) and skills (the harness has its own).
   */
  builtInTools?: ToolSet;
  /**
   * The host's configured computer working directory (`hostConfig.computer
   * .workdir`), COMP-16. Single source of truth for WHERE commands run on the
   * box: the chat `bash` tool already reads it via `builtInTools`; the harness
   * path needs it separately here to root its Shell under the same directory
   * (the harness framework then nests a per-session `<workdir>/claude-code-<id>`
   * subdir). Absent ⇒ the box default (`/home/user`). Confined server-side.
   */
  computerWorkdir?: string;
  /**
   * A disposable box the CALLER already provisioned for this session, which the
   * harness runs on INSTEAD of reserving the acting user's personal computer
   * (B-isolation phase 6). Set by the swarm runner per attempt; absent for
   * playground/chat/evals, which keep the personal path byte for byte.
   *
   * TRUSTED, and out-of-band on purpose. It travels on the handler options —
   * never on a host config or a run snapshot — exactly like `ctx.sandboxBinding`
   * does for the `bash` tool, so the only thing that can produce one is an
   * in-process caller that just booted the box. A widened host-config union
   * would be forgeable from a member-readable snapshot.
   *
   * HARNESS-ONLY. The emulated engine's built-in tools bind through
   * `resolveHostTools`/`ctx.sandboxBinding`; this is the harness's equivalent,
   * because `runHarnessTurn` does not go through the tool resolver at all.
   */
  harnessSandboxBinding?: TrustedHarnessSandboxBinding;
  authHeader?: string;
  scenarioId?: string;
  accessVersion?: number;
  projectId?: string;
  chatSessionId?: string;
  sourceType?: string;
  /**
   * Swarm (journey-execution) continuity identity. When `sourceType === "swarm"`
   * these key the harness `swarm-chat` owner lane (`journeyRunId` + `hostId` +
   * `chatSessionId`) so a multi-turn swarm harness session resumes only its own
   * runtime sidecar and never collides with a Direct/Scenario lane. Set by the
   * swarm runner; absent for every other surface. See
   * `mcpjam-backend/convex/harnessSessions.ts` (`swarm-chat` owner).
   */
  journeyRunId?: string;
  hostId?: string;
  /**
   * Pinned harness skills (Project Environments — env-based swarm targets
   * only). When set — even EMPTY — the harness turn delivers exactly these
   * pinned artifacts and SKIPS the live `fetchRuntimeSkills` query; its
   * `skillsHash` derives from the pinned artifact fingerprints. Undefined ⇒
   * the legacy live-pool fetch. HARNESS-ONLY: the emulated engine receives
   * pinned skills via prepareChatV2's `skillsSource` instead (which THROWS on
   * harness+pinned — the two paths are deliberately disjoint).
   */
  pinnedHarnessSkills?: PinnedSkillArtifact[];
  /**
   * Resolved Project-Environment skills for THIS turn (Phase 1.4). When set —
   * even EMPTY — the harness turn delivers exactly these and SKIPS the live
   * project-wide `fetchRuntimeSkills` query. Ranks BELOW `pinnedHarnessSkills`
   * (a pinned run's reproducibility outranks a live environment resolution) and
   * ABOVE the legacy live fetch; see `harness/skill-delivery.ts` for the single
   * place that precedence is written down. An empty override is semantic: the
   * environment delivers no skills, which is not the same as "ask the project".
   */
  runtimeSkillsOverride?: RuntimeSkill[];
  /**
   * The turn's resolved `EffectiveCapabilitySet` (INS-3), harness side (INS-7).
   * Set alongside `runtimeSkillsOverride` for an environment turn; it carries
   * what the flat skill list structurally cannot — per-skill SUPPORTING FILES
   * (the only source that includes a plugin skill's, since the project-wide file
   * query excludes `plugin_component` rows) and the pinned plugin VERSIONS,
   * which fold into the harness runtime fingerprint so a plugin change
   * invalidates an incompatible resumed sandbox.
   *
   * Delivery input only. Nothing derived from it is persisted as a pin: every
   * launch re-resolves the environment, so a recorded version is provenance.
   */
  effectiveCapabilities?: EffectiveCapabilitySet;
  /**
   * Phase 3 execution scope from the server-resolved runtime config (scenario OR
   * host-by-id). Threaded into the harness path (sandbox reserve, runtime skills,
   * broker start, session-state, ingest commit) so the backend re-resolves live
   * access + per-swarm host-funded caps. Absent ⇒ legacy member path.
   */
  executionScope?: ExecutionScope;
  mcpClientManager: MCPClientManager;
  selectedServers?: string[];
  /** Real agent harness for this turn (absent ⇒ MCPJam's emulated engine).
   *  When "claude-code", handleMCPJamFreeChatModel routes to runHarnessTurn. */
  harness?: Harness;
  /** Which MCP-proxy plane the harness uses to route its MCP through MCPJam —
   *  set by the CALLER ROUTE (local `/api/mcp/*` vs hosted `/api/web/*`), not a
   *  global env. Absent ⇒ harness runs without proxied MCP. See
   *  `harness-proxy-strategy.ts`. */
  harnessMcpProxy?: HarnessMcpProxyStrategy;
  /**
   * Resolved `toolPolicy` decisions per selected server id, computed at launch
   * from the annotation cache. Present ⇒ each policied server's `.mcp.json`
   * entry carries a SEALED proxy token, and the hosted harness-MCP route
   * enforces the snapshot on `tools/call` (the in-sandbox calls never pass
   * through an in-process tool map, so the proxy is the only chokepoint).
   * Absent ⇒ today's unpoliced bare-token path, byte-identical.
   */
  harnessToolPolicy?: Record<string, ToolPolicySnapshot>;
  /**
   * The eval ITERATION this harness turn is executing, when there is one.
   *
   * Present ⇒ the turn mints proxy tokens carrying an authorized iteration
   * claim and puts its turn id on each `.mcp.json` entry, which is what lets
   * the proxy record firsthand tool-call evidence. Absent ⇒ playground
   * traffic, a quick run, or any turn with no run to attach evidence to — all
   * of which mint and execute exactly as they did before evidence existed.
   *
   * An explicit typed field rather than a metadata bag: what it selects is a
   * durable, purgeable record keyed on this id, and a caller that misspells a
   * bag key should get a compile error, not a run that silently records
   * nothing.
   */
  evalIterationId?: string;
  /**
   * Sink for the evidence decision the MINT reported for that iteration.
   *
   * The mint is the first place the run's FROZEN decision is visible to the
   * turn, so this hands it back to the driver — which needs it to decide
   * whether to read evidence at all, and whether to grade from it. It is a
   * report, never a request: the runner cannot turn capture on with it.
   */
  onHarnessEvidenceDecision?: (decision: {
    captureEnabled: boolean;
    gradingSource: "narration" | "evidence";
    turnId: string;
  }) => void;
  /**
   * Sink for the calls the proxy refused, reported on THIS replica off the
   * results the harness streams back. The eval driver hands them to
   * `finalize-iteration` as the same policy blocks the in-process gate yields.
   */
  onHarnessPolicyBlocks?: (blocks: HarnessPolicyBlockRecord[]) => void;
  requireToolApproval?: boolean;
  /**
   * Per-tool approval policy for the `ui_*` tools this turn advertised,
   * classified by the caller from the validated snapshot's MCP annotations
   * (see `classifyUiToolApprovals`). Overrides `requireToolApproval` in both
   * directions for those names — destructive UI tools gate even when the flag
   * is off; read-only ones never gate.
   */
  uiToolApprovals?: UiToolApprovalClassification;
  /**
   * Host/client policy for eligible MCP tool-result content/resources.
   * Controls only model-facing tool output; raw results remain available to
   * UI/debug history.
   */
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  /**
   * Host-level switch for SEP-1865 `_meta.ui.visibility` filtering — the same
   * field `prepareChatV2` takes. `undefined`/`true` filter (spec default); only
   * an explicit `false` opts out.
   *
   * Read ONLY by the HARNESS engine, which builds its own MCP tool set
   * (`projectSelectedMcpServersAsHostTools`) instead of consuming the one
   * `prepareChatV2` prepared. The emulated engine is handed `tools` already
   * built, so it neither needs nor reads this.
   */
  respectToolVisibility?: boolean;
  /**
   * Resolved task-seam options, or absent for "tasks off". Same field and same
   * rule as `PrepareChatV2Options.tasks`: the MODE is resolved by the CALLER
   * (each surface is its own row in the policy matrix), never here.
   *
   * Read ONLY by the HARNESS engine, and for the same reason as
   * `respectToolVisibility` — the emulated engine's seam already rode in
   * through `prepareChatV2`. Absent keeps a harness turn on the pre-existing
   * no-`_meta` path, byte-for-byte.
   */
  tasks?: ToolTaskSeamOptions;
  /**
   * Approval-pause policy. `"prompt"` (default) is the real-chat path:
   * approval-required tool calls pause the loop until the user answers
   * via the next round-trip. `"auto-deny"` is the synthetic-session
   * path: each approval-required tool call resolves with an
   * `approval-denied (synthetic session)` error result and the loop
   * continues so the model can adapt. Real chat call sites pass
   * `"prompt"` (or omit the option); the synthetic-session runner
   * passes `"auto-deny"`.
   */
  approvalMode?: "prompt" | "auto-deny";
  /**
   * Hosted MRTR (§12.5, PR5) resume descriptor. Present only on a fresh request
   * that resumes a suspended tool call: the engine drives one retry leg BEFORE
   * the first model call, splices the driven result into the identified
   * tool-call slot, and resumes the loop — or pauses again on a further round /
   * a terminal (indeterminate / cancelled / expired) outcome. Emulated engine
   * only; the harness path never suspends through this manager.
   */
  mrtrResume?: MrtrEngineResume;
  /** SEP-2350 resume descriptor; driven before the first model step. */
  scopeStepUpResume?: MrtrEngineResume;
  /**
   * Creates a continuation for an exact harness-proxied tools/call. The
   * harness supplies its model-visible toolCallId after correlating the proxy
   * request with the streamed tool-input part.
   */
  createHarnessScopeStepUpContinuation?: (input: {
    info: InsufficientScopeInfo & { toolCallId: string };
    toolName: string;
    toolInput: unknown;
  }) => ScopeStepUpRequiredEvent | Promise<ScopeStepUpRequiredEvent>;
  /**
   * Persist tap. May return the ingest's outcome so the engine can stream a
   * `data-persist-receipt` before the stream closes — the client then KNOWS
   * whether its turn was saved instead of inferring it from a version poll.
   * Callers that persist headlessly (or not at all) keep returning void.
   */
  onConversationComplete?: (
    fullHistory: ModelMessage[],
    turnTrace: PersistedTurnTrace,
    // §3: present only for chat-backed harness turns — the resume-state commit
    // to apply atomically with the transcript via /ingest-chat.
    harnessSessionCommit?: HarnessSessionCommitPayload
  ) => Promise<void | PersistChatOutcome> | void | PersistChatOutcome;
  onStreamComplete?: () => Promise<void> | void;
  onStreamWriterReady?: (writer: {
    write: (chunk: UIMessageChunk) => void;
  }) => void;
  onLiveTextDelta?: (delta: string) => void;
  /**
   * Engine consolidation PR 5b-pre — fires from the chunk-processing
   * switch when Convex emits a `tool-input-available` chunk (the AI
   * SDK v6 equivalent of `tool-call`). Eval's backend stream runner
   * uses this to emit the `tool_call` SSE event. Chat / synthetic
   * omit; the engine writer still writes the `tool-input-available`
   * UI chunk verbatim regardless.
   */
  onToolCall?: (event: MCPJamToolCallEvent) => void;
  /**
   * Engine consolidation PR 5b-pre — fires from the local tool-result
   * persistence path AFTER the engine writes the `tool-output-available`
   * UI chunk and the `tool_result` trace event. Eval's backend stream
   * runner uses this to emit the `tool_result` SSE event. Chat /
   * synthetic omit.
   *
   * Browser-rendered MCP App eval PR 14: a returned promise is AWAITED
   * before the engine proceeds to the next step. The eval runner's widget
   * render hook relies on this ordering — the harness must have the widget
   * mounted before the next step's `prepareAdvertisedTools` gate decides
   * whether to advertise `computer` / `finish_widget`. Sync callbacks
   * (chat / eval SSE emitters) are unaffected.
   */
  onToolResult?: (event: MCPJamToolResultEvent) => void | Promise<void>;
  /**
   * Engine consolidation PR 5b-pre — fires from `runChatEngineLoop`
   * after each `processOneStep` returns and the step counter
   * increments. Eval's backend stream runner uses this to emit the
   * `step_finish` SSE event. Chat / synthetic omit.
   */
  onStepFinish?: (event: MCPJamStepFinishEvent) => void;
  /**
   * PR 5b-followup-2: structured-error callback. Fires when the
   * engine catches a non-OK Convex `/stream` response (e.g. 429 daily
   * spend cap), a `processStream` / tool-execution throw, or any
   * outer agentic-loop error — i.e. every site that emits a writer
   * `error` UI chunk + a trace `error` event. For non-OK responses,
   * the structured `{ code?, error, details? }` body is parsed and
   * populated on the event so `streamSink: "none"` consumers (eval's
   * backend stream runner) can surface guardrail detail on their own
   * error SSE event instead of dropping the actual reason. Chat /
   * synthetic omit; the writer-side error chunk still fires regardless.
   */
  onEngineError?: (event: MCPJamEngineErrorEvent) => void;
  /**
   * Typed-telemetry seam for mid-stream failures (route.operation.failed).
   * Routes with a Hono context pass `createRequestStreamFailureReporter(c)`
   * so the event carries the full request envelope; when absent the engine
   * falls back to the system reporter, so no caller can silently lose
   * events. See stream-failure-reporter.ts.
   */
  failureReporter?: StreamFailureReporter;
  /**
   * Browser-rendered MCP App eval PR 2 — optional per-step hook that narrows
   * the *advertised* tool set the model sees this step. Called inside
   * `processOneStep` after the active tool subset is resolved, with
   * `{ stepIndex, defaultToolNames }` (the names that would otherwise be
   * advertised). Returns the subset of names to keep, or `undefined` for "no
   * narrowing". Names not in `defaultToolNames` are ignored (defense-in-depth:
   * a caller can't smuggle in a non-advertised tool). A throw is logged and
   * falls back to the default set. This is *runtime-conditional advertising*
   * (e.g. hide `computer` / `finish_widget` until a widget has rendered) and
   * is distinct from progressive discovery (lazy MCP tool catalogs). Chat /
   * synthetic omit; the eval runner closes over harness state to decide.
   */
  prepareAdvertisedTools?: PrepareAdvertisedTools;
  /**
   * Override the Convex endpoint path for the per-step LLM call.
   * Defaults to "/stream". Org BYOK chat uses "/stream/org".
   */
  endpointPath?: string;
  /**
   * Extra headers added to every per-step Convex request. The standard
   * authHeader is forwarded so Convex can resolve the caller for /stream and
   * /stream/org.
   */
  extraHeaders?: Record<string, string>;
  /**
   * Extra body fields merged into every per-step Convex request. Used by org
   * BYOK chat to send the providerKey alongside the model id.
   */
  extraBodyFields?: Record<string, unknown>;
  /**
   * Originating client IP from the inbound request. Hashed and forwarded as
   * `x-mcpjam-guest-ip-hash` so Convex can apply the per-IP daily spend cap
   * for guests in addition to the per-cookie cap. Null when no IP is
   * available (dev / missing forwarded-for), in which case the header is
   * omitted and Convex falls back to the per-cookie guest cap.
   */
  clientIp?: string | null;
  /**
   * Inbound request signal. Forwarded into the per-step Convex fetch and the
   * local tool executor. When aborted, the agentic loop terminates silently:
   * no error chunk, no synthetic finish, no `turn_finish`, no
   * `onConversationComplete`. `onStreamComplete` still runs so callers can
   * release per-request resources (e.g. MCPClientManager teardown).
   */
  abortSignal?: AbortSignal;
  /**
   * Idle heartbeat interval. While the stream has been silent for at least
   * this many ms, the handler writes a transient `heartbeat` trace event so
   * LB/proxy idle timers don't sever the SSE connection. Defaults to
   * 15_000ms. `0` disables (used by tests).
   */
  heartbeatIntervalMs?: number;
  /**
   * Total per-turn step budget. The loop terminates when
   * `promptStepBaseIndex + steps >= maxSteps` so resumed approval requests
   * cannot keep extending the budget. Defaults to 30.
   */
  maxSteps?: number;
  /**
   * Optional progressive discovery context. When `plan.enabled === true` the
   * handler computes the per-step active tool definitions instead of sending
   * the full tool list on every Convex request. When omitted or
   * `plan.enabled === false`, behavior is unchanged.
   */
  progressivePlan?: ProgressiveToolPlan;
  /** Mutated by load_mcp_tools execute() — read between steps to rebuild defs. */
  discoveryState?: ToolDiscoveryState;
}

interface StepContext {
  writer: {
    write: (chunk: UIMessageChunk) => void;
  };
  messageHistory: ModelMessage[];
  /**
   * Full serialized tool list. In non-progressive mode this is what's sent
   * to Convex. In progressive mode the handler filters to active tools per
   * step using `progressivePlan` + `discoveryState`.
   */
  toolDefs: ToolDefinition[];
  /** Map from model-facing tool name → serialized def, for progressive mode. */
  toolDefsByName: Map<string, ToolDefinition>;
  tools: ToolSet;
  progressivePlan?: ProgressiveToolPlan;
  discoveryState?: ToolDiscoveryState;
  authHeader?: string;
  scenarioId?: string;
  accessVersion?: number;
  projectId?: string;
  chatSessionId?: string;
  sourceType?: string;
  modelId: string;
  /** Logical provider for span metadata (OTel gen_ai.provider.name). */
  provider?: string;
  systemPrompt: string;
  temperature?: number;
  mcpClientManager: MCPClientManager;
  selectedServers?: string[];
  requireToolApproval?: boolean;
  uiToolApprovals?: UiToolApprovalClassification;
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  approvalMode?: "prompt" | "auto-deny";
  stepIndex: number;
  usedToolCallIds: Set<string>;
  traceTurn: LiveTraceTurnContext;
  endpointPath: string;
  extraHeaders?: Record<string, string>;
  extraBodyFields?: Record<string, unknown>;
  clientIp?: string | null;
  onLiveTextDelta?: (delta: string) => void;
  // PR 5b-pre: chunk-level + step-level callbacks. Threaded to the
  // chunk-processing switch (onToolCall / onToolResult) and to the
  // step loop (onStepFinish). All optional.
  onToolCall?: (event: MCPJamToolCallEvent) => void;
  onToolResult?: (event: MCPJamToolResultEvent) => void | Promise<void>;
  onStepFinish?: (event: MCPJamStepFinishEvent) => void;
  // PR 5b-followup-2: structured-error callback. Fires at every site
  // that emits a writer `error` UI chunk (non-OK Convex response in
  // processOneStep, processStream/tool-execution catch, outer
  // agentic-loop catch). Optional.
  onEngineError?: (event: MCPJamEngineErrorEvent) => void;
  // Typed mid-stream failure telemetry; threaded from runChatEngineLoop
  // (already oncePerTurn-wrapped and fallback-resolved there).
  failureReporter: StreamFailureReporter;
  // Browser-rendered MCP App eval PR 2: per-step advertised-tool narrowing.
  prepareAdvertisedTools?: MCPJamHandlerOptions["prepareAdvertisedTools"];
  abortSignal?: AbortSignal;
}

type PersistedAssistantPart = TextPart | ToolCallPart | ReasoningUIPart;

interface LiveTraceTurnContext {
  turnId: string;
  promptIndex: number;
  promptMessageStartIndex: number;
  turnStartedAt: number;
  turnSpans: EvalTraceSpan[];
  turnUsage?: LiveChatTraceUsage;
}

interface StreamResult {
  contentParts: PersistedAssistantPart[];
  hasToolCalls: boolean;
  finishChunk: UIMessageChunk | null;
  /**
   * Absolute Date.now() of the first emitted stream chunk, for
   * time-to-first-chunk (OTel gen_ai.response.time_to_first_chunk). Undefined
   * if the stream produced no chunks.
   */
  firstChunkAt?: number;
}

/**
 * Generate a unique tool call ID
 */
function generateToolCallId(): string {
  return `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function collectUsedToolCallIds(messages: ModelMessage[]): Set<string> {
  const usedToolCallIds = new Set<string>();

  for (const msg of messages) {
    if (msg?.role === "assistant") {
      const assistantMsg = msg as AssistantModelMessage;
      if (!Array.isArray(assistantMsg.content)) continue;
      for (const part of assistantMsg.content) {
        if (
          (part.type === "tool-call" ||
            part.type === "tool-approval-request") &&
          typeof part.toolCallId === "string"
        ) {
          usedToolCallIds.add(part.toolCallId);
        }
      }
      continue;
    }

    if (msg?.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      for (const part of toolMsg.content) {
        if (
          part.type === "tool-result" &&
          typeof part.toolCallId === "string"
        ) {
          usedToolCallIds.add(part.toolCallId);
        }
      }
    }
  }

  return usedToolCallIds;
}

function hasUnresolvedClientFulfilledToolCalls(
  messages: ModelMessage[],
  tools: ToolSet
): boolean {
  const resultIds = new Set<string>();
  for (const msg of messages) {
    if (msg?.role !== "tool") continue;
    const toolMsg = msg as ToolModelMessage;
    if (!Array.isArray(toolMsg.content)) continue;
    for (const part of toolMsg.content) {
      if (part.type === "tool-result") resultIds.add(part.toolCallId);
    }
  }

  for (const msg of messages) {
    if (msg?.role !== "assistant") continue;
    const assistantMsg = msg as AssistantModelMessage;
    if (!Array.isArray(assistantMsg.content)) continue;
    for (const part of assistantMsg.content) {
      if (part.type !== "tool-call" || resultIds.has(part.toolCallId)) {
        continue;
      }
      const toolName = part.toolName;
      const toolEntry = (
        tools as Record<string, { execute?: unknown } | undefined>
      )[toolName];
      if (
        isClientFulfilledToolName(toolName) &&
        toolEntry &&
        typeof toolEntry.execute !== "function"
      ) {
        return true;
      }
    }
  }
  return false;
}

function generateUniqueToolCallId(
  usedToolCallIds: Set<string>,
  prefix = "tc"
): string {
  const MAX_ATTEMPTS = 100;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const nextId = `${prefix}_${generateToolCallId()}`;
    if (!usedToolCallIds.has(nextId)) {
      usedToolCallIds.add(nextId);
      return nextId;
    }
  }
  // Fallback: use a counter-based ID that is guaranteed unique
  const fallbackId = `${prefix}_fallback_${Date.now()}_${usedToolCallIds.size}`;
  usedToolCallIds.add(fallbackId);
  return fallbackId;
}

function createToolCallIdNormalizer(
  usedToolCallIds: Set<string>,
  stepIndex: number
): (rawToolCallId?: string) => string {
  const perStepMap = new Map<string, string>();
  let collisionCounter = 0;

  return (rawToolCallId?: string): string => {
    if (!rawToolCallId) {
      return generateUniqueToolCallId(usedToolCallIds, `step${stepIndex + 1}`);
    }

    const existing = perStepMap.get(rawToolCallId);
    if (existing) return existing;

    let normalized = rawToolCallId;
    if (usedToolCallIds.has(normalized)) {
      do {
        collisionCounter += 1;
        normalized = `${rawToolCallId}__s${stepIndex + 1}_${collisionCounter}`;
      } while (usedToolCallIds.has(normalized));
    }

    perStepMap.set(rawToolCallId, normalized);
    usedToolCallIds.add(normalized);
    return normalized;
  };
}

function getPromptAssistantStepBaseIndex(
  messageHistory: ModelMessage[],
  promptMessageStartIndex: number
): number {
  let assistantCount = 0;
  for (
    let index = promptMessageStartIndex;
    index < messageHistory.length;
    index += 1
  ) {
    if (messageHistory[index]?.role === "assistant") {
      assistantCount += 1;
    }
  }
  return assistantCount;
}

function readUsageFromFinishChunk(
  finishChunk: UIMessageChunk | null
): LiveChatTraceUsage | undefined {
  if (!finishChunk || finishChunk.type !== "finish") {
    return undefined;
  }

  // The Convex /stream endpoint sends token data via `messageMetadata` on the
  // finish chunk (using toUIMessageStreamResponse's messageMetadata callback).
  // Fall back to `totalUsage` for compatibility with test mocks / future changes.
  const chunk = finishChunk as UIMessageChunk & {
    totalUsage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
    messageMetadata?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  };
  const usage = chunk.messageMetadata ?? chunk.totalUsage;
  if (!usage) {
    return undefined;
  }

  const next: LiveChatTraceUsage = {};
  if (typeof usage.inputTokens === "number") {
    next.inputTokens = usage.inputTokens;
  }
  if (typeof usage.outputTokens === "number") {
    next.outputTokens = usage.outputTokens;
  }
  if (typeof usage.totalTokens === "number") {
    next.totalTokens = usage.totalTokens;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Read the model finish reason off a per-step `finish` chunk and normalize it
 * to the canonical span vocabulary. Returns undefined when absent — span
 * capture never fabricates one.
 */
function readFinishReasonFromChunk(
  finishChunk: UIMessageChunk | null
): string | undefined {
  type FinishUIMessageChunk = Extract<UIMessageChunk, { type: "finish" }>;
  const source = finishChunk as Partial<FinishUIMessageChunk> | null;
  return normalizeFinishReason(source?.finishReason);
}

function createClientFinishChunk(
  finishChunk: UIMessageChunk | null,
  traceTurn: LiveTraceTurnContext | null,
  fallbackReason: "length" | "stop"
): UIMessageChunk {
  type FinishUIMessageChunk = Extract<UIMessageChunk, { type: "finish" }>;
  const source = finishChunk as Partial<FinishUIMessageChunk> | null;
  // Prefer the turn-level aggregate so multi-step (tool-call) turns report the
  // sum across all LLM calls, not just the final step.
  const aggregateUsage = traceTurn?.turnUsage;
  const usage =
    aggregateUsage ??
    (finishChunk
      ? readUsageFromFinishChunk(finishChunk)
      : { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  const metadata = source?.messageMetadata;
  const messageMetadata =
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    usage
      ? { ...metadata, ...usage }
      : metadata ?? usage;

  return buildFinishChunk({
    finishReason: source?.finishReason ?? fallbackReason,
    messageMetadata,
  });
}

function setStepSpanMessageRanges(
  spans: EvalTraceSpan[],
  promptIndex: number,
  stepIndex: number,
  messageStartIndex: number | undefined,
  messageEndIndex: number | undefined
): void {
  if (
    typeof messageStartIndex !== "number" ||
    typeof messageEndIndex !== "number" ||
    messageEndIndex < messageStartIndex
  ) {
    return;
  }

  for (const span of spans) {
    if (
      (span.promptIndex ?? 0) !== promptIndex ||
      span.stepIndex !== stepIndex
    ) {
      continue;
    }
    if (typeof span.messageStartIndex !== "number") {
      span.messageStartIndex = messageStartIndex;
    }
    if (typeof span.messageEndIndex !== "number") {
      span.messageEndIndex = messageEndIndex;
    }
  }
}

/**
 * Strip UI-only fields from reasoning parts so the backend payload matches
 * the provider/model-message shape. `state: "done"` is added by
 * `processStream` while buffering reasoning chunks, but the AI SDK provider
 * shape does not include it; passing it through is a runtime no-op but
 * shows up in the wire payload and can trip strict validators.
 */
function normalizePreservedReasoning(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const assistantMsg = msg as AssistantModelMessage;
    if (!Array.isArray(assistantMsg.content)) return msg;
    let changed = false;
    const nextContent = assistantMsg.content.map((part) => {
      if (part?.type !== "reasoning") return part;
      const reasoningPart = part as unknown as Record<string, unknown>;
      if (!("state" in reasoningPart)) {
        return part;
      }
      const { state: _state, ...rest } = reasoningPart;
      changed = true;
      return rest as unknown as typeof part;
    });
    return changed ? ({ ...msg, content: nextContent } as ModelMessage) : msg;
  });
}

/**
 * Scrub messages for sending to the backend LLM.
 * Removes UI-specific metadata that shouldn't be sent to the model.
 *
 * `preserveReasoningFromIndex` is the index of the first message in the
 * *current* user turn (post the latest user message). Messages at or after
 * that index keep their reasoning parts so a thinking model can see its
 * own scratchpad between tool steps. Messages before that index still get
 * reasoning pruned to match prior behavior.
 */
function scrubMessagesForBackend(
  messages: ModelMessage[],
  tools: ToolSet,
  mcpClientManager: MCPClientManager,
  selectedServers?: string[],
  preserveReasoningFromIndex?: number
): ModelMessage[] {
  let pruned: ModelMessage[];
  if (
    typeof preserveReasoningFromIndex === "number" &&
    preserveReasoningFromIndex > 0 &&
    preserveReasoningFromIndex < messages.length
  ) {
    const priorTurn = messages.slice(0, preserveReasoningFromIndex);
    const currentTurn = messages.slice(preserveReasoningFromIndex);
    const prunedPrior = pruneMessages({
      messages: priorTurn,
      reasoning: "all",
    }) as unknown as ModelMessage[];
    // Strip UI-only `state` field from reasoning parts that survive the
    // current-turn slice; the backend/provider doesn't recognize it.
    const normalizedCurrent = normalizePreservedReasoning(currentTurn);
    pruned = [...prunedPrior, ...normalizedCurrent];
  } else {
    pruned = pruneMessages({
      messages,
      reasoning: "all",
    }) as unknown as ModelMessage[];
  }

  // First strip approval-specific parts that Convex/OpenRouter doesn't understand
  const stripped: ModelMessage[] = pruned.map((msg) => {
    if (msg.role === "assistant") {
      const assistantMsg = msg as AssistantModelMessage;
      if (!Array.isArray(assistantMsg.content)) return msg;
      const filtered = assistantMsg.content.filter(
        (part) => part.type !== "tool-approval-request"
      );
      if (filtered.length === assistantMsg.content.length) return msg;
      return { ...msg, content: filtered } as ModelMessage;
    }

    if (msg.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      const filtered = toolMsg.content.filter(
        (part) => part.type !== "tool-approval-response"
      );
      if (filtered.length === toolMsg.content.length) return msg;
      return { ...msg, content: filtered } as ModelMessage;
    }

    return msg;
  });

  const withoutUnavailableToolHistory = scrubUnavailableToolHistoryForBackend(
    stripped,
    Object.keys(tools as Record<string, unknown>)
  );

  const scrubbed = scrubChatGPTAppsToolResultsForBackend(
    scrubMcpAppsToolResultsForBackend(
      withoutUnavailableToolHistory,
      mcpClientManager,
      selectedServers
    ),
    mcpClientManager,
    selectedServers
  );
  return normalizeModelMessagesForConvex(scrubbed);
}

function safelyEmitLiveTextDelta(
  onLiveTextDelta: ((delta: string) => void) | undefined,
  delta: string
) {
  if (!onLiveTextDelta) return;
  safelyInvoke("[mcpjam-stream-handler] onLiveTextDelta", () =>
    onLiveTextDelta(delta)
  );
}

/**
 * Backend denial codes that name the USER as the responsible party.
 *
 * Only relevant at HTTP 200: the spend precheck answers `{ok:false,
 * code:"user_rate_limit"}` with a 200 status, so without this the whole
 * category would either page on every routine spend-limit rejection or, with a
 * looser "any code counts" rule, silently exempt the backend's own
 * `mcpjam_rate_limit` / `mcpjam_api_error` / `mcpjam_config_error` codes —
 * which are the opposite of user-owned.
 *
 * An unrecognized code at 200 from our own backend is therefore treated as a
 * fault, not a refusal. That direction is chosen deliberately: a missing entry
 * here costs one investigated alert, while a permissive rule costs the
 * blindness this work exists to remove. Add codes as the backend adds them.
 */
const USER_OWNED_DENIAL_CODES = new Set<string>([
  // convex `stream/routes.ts` + `lib/llmCallShell.ts` spend precheck
  "user_rate_limit",
  "wallet_locked",
  "org_rate_limit",
  // convex billing guard
  "billing_limit_reached",
  "billing_feature_not_included",
]);

/** Exported for the capture-policy tests; see {@link USER_OWNED_DENIAL_CODES}. */
export function isUserOwnedDenialCode(code: string | undefined): boolean {
  return USER_OWNED_DENIAL_CODES.has(code ?? "");
}

/**
 * The mirror of {@link USER_OWNED_DENIAL_CODES}: backend denial codes that name
 * MCPJAM as the responsible party.
 *
 * Relevant at every status, not just 200 — and that is the whole point. The
 * backend's `categorizeError` mirrors the UPSTREAM provider's status onto its
 * own response, so a revoked MCPJam Gateway/OpenRouter key comes back as HTTP
 * 401 and MCPJam's own provider quota as HTTP 429. Read by status alone those
 * are `provider/auth_error` / `provider/quota`, whose catalog origin is
 * `user_config` — and `mcpjam_internal` deliberately promotes only `ambiguous`,
 * never evidence-bearing origins. So a total hosted-chat outage was filed as
 * the user's expired key: no capture, no page, and nothing for M2 to fire on.
 *
 * Kept as an explicit allowlist rather than a `startsWith("mcpjam_")` rule so
 * a new backend code has to be read and classified rather than inheriting a
 * page from its name. Source of truth is the `MCPJamErrorCode` union in the
 * backend's `convex/stream/routes.ts`; its own comments mark these three
 * "(not user's fault)".
 */
const MCPJAM_OWNED_FAILURE_CODES = new Set<string>([
  "mcpjam_rate_limit",
  "mcpjam_api_error",
  "mcpjam_config_error",
]);

/** See {@link MCPJAM_OWNED_FAILURE_CODES}. */
export function isMcpjamOwnedFailureCode(code: string | undefined): boolean {
  return MCPJAM_OWNED_FAILURE_CODES.has(code ?? "");
}

/**
 * Parse the `errorText` of a mid-stream `{type:"error"}` chunk.
 *
 * SEPARATE from {@link parseEngineErrorBody} because the two shapes differ.
 * The backend's non-OK path returns `{ok, code, error, details}` (parsed
 * there); its mid-stream path is `toUIMessageStreamResponse({onError})`, which
 * serializes `{code, message, statusCode, isRetryable, details}` — `message`,
 * not `error`, and it carries the UPSTREAM `statusCode` that never reaches our
 * own HTTP response. Feeding this shape to the other parser yields the raw JSON
 * as the display text and drops the status.
 *
 * Non-JSON text (any other producer's error chunk) falls back to the text
 * itself, which is what the client used to be handed verbatim.
 */
export function parseStreamErrorChunkText(errorText: string): {
  message: string;
  code?: string;
  statusCode?: number;
  details?: string;
} {
  try {
    const body = JSON.parse(errorText) as {
      code?: unknown;
      message?: unknown;
      statusCode?: unknown;
      details?: unknown;
    };
    if (body && typeof body === "object") {
      const message =
        typeof body.message === "string" && body.message.trim().length > 0
          ? body.message
          : errorText;
      return {
        message,
        ...(typeof body.code === "string" ? { code: body.code } : {}),
        ...(typeof body.statusCode === "number"
          ? { statusCode: body.statusCode }
          : {}),
        ...(typeof body.details === "string" ? { details: body.details } : {}),
      };
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return { message: errorText };
}

/**
 * An error carrying a classification its thrower already made.
 *
 * Generalizes the convention `WebRouteError` already uses, so the engine's
 * outer catch can prefer a verdict reached with the structured body in hand
 * over `describeError`, which would only see the message string.
 */
function attachedNormalized(error: unknown): NormalizedError | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = (error as { normalized?: unknown }).normalized;
  return isNormalizedError(candidate) ? candidate : undefined;
}

/** Guardrail code a thrower attached alongside {@link attachedNormalized}. */
function attachedFailureCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { failureCode?: unknown }).failureCode;
  return typeof code === "string" ? code : undefined;
}

/**
 * PR 5b-followup-2: parse a Convex `/stream` non-OK response body as
 * the standard guardrail JSON shape `{ code?, error, details? }`.
 * Falls back to a generic `<status> <text>` message when the body
 * isn't structured. Mirrors the legacy
 * `describeBackendStreamError` shape that lived in
 * evals-runner before PR 5b's collapse — moved into the engine here
 * so `onEngineError` consumers see the same parsed display message.
 */
function parseEngineErrorBody(
  status: number | undefined,
  bodyText: string
): { message: string; code?: string; details?: string } {
  let code: string | undefined;
  try {
    const body = JSON.parse(bodyText) as {
      code?: string;
      error?: string;
      details?: string;
    };
    if (body?.error) {
      return {
        message: body.details ? `${body.error} ${body.details}` : body.error,
        ...(body.code ? { code: body.code } : {}),
        ...(body.details ? { details: body.details } : {}),
      };
    }
    // Bodies without an `error` field can still carry a machine-readable
    // `code` — the spend-precheck denial is `{ok:false, code:"user_rate_limit",
    // isRetryable, retryAfter}` (issue #3708). Surface it alongside the
    // generic message so consumers (agent route's rate-limit mapping) can
    // branch on `code` instead of regexing the raw body text.
    code = typeof body?.code === "string" ? body.code : undefined;
  } catch {
    // body wasn't JSON — fall through to generic shape
  }
  return {
    message:
      status !== undefined
        ? `Backend stream error: ${status} ${bodyText}`
        : bodyText,
    ...(code ? { code } : {}),
  };
}

/**
 * PR 5b-followup-2: safe-fire wrapper for `onEngineError`. Mirrors
 * the chunk-callback shape (try/catch + `logger.warn`) so a buggy
 * eval emitter can't crash the agentic loop.
 */
function safelyEmitEngineError(
  onEngineError: ((event: MCPJamEngineErrorEvent) => void) | undefined,
  event: MCPJamEngineErrorEvent
) {
  if (!onEngineError) return;
  safelyInvoke("[mcpjam-stream-handler] onEngineError", () =>
    onEngineError(event)
  );
}

/**
 * Process the SSE stream from Convex and extract content parts.
 * Forwards relevant chunks to the client while building up the message content.
 */
async function processStream(
  body: ReadableStream<Uint8Array>,
  writer: StepContext["writer"],
  normalizeToolCallId: (toolCallId?: string) => string,
  traceTurn: LiveTraceTurnContext,
  stepIndex: number,
  tools: ToolSet,
  requireToolApproval?: boolean,
  onLiveTextDelta?: (delta: string) => void,
  abortSignal?: AbortSignal,
  progressivePlan?: ProgressiveToolPlan,
  // PR 5b-pre: chunk-level callbacks. Optional; only fired when
  // supplied. Chat / synthetic omit (handler still writes the UI
  // chunk + trace event unchanged).
  onToolCall?: (event: MCPJamToolCallEvent) => void,
  uiToolApprovals?: UiToolApprovalClassification
): Promise<StreamResult> {
  const contentParts: PersistedAssistantPart[] = [];
  let pendingText = "";
  let pendingReasoning = "";
  let pendingReasoningId: string | null = null;
  let hasToolCalls = false;
  let finishChunk: UIMessageChunk | null = null;
  let firstChunkAt: number | undefined;

  const flushText = () => {
    if (pendingText) {
      contentParts.push({ type: "text", text: pendingText });
      pendingText = "";
    }
  };

  const flushReasoning = () => {
    if (pendingReasoning) {
      contentParts.push({
        type: "reasoning",
        text: pendingReasoning,
        state: "done",
      });
      pendingReasoning = "";
    }
    pendingReasoningId = null;
  };

  const parsedStream = parseJsonEventStream({
    stream: body,
    schema: streamChunkSchema as any,
  });
  const reader = parsedStream.getReader();

  // Wire abort to reader cancellation so `reader.read()` unblocks
  // immediately when the client disconnects. The listener is removed in the
  // finally below to prevent leaks across steps.
  let abortListener: (() => void) | undefined;
  if (abortSignal) {
    if (abortSignal.aborted) {
      reader.cancel().catch(() => undefined);
    } else {
      abortListener = () => {
        reader.cancel().catch(() => undefined);
      };
      abortSignal.addEventListener("abort", abortListener, { once: true });
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      if (!value?.success) {
        // PR 5b-followup-2 review fix (CodeRabbit Major "Parser failures
        // still bypass onEngineError and the real failure path"): the
        // pre-fix shape wrote an error UI chunk and `break`'d out of
        // the loop. processStream then returned NORMALLY with whatever
        // contentParts had accumulated, processOneStep ran its
        // post-stream epilogue, and the outer agentic loop marked the
        // turn successful (runSucceeded = true) — `onEngineError`
        // never fired and the eval runner's failure detection didn't
        // trip. Throw instead so the failure lands in
        // `runChatEngineLoop`'s outer catch, which fires
        // `onEngineError` (site #3), writes the error+turn_finish
        // trace events, and skips the success epilogue. The thrown
        // Error carries the parser's message so the engine-error
        // contract stays consistent.
        const parseErr = (value as { error?: unknown })?.error;
        throw parseErr instanceof Error
          ? parseErr
          : new Error(
              typeof parseErr === "object" &&
              parseErr !== null &&
              "message" in parseErr &&
              typeof (parseErr as { message?: unknown }).message === "string"
                ? (parseErr as { message: string }).message
                : "stream parse failed"
            );
      }

      const chunk = value.value as UIMessageChunk & {
        totalUsage?: {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        };
        [key: string]: unknown;
      };

      if (firstChunkAt === undefined) {
        firstChunkAt = Date.now();
      }

      // Skip backend stub tool outputs - we execute tools locally
      if (
        chunk?.type === "tool-output-available" ||
        chunk?.type === "tool-output-error"
      ) {
        continue;
      }

      // Handle chunk by type
      switch (chunk?.type) {
        case "text-start":
          flushReasoning();
          flushText();
          writer.write(chunk);
          break;

        case "text-delta":
          flushReasoning();
          pendingText += chunk.delta ?? "";
          if (chunk.delta) {
            safelyEmitLiveTextDelta(onLiveTextDelta, chunk.delta);
          }
          writer.write(chunk);
          if (chunk.delta) {
            writeTraceEvent(writer, {
              type: "text_delta",
              turnId: traceTurn.turnId,
              promptIndex: traceTurn.promptIndex,
              stepIndex,
              delta: chunk.delta,
            });
          }
          break;

        case "text-end":
          flushText();
          writer.write(chunk);
          break;

        case "reasoning-start":
          flushText();
          flushReasoning();
          pendingReasoningId = chunk.id;
          writer.write(chunk);
          break;

        case "reasoning-delta":
          flushText();
          if (pendingReasoningId !== null && chunk.id !== pendingReasoningId) {
            flushReasoning();
          }
          pendingReasoningId = chunk.id;
          pendingReasoning += chunk.delta ?? "";
          writer.write(chunk);
          break;

        case "reasoning-end":
          if (pendingReasoningId !== null && chunk.id !== pendingReasoningId) {
            flushReasoning();
            pendingReasoningId = chunk.id;
          }
          flushReasoning();
          writer.write(chunk);
          break;

        case "tool-input-start":
        case "tool-input-delta":
        case "tool-input-error": {
          flushText();
          flushReasoning();
          const toolCallId = normalizeToolCallId(chunk.toolCallId);
          writer.write({ ...chunk, toolCallId });
          break;
        }

        case "tool-input-available": {
          flushText();
          flushReasoning();
          const toolCallId = normalizeToolCallId(chunk.toolCallId);
          const serverIdForToolCall = readToolServerId(tools, chunk.toolName);
          const providerMetadata = mergeMcpToolOriginMetadata(
            chunk.providerMetadata,
            serverIdForToolCall
          );
          contentParts.push({
            type: "tool-call",
            toolCallId,
            toolName: chunk.toolName,
            input: chunk.input ?? {},
            ...(providerMetadata ? { providerOptions: providerMetadata } : {}),
          });
          hasToolCalls = true;
          writer.write({
            ...chunk,
            toolCallId,
            ...(providerMetadata ? { providerMetadata } : {}),
          });
          writeTraceEvent(writer, {
            type: "tool_call",
            turnId: traceTurn.turnId,
            promptIndex: traceTurn.promptIndex,
            stepIndex,
            toolCallId,
            toolName: chunk.toolName,
            input: toTraceRecord(chunk.input),
            serverId: serverIdForToolCall,
          });
          // PR 5b-pre: fire chunk-level callback so eval's backend
          // stream runner (PR 5b) can emit the `tool_call` SSE event.
          // Chat / synthetic don't supply this callback.
          if (onToolCall) {
            try {
              onToolCall({
                toolCallId,
                toolName: chunk.toolName,
                input: chunk.input,
                stepIndex,
                promptIndex: traceTurn.promptIndex,
                serverId: serverIdForToolCall,
              });
            } catch (error) {
              logger.warn(
                "[mcpjam-stream-handler] onToolCall callback failed",
                {
                  error: error instanceof Error ? error.message : String(error),
                }
              );
            }
          }

          if (
            toolCallNeedsApproval(
              chunk.toolName,
              progressivePlan,
              uiToolApprovals,
              requireToolApproval
            )
          ) {
            emitToolApprovalRequest(writer, {
              approvalId: generateToolCallId(),
              toolCallId,
            });
          }
          break;
        }

        case "start":
          // Skip Convex's start chunk — its messageId would override the
          // SDK's message identity, causing a new assistant message instead
          // of continuing the existing one.
          break;

        case "finish":
          finishChunk = chunk;
          // Don't write finish yet - wait until we know we're done
          break;

        case "error": {
          // The backend's OTHER failure delivery path, and the one HTTP status
          // can never see. `toUIMessageStreamResponse({onError})` categorizes
          // the failure and serializes it into an error PART on a stream whose
          // headers already said 200 — including `mcpjam_api_error` /
          // `mcpjam_rate_limit`, i.e. OUR outage.
          //
          // This used to fall into `default:` and be forwarded verbatim.
          // processStream then returned NORMALLY, processOneStep ran its
          // success epilogue, and the outer loop set `runSucceeded = true`:
          // the user saw an error while telemetry recorded a completed turn,
          // and the turn was persisted as a good conversation. Exactly the
          // bug already fixed for parser failures a few lines above — same
          // remedy, same reason.
          //
          // Throw so it lands in `runChatEngineLoop`'s outer catch (site 3),
          // which owns the whole failure ritual: error chunk, trace events,
          // `onEngineError`, and the reporter. Deliberately NOT forwarded
          // here — site 3's `emitError` writes the single error chunk, so the
          // wire still carries exactly one.
          const errorText =
            typeof (chunk as { errorText?: unknown }).errorText === "string"
              ? (chunk as { errorText: string }).errorText
              : String((chunk as { errorText?: unknown }).errorText ?? "");
          const parsed = parseStreamErrorChunkText(errorText);
          // Classified HERE, where the structured body still exists. By the
          // time site 3 sees this it is an Error whose message is a sentence;
          // `describeError` could not recover the guardrail code, and the
          // ownership verdict depends on it. NOT the non-OK classifier: this
          // `statusCode` is the upstream provider's, not our backend's — see
          // {@link describeStreamErrorChunkFailure}.
          const normalized = describeStreamErrorChunkFailure(
            parsed.statusCode,
            errorText,
            parsed.code
          );
          throw Object.assign(new Error(parsed.message), {
            normalized,
            ...(parsed.code ? { failureCode: parsed.code } : {}),
          });
        }

        default:
          // Forward other chunks (step-start, etc.)
          writer.write(chunk);
      }
    }
  } finally {
    if (abortListener && abortSignal) {
      abortSignal.removeEventListener("abort", abortListener);
    }
    reader.releaseLock();
  }

  flushText();
  flushReasoning();
  // If we exited the read loop because of an abort, surface it so the
  // caller can take the silent-cancellation path (no error, no finish).
  if (abortSignal?.aborted) {
    throw abortSignal.reason instanceof Error
      ? abortSignal.reason
      : Object.assign(new Error("Aborted"), { name: "AbortError" });
  }
  return { contentParts, hasToolCalls, finishChunk, firstChunkAt };
}

/**
 * Emit tool results to the client stream.
 * Called after tools have been executed locally.
 */
async function emitToolResults(
  writer: StepContext["writer"],
  mcpClientManager: MCPClientManager,
  newMessages: ModelMessage[],
  traceTurn?: LiveTraceTurnContext,
  stepIndex?: number,
  // PR 5b-pre: optional chunk-level callback so eval's backend stream
  // runner (PR 5b) can emit the `tool_result` SSE event. Chat /
  // synthetic don't supply this callback — the UI writer + trace event
  // still fire unchanged. PR 14: a returned promise is awaited so the
  // eval render hook completes before the engine's next step.
  onToolResult?: (event: MCPJamToolResultEvent) => void | Promise<void>
): Promise<void> {
  for (const msg of newMessages) {
    if (msg?.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      for (const part of toolMsg.content) {
        if (part.type === "tool-result") {
          const toolName =
            typeof (part as any).toolName === "string"
              ? ((part as any).toolName as string)
              : undefined;
          const serverId =
            typeof (part as any).serverId === "string"
              ? ((part as any).serverId as string)
              : undefined;
          // Some tool outputs have a model-facing `output` and a raw MCP
          // `result`. UI must use the raw result when the model-facing copy
          // drops fields widgets need (structuredContent) or turns images into
          // media parts for the model.
          const rawResult = (part as any).result;
          const rawOutput =
            rawResult &&
            typeof rawResult === "object" &&
            ("structuredContent" in rawResult ||
              isModelVisibleImageOutput(part.output))
              ? rawResult
              : part.output ?? rawResult;

          let outputForUi: unknown = rawOutput;
          if (rawOutput && typeof rawOutput === "object") {
            const rawOutputObj = rawOutput as Record<string, unknown>;
            const existingMeta =
              rawOutputObj._meta &&
              typeof rawOutputObj._meta === "object" &&
              rawOutputObj._meta !== null
                ? (rawOutputObj._meta as Record<string, unknown>)
                : {};
            const toolMeta =
              serverId && toolName
                ? mcpClientManager.getAllToolsMetadata(serverId)[toolName] ?? {}
                : {};

            // Include descriptor metadata in streamed output so shared/minimal chat
            // can render app widgets without a tools/list prefetch.
            outputForUi = {
              ...rawOutputObj,
              _meta: {
                ...toolMeta,
                ...existingMeta,
                ...(serverId ? { _serverId: serverId } : {}),
              },
            };
          }

          // Prefer full result (with _meta/structuredContent) for UI. No
          // providerExecuted: emulated tools are client/Convex-executed.
          emitToolOutput(writer, {
            toolCallId: part.toolCallId,
            output: outputForUi,
          });

          if (traceTurn && typeof stepIndex === "number") {
            const errorText =
              part.output?.type === "error-text" &&
              typeof part.output.value === "string"
                ? part.output.value
                : undefined;
            writeTraceEvent(writer, {
              type: "tool_result",
              turnId: traceTurn.turnId,
              promptIndex: traceTurn.promptIndex,
              stepIndex,
              toolCallId: part.toolCallId,
              toolName: toolName ?? part.toolName ?? "unknown",
              output: outputForUi,
              errorText,
              serverId,
            });
            // PR 5b-pre: fire chunk-level callback. `isError` matches
            // the AI SDK's error-text output discriminator (same shape
            // PR 5a's adapter uses for its `tool_result` SSE event).
            if (onToolResult) {
              try {
                await onToolResult({
                  toolCallId: part.toolCallId,
                  toolName: toolName ?? part.toolName,
                  output: outputForUi,
                  // PR 14: raw implementation result (unscrubbed) for the
                  // eval widget render hook; absent on parts without the
                  // `result:` UI-hydration extra.
                  rawResult: (part as { result?: unknown }).result,
                  isError: part.output?.type === "error-text",
                  stepIndex,
                  promptIndex: traceTurn.promptIndex,
                  serverId,
                });
              } catch (error) {
                logger.warn(
                  "[mcpjam-stream-handler] onToolResult callback failed",
                  {
                    error:
                      error instanceof Error ? error.message : String(error),
                  }
                );
              }
            }
          }
        }
      }
    }
  }
}

/**
 * Emit tool-input-available events for inherited unresolved tool calls.
 * These are tool calls from previous messages that haven't been executed yet.
 */
function emitInheritedToolCalls(
  writer: StepContext["writer"],
  messageHistory: ModelMessage[],
  beforeStepLength: number,
  // PR 5b-pre review fix (Cursor Medium "Resumed approvals skip
  // onToolCall"): symmetric counterpart of the denial-path
  // `onToolResult` fix. This path writes `tool-input-available` UI
  // chunks for inherited unresolved calls — eval's PR 5b wiring needs
  // `onToolCall` to fire here too, otherwise it would see orphan
  // `tool_result` events later without a matching `tool_call`.
  tools?: ToolSet,
  traceTurn?: LiveTraceTurnContext,
  stepIndex?: number,
  onToolCall?: (event: MCPJamToolCallEvent) => void
) {
  // Collect existing tool result IDs
  const existingResultIds = new Set<string>();
  for (const msg of messageHistory) {
    if (msg?.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      for (const part of toolMsg.content) {
        if (part.type === "tool-result") {
          existingResultIds.add(part.toolCallId);
        }
      }
    }
  }

  // Emit for inherited tool calls (before this step) that don't have results
  for (let i = 0; i < beforeStepLength; i++) {
    const msg = messageHistory[i];
    if (msg?.role === "assistant") {
      const assistantMsg = msg as AssistantModelMessage;
      if (!Array.isArray(assistantMsg.content)) continue;
      for (const part of assistantMsg.content) {
        if (
          part.type === "tool-call" &&
          !existingResultIds.has(part.toolCallId)
        ) {
          emitToolInput(writer, {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input ?? {},
            ...(part.providerOptions
              ? { providerMetadata: part.providerOptions }
              : {}),
          });
          // PR 5b-pre review fix (Cursor Medium): fire `onToolCall`
          // for inherited unresolved calls so PR 5b's eval wiring
          // sees a matching `tool_call` before any `tool_result`.
          if (onToolCall && traceTurn && typeof stepIndex === "number") {
            try {
              onToolCall({
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
                stepIndex,
                promptIndex: traceTurn.promptIndex,
                serverId: tools
                  ? readToolServerId(tools, part.toolName)
                  : undefined,
              });
            } catch (error) {
              logger.warn(
                "[mcpjam-stream-handler] onToolCall callback failed (inherited)",
                {
                  error: error instanceof Error ? error.message : String(error),
                }
              );
            }
          }
        }
      }
    }
  }
}

/**
 * Handle pending tool approvals from the previous request.
 * When the client responds with approval/denial decisions, this function
 * processes them: executes approved tools and emits denied notifications.
 *
 * Returns true if approvals were found and handled (agentic loop should continue).
 */
async function handlePendingApprovals(
  writer: StepContext["writer"],
  messageHistory: ModelMessage[],
  tools: ToolSet,
  mcpClientManager: MCPClientManager,
  traceTurn?: LiveTraceTurnContext,
  stepIndex?: number,
  abortSignal?: AbortSignal,
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults,
  // PR 5b-pre: propagate the chunk-level callbacks so denial /
  // resumed-approval / approved-tool-result emissions all fire them.
  onToolResult?: (event: MCPJamToolResultEvent) => void | Promise<void>,
  // PR 5b-pre review fix (Cursor Medium): resumed-approval branch
  // emits `tool-input-available` UI chunks — `onToolCall` must fire
  // here too so PR 5b's wiring doesn't see orphan `tool_result`.
  onToolCall?: (event: MCPJamToolCallEvent) => void
): Promise<boolean> {
  // Build approvalId → toolCallId map, toolCallId → toolName map,
  // and toolCallId → assistant message index map from assistant messages
  const approvalIdToToolCallId = new Map<string, string>();
  const toolCallIdToToolName = new Map<string, string>();
  const toolCallIdToAssistantIdx = new Map<string, number>();
  for (let i = 0; i < messageHistory.length; i++) {
    const msg = messageHistory[i];
    if (msg?.role === "assistant") {
      const assistantMsg = msg as AssistantModelMessage;
      if (!Array.isArray(assistantMsg.content)) continue;
      for (const part of assistantMsg.content) {
        if (part.type === "tool-approval-request" && part.approvalId) {
          approvalIdToToolCallId.set(part.approvalId, part.toolCallId);
        }
        if (part.type === "tool-call" && part.toolCallId) {
          toolCallIdToToolName.set(part.toolCallId, part.toolName);
          toolCallIdToAssistantIdx.set(part.toolCallId, i);
        }
      }
    }
  }

  if (approvalIdToToolCallId.size === 0) return false;

  // Scan tool messages for approval responses
  const approvedToolCallIds = new Set<string>();
  const deniedToolCallIds = new Set<string>();

  for (const msg of messageHistory) {
    if (msg?.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      for (const part of toolMsg.content) {
        if (part.type === "tool-approval-response" && part.approvalId) {
          const toolCallId = approvalIdToToolCallId.get(part.approvalId);
          if (!toolCallId) continue;

          if (part.approved) {
            approvedToolCallIds.add(toolCallId);
          } else {
            deniedToolCallIds.add(toolCallId);
          }
        }
      }
    }
  }

  if (approvedToolCallIds.size === 0 && deniedToolCallIds.size === 0) {
    return false;
  }

  // Collect existing tool-result IDs once to avoid re-processing approvals
  const existingResultIds = new Set<string>();
  for (const msg of messageHistory) {
    if (msg?.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      for (const part of toolMsg.content) {
        if (part.type === "tool-result") {
          existingResultIds.add(part.toolCallId);
        }
      }
    }
  }

  let didHandle = false;

  // Emit denied tool notifications to the client and add tool-result entries
  // to messageHistory so the LLM knows which tools were denied.
  // NOTE: convertToModelMessages does NOT produce tool-results for denied tools
  // because the client-side state is 'approval-responded', not 'output-denied'.
  if (deniedToolCallIds.size > 0) {
    // Group denied results by assistant message index
    const deniedByAssistantIdx = new Map<number, ToolResultPart[]>();

    for (const toolCallId of deniedToolCallIds) {
      if (existingResultIds.has(toolCallId)) continue;
      const toolName = toolCallIdToToolName.get(toolCallId) ?? "unknown";
      emitToolOutputDenied(writer, { toolCallId });

      if (traceTurn && typeof stepIndex === "number") {
        writeTraceEvent(writer, {
          type: "tool_result",
          turnId: traceTurn.turnId,
          promptIndex: traceTurn.promptIndex,
          stepIndex,
          toolCallId,
          toolName,
          output: {
            type: "error-text",
            value: "Tool execution denied by user.",
          },
          errorText: "Tool execution denied by user.",
        });
        // PR 5b-pre review fix (Cursor Medium "Denied approval skips
        // onToolResult"): the denial path writes the trace event
        // inline without going through `emitToolResults`, so the
        // `onToolResult` callback wasn't firing. Auto-deny via
        // `processOneStep` does fire it through the
        // `emitToolResults` → callback chain; denial via
        // `handlePendingApprovals` needs the symmetric call here so
        // PR 5b's eval wiring sees `tool_result` SSE events for
        // denied tools on resumed approval turns.
        if (onToolResult) {
          try {
            await onToolResult({
              toolCallId,
              toolName,
              output: {
                type: "error-text",
                value: "Tool execution denied by user.",
              },
              isError: true,
              stepIndex,
              promptIndex: traceTurn.promptIndex,
              serverId: undefined,
            });
          } catch (error) {
            logger.warn(
              "[mcpjam-stream-handler] onToolResult callback failed (denial path)",
              {
                error: error instanceof Error ? error.message : String(error),
              }
            );
          }
        }
      }

      const part: ToolResultPart = {
        type: "tool-result",
        toolCallId,
        toolName,
        output: {
          type: "error-text",
          value: "Tool execution denied by user.",
        },
      };

      const assistantIdx = toolCallIdToAssistantIdx.get(toolCallId);
      if (assistantIdx !== undefined) {
        if (!deniedByAssistantIdx.has(assistantIdx))
          deniedByAssistantIdx.set(assistantIdx, []);
        deniedByAssistantIdx.get(assistantIdx)!.push(part);
      }
    }

    if (deniedByAssistantIdx.size > 0) {
      // Insert right after corresponding assistant messages (reverse order to preserve indices)
      const sortedKeys = [...deniedByAssistantIdx.keys()].sort((a, b) => b - a);
      for (const idx of sortedKeys) {
        messageHistory.splice(idx + 1, 0, {
          role: "tool",
          content: deniedByAssistantIdx.get(idx)!,
        } as ModelMessage);
      }
      didHandle = true;
    }
  }

  // Execute approved tools: collect tool calls that were approved but don't have results yet.
  // NOTE: This must run AFTER denied results are spliced in above.
  // executeToolCallsFromMessages skips tool-call IDs that already have results
  // (via existingToolResultIds), so the denied results prevent double-execution.
  const needsExecution = [...approvedToolCallIds].some(
    (id) => !existingResultIds.has(id)
  );

  if (needsExecution) {
    // Emit tool-input-available for approved tool calls so the AI SDK client
    // can attach the upcoming tool-output-available chunks. Without this, the
    // stream consumer throws "No tool invocation found for tool call ID …"
    // because the matching tool-call was on a prior assistant message and
    // this resumed stream hasn't introduced it yet.
    for (const toolCallId of approvedToolCallIds) {
      if (existingResultIds.has(toolCallId)) continue;
      const assistantIdx = toolCallIdToAssistantIdx.get(toolCallId);
      if (assistantIdx === undefined) continue;
      const assistantMsg = messageHistory[
        assistantIdx
      ] as AssistantModelMessage;
      if (!Array.isArray(assistantMsg.content)) continue;
      for (const part of assistantMsg.content) {
        if (part.type === "tool-call" && part.toolCallId === toolCallId) {
          emitToolInput(writer, {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input ?? {},
            ...(part.providerOptions
              ? { providerMetadata: part.providerOptions }
              : {}),
          });
          // PR 5b-pre review fix (Cursor Medium "Resumed approvals
          // skip onToolCall"): fire `onToolCall` for resumed approved
          // tools so PR 5b's eval wiring sees a matching `tool_call`
          // before the `tool_result` `emitToolResults` produces below.
          if (onToolCall && traceTurn && typeof stepIndex === "number") {
            try {
              onToolCall({
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
                stepIndex,
                promptIndex: traceTurn.promptIndex,
                serverId: readToolServerId(tools, part.toolName),
              });
            } catch (error) {
              logger.warn(
                "[mcpjam-stream-handler] onToolCall callback failed (approval)",
                {
                  error: error instanceof Error ? error.message : String(error),
                }
              );
            }
          }
          break;
        }
      }
    }

    const newMessages = await executeToolCallsFromMessages(messageHistory, {
      tools: tools as Record<string, any>,
      modelVisibleMcpToolResults,
      readLinkedResource: readLinkedMcpResourceWithManager(mcpClientManager),
      // Defense-in-depth for client-fulfilled tools (app_*/ui_*): the client
      // resolves an APPROVED ui_* call by executing it and shipping the
      // tool-result directly, so an approval response without a result
      // should never reach us — but if a stale client sends one anyway,
      // skip the no-execute entry (the loop re-pauses for client
      // fulfillment) instead of throwing and 500ing the whole turn.
      skipNonExecutableTools: true,
      ...(abortSignal ? { abortSignal } : {}),
    });

    await emitToolResults(
      writer,
      mcpClientManager,
      newMessages,
      traceTurn,
      stepIndex,
      onToolResult
    );
    didHandle = true;
  }

  return didHandle;
}

/**
 * Process a single step of the agentic loop.
 * Calls Convex, streams the response, and executes tools if needed.
 */
async function processOneStep(
  ctx: StepContext
): Promise<{ shouldContinue: boolean; didEmitFinish: boolean }> {
  const {
    writer,
    messageHistory,
    toolDefs,
    toolDefsByName,
    tools,
    authHeader,
    scenarioId,
    accessVersion,
    projectId,
    modelId,
    provider,
    systemPrompt,
    temperature,
    mcpClientManager,
    selectedServers,
    requireToolApproval,
    uiToolApprovals,
    modelVisibleMcpToolResults,
    approvalMode,
    stepIndex,
    usedToolCallIds,
    traceTurn,
    progressivePlan,
    discoveryState,
    // PR 5b-pre chunk-level callbacks (optional, propagated from
    // MCPJamHandlerOptions through runChatEngineLoop).
    onToolCall,
    onToolResult,
    // PR 5b-followup-2 structured-error callback.
    onEngineError,
    failureReporter,
    // Browser-rendered MCP App eval PR 2: advertised-tool narrowing hook.
    prepareAdvertisedTools,
  } = ctx;

  // Pick the active tool subset for this step. In non-progressive mode
  // (`progressivePlan` undefined or plan.enabled === false) this collapses
  // to the full list and matches prior behavior. In progressive mode the
  // model only sees meta-tools + loaded + pending-approval + newly-loaded —
  // PLUS tools injected into the map after the catalog was built (e.g. the
  // eval Computer Use tools, PR 14): they have no catalog toolId, so
  // `load_mcp_tools` can never activate them and dropping them here would
  // make them permanently invisible. Their per-step visibility stays
  // governed by `prepareAdvertisedTools` below (parity with
  // direct-chat-turn's `withInjectedTools`).
  let activeToolDefs: ToolDefinition[] =
    progressivePlan && progressivePlan.enabled && discoveryState
      ? (() => {
          const activeNames = resolveActiveToolNames(
            progressivePlan,
            discoveryState
          );
          const cataloged = new Set(
            progressivePlan.catalog.map((entry) => entry.modelName)
          );
          const seen = new Set(activeNames);
          for (const def of toolDefs) {
            if (!cataloged.has(def.name) && !seen.has(def.name)) {
              activeNames.push(def.name);
            }
          }
          return activeNames
            .map((name) => toolDefsByName.get(name))
            .filter((def): def is ToolDefinition => def !== undefined);
        })()
      : toolDefs;

  // Browser-rendered MCP App eval PR 2: runtime-conditional advertised-tool
  // narrowing. The hook receives the names that would otherwise be advertised
  // this step (`defaultToolNames`) and returns the subset to keep, or
  // `undefined` for no narrowing. Filtering against the resolved set means any
  // returned name not already advertised is ignored (defense-in-depth), and a
  // throw is logged + falls back to the default set so a buggy hook can't
  // crash the loop. Applied here so both the request_payload trace snapshot
  // and the Convex `/stream` request see the same narrowed set.
  if (prepareAdvertisedTools) {
    const advertised = new Set(
      applyPrepareAdvertisedTools({
        defaultToolNames: activeToolDefs.map((def) => def.name),
        stepIndex,
        prepareAdvertisedTools,
        onWarn: (message, meta) =>
          logger.warn(`[mcpjam-stream-handler] ${message}`, meta),
      })
    );
    activeToolDefs = activeToolDefs.filter((def) => advertised.has(def.name));
  }

  const forcedToolChoice =
    shouldForceInitialToolSearch(progressivePlan, discoveryState, stepIndex) &&
    activeToolDefs.some((def) => def.name === META_TOOL_SEARCH)
      ? { type: "tool" as const, toolName: META_TOOL_SEARCH }
      : undefined;

  const { abortSignal } = ctx;
  if (abortSignal?.aborted) {
    throw abortSignal.reason instanceof Error
      ? abortSignal.reason
      : Object.assign(new Error("Aborted"), { name: "AbortError" });
  }

  const beforeStepLength = messageHistory.length;
  const stepStartAbs = Date.now();
  const llmStartAbs = stepStartAbs;
  const providerSystemPrompt = normalizeSystemPromptForProvider(systemPrompt);

  // Scrub messages before sending to backend. Preserve reasoning on
  // assistant messages added during the current turn so thinking models can
  // see their own scratchpad across tool steps.
  const scrubbedMessages = scrubMessagesForBackend(
    messageHistory,
    tools,
    mcpClientManager,
    selectedServers,
    traceTurn.promptMessageStartIndex
  );

  const normalizeToolCallId = createToolCallIdNormalizer(
    usedToolCallIds,
    stepIndex
  );

  // The trace payload must reflect the *advertised* subset — `activeToolDefs`
  // after BOTH progressive-discovery narrowing AND the prepareAdvertisedTools
  // hook — so request_payload snapshots match what Convex actually received in
  // `tools: activeToolDefs` below. Derived unconditionally: in the no-narrowing
  // case `activeToolDefs === toolDefs`, so this reconstructs the full set.
  const toolsForPayload: ToolSet = Object.fromEntries(
    activeToolDefs
      .map((def): [string, unknown] | null => {
        const t = (tools as Record<string, unknown>)[def.name];
        return t === undefined ? null : [def.name, t];
      })
      .filter((pair): pair is [string, unknown] => pair !== null)
  ) as ToolSet;

  emitRequestPayload(writer, {
    turnId: traceTurn.turnId,
    promptIndex: traceTurn.promptIndex,
    stepIndex,
    payload: buildResolvedModelRequestPayload({
      systemPrompt,
      tools: toolsForPayload,
      messages: scrubbedMessages,
    }),
  });

  // Call the Convex streaming endpoint. The default endpoint is /stream
  // (MCPJam-provided models); org BYOK chat targets /stream/org and adds
  // provider/project fields via extraBodyFields.
  const {
    endpointPath,
    extraHeaders,
    extraBodyFields,
    chatSessionId,
    sourceType,
    clientIp,
    onLiveTextDelta,
  } = ctx;
  // Hash the originating IP for the per-IP daily spend cap. Hashing here
  // (server-side) keeps the raw IP off the wire to Convex. If no hash can be
  // produced, omit the header so Convex uses its cookie-only guest fallback
  // instead of pooling unrelated guests in a shared unknown-IP bucket.
  const ipHash = clientIp ? await hashGuestSpendIp(clientIp) : null;
  const convexHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...(authHeader ? { authorization: authHeader } : {}),
    ...(extraHeaders ?? {}),
  };
  for (const header of Object.keys(convexHeaders)) {
    if (header.toLowerCase() === GUEST_IP_HASH_HEADER) {
      delete convexHeaders[header];
    }
  }
  if (ipHash) {
    convexHeaders[GUEST_IP_HASH_HEADER] = ipHash;
  }
  let res: Response;
  try {
    res = await fetch(`${process.env.CONVEX_HTTP_URL}${endpointPath}`, {
      method: "POST",
      headers: convexHeaders,
      body: JSON.stringify({
        mode: "stream",
        // Persist only once at the end of the full agentic loop via
        // onConversationComplete to avoid storing partial per-step traces.
        skipChatIngestion: true,
        messages: JSON.stringify(scrubbedMessages),
        model: modelId,
        systemPrompt: providerSystemPrompt,
        ...(temperature !== undefined ? { temperature } : {}),
        tools: activeToolDefs,
        ...(scenarioId ? { scenarioId } : {}),
        ...(scenarioId && Number.isFinite(accessVersion)
          ? { accessVersion }
          : {}),
        ...(projectId ? { projectId } : {}),
        ...(chatSessionId ? { chatSessionId } : {}),
        ...(sourceType ? { sourceType } : {}),
        turnId: traceTurn.turnId,
        promptIndex: traceTurn.promptIndex,
        stepIndex,
        ...(forcedToolChoice ? { toolChoice: forcedToolChoice } : {}),
        ...(extraBodyFields ?? {}),
      }),
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
  } catch (error) {
    // AbortError on fetch is the standard cancellation signal — propagate
    // it without writing a fail span. Real network errors fall through to
    // the existing failure path via the !res.ok branch (we synthesize a
    // 500-shaped error below for parity).
    if (isAbortError(error)) {
      throw error;
    }
    throw error;
  }

  // A 200 OK with Content-Type: application/json is a non-stream denial
  // (e.g. spend-precheck: `{ok:false, code:"user_rate_limit", ...}`).
  // Treat it the same as a non-OK response so `onEngineError` fires and the
  // turn does not silently complete with an empty reply (issue #3708).
  // `res.headers?` — not every caller hands us a real `Response`. The eval
  // runner's tests stub `{ok, status, body, text}` with no `headers`, and an
  // unguarded `.get` throws a TypeError that the outer catch converts into a
  // failed turn (7 evals-runner / runner-parity tests).
  const isJsonDenial =
    res.ok &&
    !!res.body &&
    !!res.headers?.get("content-type")?.includes("application/json");
  if (!res.ok || !res.body || isJsonDenial) {
    const errorText = await res.text().catch(() => "stream failed");
    const failAbs = Date.now();
    const stepMessageEndIndex =
      messageHistory.length > traceTurn.promptMessageStartIndex
        ? messageHistory.length - 1
        : undefined;
    pushBackendStepLlmFailureSpans(
      traceTurn.turnSpans,
      traceTurn.turnStartedAt,
      traceTurn.promptIndex,
      stepIndex,
      stepStartAbs,
      llmStartAbs,
      failAbs,
      {
        modelId,
        messageStartIndex:
          stepMessageEndIndex != null
            ? traceTurn.promptMessageStartIndex
            : undefined,
        messageEndIndex: stepMessageEndIndex,
      }
    );
    setStepSpanMessageRanges(
      traceTurn.turnSpans,
      traceTurn.promptIndex,
      stepIndex,
      stepMessageEndIndex != null
        ? traceTurn.promptMessageStartIndex
        : undefined,
      stepMessageEndIndex
    );
    emitTraceSnapshot(writer, messageHistory, tools, traceTurn);
    writeTraceEvent(writer, {
      type: "error",
      turnId: traceTurn.turnId,
      promptIndex: traceTurn.promptIndex,
      stepIndex,
      errorText,
    });
    emitError(writer, errorText);
    // PR 5b-followup-2: surface the structured guardrail body to
    // `streamSink: "none"` consumers (eval backend stream runner). The
    // writer-side `error` chunk above is fire-and-forget here; the
    // callback gives the eval runner the parsed
    // `{ code?, error, details? }` shape so it can show the actual
    // 429 reason on its SSE error event instead of the generic
    // "Backend stream failed during iteration" fallback.
    const parsed = parseEngineErrorBody(res.status, errorText);
    // Site (1): no Error object exists here, so classify from the response
    // itself. A 5xx from our own backend is the hosted-502 class — capture it,
    // because nothing downstream of this point ever will. `parsed.code` is
    // passed because the status can be the UPSTREAM provider's, mirrored onto
    // our response: only the code distinguishes MCPJam's own revoked key
    // (401 `mcpjam_api_error`) from the caller's missing session (401
    // `auth_required`).
    const normalized = describeBackendStreamFailure(
      res.status,
      errorText,
      parsed.code
    );
    // `isJsonDenial` proves only that the body was JSON — NOT that it was the
    // documented `{ok:false, code:"..."}` refusal, and "has any code at all"
    // is not enough either. The backend's error-code union includes
    // `mcpjam_rate_limit`, `mcpjam_api_error`, and `mcpjam_config_error`,
    // which name US as the responsible party; exempting them because they
    // happen to carry a code would silence exactly the failures worth paging
    // on. Only the codes below are user-owned refusals from a backend that is
    // working correctly, so only they skip the boundary.
    const isRecognizedDenial =
      isJsonDenial && USER_OWNED_DENIAL_CODES.has(parsed.code ?? "");
    // Through the reporter, not a bare capture call: reportRouteFailure runs
    // the same maybeCaptureOriginError decision (source becomes the identical
    // `route:mcp.chat-v2.backend-stream` Sentry tag), then a free-form Axiom
    // row, then the typed route.operation.failed event — the only record of
    // this failure that monitors can key on, since the response is a 200
    // stream the HTTP events never see.
    //
    // The hop is `mcpjam_internal` for a genuine TRANSPORT failure only, and
    // NOT for `isRecognizedDenial`. A denial is an HTTP 200 carrying a
    // structured refusal (`{ok:false, code:"user_rate_limit"}`) — the backend
    // working correctly, and a routine, user-owned outcome. Promoting it
    // would page the team on every ordinary spend-limit rejection, which is
    // precisely the noise class this work removes. On a real failure the
    // internal hop earns its place twice: it tags the event with the boundary
    // the rest of the codebase triages on, and it escalates an unrecognized
    // status from our own backend, which `describeBackendStreamFailure`
    // leaves `ambiguous` because it classifies the response alone and cannot
    // know whose backend answered.
    // Silent-cancel invariant: a fired abort can race this site (res.text()
    // rejecting into the generic fallback, or the failure landing while the
    // client is already gone). An aborted turn must not inflate the
    // operation-failure rate.
    if (!abortSignal?.aborted) {
      failureReporter({
        message: "[mcpjam-stream-handler] backend stream failed",
        error: new Error(parsed.message),
        source: "mcp.chat-v2.backend-stream",
        hop: isRecognizedDenial ? "user_server_hop" : "mcpjam_internal",
        transport: "http_stream",
        normalized,
        ...(parsed.code ? { errorCode: parsed.code } : {}),
        context: {
          httpStatus: res.status,
          code: parsed.code,
          isJsonDenial,
          isRecognizedDenial,
        },
      });
    }
    safelyEmitEngineError(onEngineError, {
      message: parsed.message,
      ...(parsed.code ? { code: parsed.code } : {}),
      ...(parsed.details ? { details: parsed.details } : {}),
      httpStatus: res.status,
      rawText: errorText,
      promptIndex: traceTurn.promptIndex,
      stepIndex,
      normalized,
    });
    return { shouldContinue: false, didEmitFinish: false };
  }

  // Process the stream
  const { contentParts, finishChunk, firstChunkAt } = await processStream(
    res.body,
    writer,
    normalizeToolCallId,
    traceTurn,
    stepIndex,
    tools,
    requireToolApproval,
    onLiveTextDelta,
    abortSignal,
    progressivePlan,
    onToolCall,
    uiToolApprovals
  );
  const llmEndAbs = Date.now();
  traceTurn.turnUsage = mergeLiveChatTraceUsage(
    traceTurn.turnUsage,
    readUsageFromFinishChunk(finishChunk)
  );

  // Update message history with assistant response
  if (contentParts.length > 0) {
    messageHistory.push({
      role: "assistant",
      content: contentParts,
    } as ModelMessage);
  }

  const stepMessageEndIndex =
    messageHistory.length > traceTurn.promptMessageStartIndex
      ? messageHistory.length - 1
      : undefined;
  const stepMessageStartIndex =
    stepMessageEndIndex != null ? traceTurn.promptMessageStartIndex : undefined;
  const stepUsage = readUsageFromFinishChunk(finishChunk);

  // GenAI harness metadata for this step's llm/step spans (OTel-aligned).
  // `finishChunk` is per-step, so `finishReason` is correct per step (e.g.
  // "tool-calls" on a tool step, "stop"/"length" on the terminal step). TTFC is
  // first-chunk relative to the LLM request start. Spread into every
  // pushBackendStepSuccessSpans call below.
  const harnessSpanMeta = {
    provider,
    finishReason: readFinishReasonFromChunk(finishChunk),
    ttfcMs:
      typeof firstChunkAt === "number"
        ? Math.max(0, firstChunkAt - llmStartAbs)
        : undefined,
  };

  // Check for unresolved tool calls and execute them
  if (hasUnresolvedToolCalls(messageHistory)) {
    // We only pause when at least one unresolved tool call actually needs
    // approval this turn (`toolCallNeedsApproval`): a real MCP tool while the
    // flag is on, or a destructive `ui_*` tool in any mode. Meta-tools
    // (search_mcp_tools / load_mcp_tools) never qualify — gating progressive
    // discovery itself behind N approvals defeats the point — so pure-meta
    // turns fall through to execute and continue the loop.
    const hasUnresolvedApprovalRequiredToolCall = (() => {
      const resultIds = new Set<string>();
      for (const msg of messageHistory) {
        if (msg?.role !== "tool") continue;
        for (const part of (msg as ToolModelMessage).content) {
          if (part.type === "tool-result") resultIds.add(part.toolCallId);
        }
      }
      for (const msg of messageHistory) {
        if (msg?.role !== "assistant") continue;
        const content = (msg as AssistantModelMessage).content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (
            part.type === "tool-call" &&
            !resultIds.has(part.toolCallId) &&
            toolCallNeedsApproval(
              part.toolName,
              progressivePlan,
              uiToolApprovals,
              requireToolApproval
            )
          ) {
            return true;
          }
        }
      }
      return false;
    })();

    if (hasUnresolvedApprovalRequiredToolCall && approvalMode === "auto-deny") {
      // Synthetic-session path: instead of pausing the loop for a
      // human approval that will never come, synthesize a denial
      // tool-result for every approval-required unresolved tool call
      // so the model can react and continue. Meta-tool calls in the
      // same step still execute normally below.
      const resultIds = new Set<string>();
      for (const msg of messageHistory) {
        if (msg?.role !== "tool") continue;
        for (const part of (msg as ToolModelMessage).content) {
          if (part.type === "tool-result") resultIds.add(part.toolCallId);
        }
      }
      const deniedByAssistantIdx = new Map<number, ToolResultPart[]>();
      for (let i = 0; i < messageHistory.length; i++) {
        const msg = messageHistory[i];
        if (msg?.role !== "assistant") continue;
        const content = (msg as AssistantModelMessage).content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (
            part.type !== "tool-call" ||
            resultIds.has(part.toolCallId) ||
            !toolCallNeedsApproval(
              part.toolName,
              progressivePlan,
              uiToolApprovals,
              requireToolApproval
            )
          ) {
            continue;
          }
          const denial: ToolResultPart = {
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: {
              type: "error-text",
              value: "approval-denied (synthetic session)",
            },
          };
          const bucket = deniedByAssistantIdx.get(i) ?? [];
          bucket.push(denial);
          deniedByAssistantIdx.set(i, bucket);
        }
      }
      if (deniedByAssistantIdx.size > 0) {
        const denialMessages: ModelMessage[] = [];
        const sortedKeys = [...deniedByAssistantIdx.keys()].sort(
          (a, b) => b - a
        );
        for (const idx of sortedKeys) {
          const denialContent = deniedByAssistantIdx.get(idx)!;
          const denialMsg = {
            role: "tool",
            content: denialContent,
          } as ModelMessage;
          messageHistory.splice(idx + 1, 0, denialMsg);
          denialMessages.push(denialMsg);
        }
        await emitToolResults(
          writer,
          mcpClientManager,
          denialMessages,
          traceTurn,
          stepIndex,
          onToolResult
        );
      }
      // Fall through to the normal tool-execution branch below so
      // meta-tools still run and the loop continues. The synthesized
      // denials count as resolved tool-results for the next step.
    }

    if (hasUnresolvedApprovalRequiredToolCall && approvalMode !== "auto-deny") {
      // Drain any unresolved meta-tool calls (search/load) before pausing
      // for approval on real tools. Otherwise mixed-step turns (model
      // emits a load_mcp_tools + a real tool in one assistant message)
      // leave the meta-tool unresolved through the approval pause, and
      // the resumed turn loses the discovery side effect — the loaded
      // tools never get promoted into `discoveryState.loadedToolIds`,
      // so the next step still only shows meta-tools.
      const metaTracedTools = wrapBackendToolsForTrace(
        tools as Record<string, any>,
        {
          runStartedAt: traceTurn.turnStartedAt,
          promptIndex: traceTurn.promptIndex,
          stepIndex,
          spans: traceTurn.turnSpans,
        }
      );
      const metaMessages = await executeToolCallsFromMessages(messageHistory, {
        tools: metaTracedTools as Record<string, any>,
        filterToolName: (name) =>
          isApprovalFreeMetaToolName(name, progressivePlan),
        modelVisibleMcpToolResults,
        readLinkedResource: readLinkedMcpResourceWithManager(mcpClientManager),
        ...(abortSignal ? { abortSignal } : {}),
      });
      if (metaMessages.length > 0) {
        await emitToolResults(
          writer,
          mcpClientManager,
          metaMessages,
          traceTurn,
          stepIndex,
          onToolResult
        );
        // Promote any ids the model just loaded so a subsequent
        // resumed-after-approval step sees them as loaded.
        if (progressivePlan?.enabled && discoveryState) {
          commitNewlyLoaded(discoveryState);
        }
      }

      pushBackendStepSuccessSpans(
        traceTurn.turnSpans,
        traceTurn.turnStartedAt,
        traceTurn.promptIndex,
        stepIndex,
        stepStartAbs,
        { startAbs: llmStartAbs, endAbs: llmEndAbs },
        undefined,
        {
          modelId,
          inputTokens: stepUsage?.inputTokens,
          outputTokens: stepUsage?.outputTokens,
          totalTokens: stepUsage?.totalTokens,
          messageStartIndex: stepMessageStartIndex,
          messageEndIndex: stepMessageEndIndex,
          status: "ok",
          ...harnessSpanMeta,
        }
      );
      setStepSpanMessageRanges(
        traceTurn.turnSpans,
        traceTurn.promptIndex,
        stepIndex,
        stepMessageStartIndex,
        stepMessageEndIndex
      );
      emitTraceSnapshot(writer, messageHistory, tools, traceTurn);
      if (finishChunk) {
        writer.write(createClientFinishChunk(finishChunk, traceTurn, "stop"));
      }
      return { shouldContinue: false, didEmitFinish: !!finishChunk };
    }

    // Emit inherited tool calls that need execution
    emitInheritedToolCalls(
      writer,
      messageHistory,
      beforeStepLength,
      tools,
      traceTurn,
      stepIndex,
      onToolCall
    );

    const toolsStartAbs = Date.now();
    try {
      const tracedTools = wrapBackendToolsForTrace(
        tools as Record<string, any>,
        {
          runStartedAt: traceTurn.turnStartedAt,
          promptIndex: traceTurn.promptIndex,
          stepIndex,
          spans: traceTurn.turnSpans,
        }
      );

      // Progressive mode: gate execution to the active subset. Visibility
      // is already narrowed by `activeToolDefs`, but a model can still
      // emit a remembered/hallucinated call to a non-active name; gating
      // turns that into a structured error the model can recover from
      // via `load_mcp_tools` instead of executing an ungated tool.
      let executableTools = gateToolsToActiveSubset(
        tracedTools as Record<string, unknown>,
        progressivePlan,
        () => discoveryState
      );
      // advertise = ENFORCE: when prepareAdvertisedTools narrowed the advertised
      // set (`activeToolDefs`), gate execution to it too so a remembered /
      // hallucinated call to a hidden tool (e.g. `computer` before a widget
      // renders) becomes a recoverable tool-error instead of executing.
      if (prepareAdvertisedTools) {
        const advertised = new Set(activeToolDefs.map((def) => def.name));
        executableTools = gateToolsToAdvertisedSubset(
          executableTools,
          () => advertised
        );
      }

      // Client-fulfilled tools (SEP-1865 app aliases + WebMCP `ui_*` and
      // `page_*` tools)
      // have no `execute` function because they run in the browser via
      // `useChat.onToolCall`. With `skipNonExecutableTools`, the helper
      // executes server tools in-place and leaves only registered
      // client-fulfilled names unresolved. Unknown other tools still become
      // normal tool-result errors so the agent can recover instead of
      // hanging.
      const newMessages = await executeToolCallsFromMessages(messageHistory, {
        tools: executableTools as Record<string, any>,
        skipNonExecutableTools: true,
        modelVisibleMcpToolResults,
        readLinkedResource: readLinkedMcpResourceWithManager(mcpClientManager),
        ...(abortSignal ? { abortSignal } : {}),
      });
      const toolsEndAbs = Date.now();

      const newToolCallIds = new Set<string>();
      for (const msg of newMessages) {
        if (msg?.role !== "tool") {
          continue;
        }
        const toolMsg = msg as ToolModelMessage;
        for (const part of toolMsg.content) {
          if (
            part.type === "tool-result" &&
            typeof part.toolCallId === "string"
          ) {
            newToolCallIds.add(part.toolCallId);
          }
        }
      }
      setToolSpanMessageRangesFromResults(
        traceTurn.turnSpans,
        messageHistory,
        traceTurn.promptIndex,
        stepIndex,
        newToolCallIds
      );
      const stepMessageEndIndexAfterTools =
        messageHistory.length > traceTurn.promptMessageStartIndex
          ? messageHistory.length - 1
          : undefined;
      const stepMessageStartIndexAfterTools =
        stepMessageEndIndexAfterTools != null
          ? traceTurn.promptMessageStartIndex
          : undefined;

      pushBackendStepSuccessSpans(
        traceTurn.turnSpans,
        traceTurn.turnStartedAt,
        traceTurn.promptIndex,
        stepIndex,
        stepStartAbs,
        { startAbs: llmStartAbs, endAbs: llmEndAbs },
        {
          startAbs: toolsStartAbs,
          endAbs: toolsEndAbs,
          pushAggregateSpan: newMessages.length === 0,
        },
        {
          modelId,
          inputTokens: stepUsage?.inputTokens,
          outputTokens: stepUsage?.outputTokens,
          totalTokens: stepUsage?.totalTokens,
          messageStartIndex: stepMessageStartIndexAfterTools,
          messageEndIndex: stepMessageEndIndexAfterTools,
          status: "ok",
          ...harnessSpanMeta,
        }
      );
      setStepSpanMessageRanges(
        traceTurn.turnSpans,
        traceTurn.promptIndex,
        stepIndex,
        stepMessageStartIndexAfterTools,
        stepMessageEndIndexAfterTools
      );

      // Emit results for newly executed tools
      await emitToolResults(
        writer,
        mcpClientManager,
        newMessages,
        traceTurn,
        stepIndex,
        onToolResult
      );
      emitTraceSnapshot(writer, messageHistory, tools, traceTurn);

      // Progressive discovery bookkeeping: any tool ids the model just
      // loaded via load_mcp_tools are now staged in
      // `discoveryState.newlyLoadedToolIds`. Promote them into the
      // persistent loaded set so the next step's active subset includes
      // them.
      if (progressivePlan?.enabled && discoveryState) {
        commitNewlyLoaded(discoveryState);
      }

      // Client-fulfilled tools (app aliases + `ui_*`/`page_*`): pause only for
      // unresolved registered client-fulfilled calls. Other unresolved calls
      // should keep the legacy loop behavior; in normal execution they have
      // already been converted to error tool-results above.
      if (hasUnresolvedClientFulfilledToolCalls(messageHistory, tools)) {
        if (finishChunk) {
          writer.write(createClientFinishChunk(finishChunk, traceTurn, "stop"));
        }
        return { shouldContinue: false, didEmitFinish: !!finishChunk };
      }
    } catch (error) {
      // Aborts surface here when the signal fires mid-tool. Bubble up so
      // the outer handler can take the silent-cancellation path; don't
      // pollute fail-spans or push an error chunk.
      if (isAbortError(error)) {
        throw error;
      }
      // Hosted MRTR (§12.5): a tool call returned `input_required` and the
      // suspending collector persisted it to a durable continuation, emitted
      // the `data-mrtr-input-required` part, and threw to unwind. This is a
      // PAUSE, not a failure — modeled on the client-fulfilled rail: emit the
      // finish chunk and return control to the browser WITHOUT blocking,
      // erroring, or polling. The unresolved tool-call stays in history (the
      // browser resends it on resume); the epilogue persists it and closes the
      // stream. The whole point of the durable transport vs legacy elicitation
      // is that the worker does not hold open awaiting a human.
      if (
        isMrtrSuspendSignalShape(error) ||
        isScopeStepUpSuspendSignal(error)
      ) {
        emitTraceSnapshot(writer, messageHistory, tools, traceTurn);
        if (finishChunk) {
          writer.write(createClientFinishChunk(finishChunk, traceTurn, "stop"));
        }
        return { shouldContinue: false, didEmitFinish: !!finishChunk };
      }
      const failAbs = Date.now();
      pushBackendStepToolFailureSpans(
        traceTurn.turnSpans,
        traceTurn.turnStartedAt,
        traceTurn.promptIndex,
        stepIndex,
        stepStartAbs,
        { startAbs: llmStartAbs, endAbs: llmEndAbs },
        toolsStartAbs,
        failAbs,
        {
          modelId,
          inputTokens: stepUsage?.inputTokens,
          outputTokens: stepUsage?.outputTokens,
          totalTokens: stepUsage?.totalTokens,
          messageStartIndex: stepMessageStartIndex,
          messageEndIndex: stepMessageEndIndex,
          pushAggregateSpan: false,
        }
      );
      setStepSpanMessageRanges(
        traceTurn.turnSpans,
        traceTurn.promptIndex,
        stepIndex,
        stepMessageStartIndex,
        stepMessageEndIndex
      );
      emitTraceSnapshot(writer, messageHistory, tools, traceTurn);

      const errorText = error instanceof Error ? error.message : String(error);
      writeTraceEvent(writer, {
        type: "error",
        turnId: traceTurn.turnId,
        promptIndex: traceTurn.promptIndex,
        stepIndex,
        errorText,
      });
      emitError(writer, errorText);
      // Site (2) holds a real error. An earlier comment deferred capture to
      // "the chat route's stream onError" — but runChatEngineLoop's
      // createUIMessageStream passes only `execute`, so no such onError
      // exists on this path and the failure was never classified or
      // recorded. The reporter closes that hole: capture decision, free-form
      // row, and the typed route.operation.failed event (the response is a
      // 200 stream, so the HTTP failure events never see this).
      const stepNormalized = describeError(error);
      // Same silent-cancel guard as the outer loop's catch (which checks
      // `isAbortError(error) || abortSignal?.aborted`): a non-AbortError that
      // lands after the signal fired belongs to a turn the client already
      // cancelled.
      if (!abortSignal?.aborted) {
        failureReporter({
          message: "[mcpjam-stream-handler] engine step failed",
          error,
          source: "mcp.chat-v2.engine-step",
          hop: "user_server_hop",
          transport: "http_stream",
          normalized: stepNormalized,
          context: {
            promptIndex: traceTurn.promptIndex,
            stepIndex,
          },
        });
      }
      // PR 5b-followup-2: surface the error to `streamSink: "none"`
      // consumers (eval backend stream runner). The processStream /
      // tool-execution catch path doesn't have a structured body, so
      // `message` is just the error text; `code` / `details` /
      // `httpStatus` are omitted.
      safelyEmitEngineError(onEngineError, {
        message: errorText,
        rawText: errorText,
        promptIndex: traceTurn.promptIndex,
        stepIndex,
        normalized: stepNormalized,
      });
      return { shouldContinue: false, didEmitFinish: false };
    }

    return { shouldContinue: true, didEmitFinish: false };
  }

  pushBackendStepSuccessSpans(
    traceTurn.turnSpans,
    traceTurn.turnStartedAt,
    traceTurn.promptIndex,
    stepIndex,
    stepStartAbs,
    { startAbs: llmStartAbs, endAbs: llmEndAbs },
    undefined,
    {
      modelId,
      inputTokens: stepUsage?.inputTokens,
      outputTokens: stepUsage?.outputTokens,
      totalTokens: stepUsage?.totalTokens,
      messageStartIndex: stepMessageStartIndex,
      messageEndIndex: stepMessageEndIndex,
      status: "ok",
      ...harnessSpanMeta,
    }
  );
  setStepSpanMessageRanges(
    traceTurn.turnSpans,
    traceTurn.promptIndex,
    stepIndex,
    stepMessageStartIndex,
    stepMessageEndIndex
  );
  emitTraceSnapshot(writer, messageHistory, tools, traceTurn);

  // No more tool calls - emit finish and stop
  const didEmitFinish = !!finishChunk;
  if (finishChunk) {
    writer.write(createClientFinishChunk(finishChunk, traceTurn, "stop"));
  }

  // We're done with this conversation turn
  return { shouldContinue: false, didEmitFinish };
}

/**
 * Result returned from {@link runChatEngineLoop}.
 *
 * - `streamSink: "ui"` callers get a Hono-shaped Response built from
 *   {@link createUIMessageStreamResponse}, exactly as the live `/stream`
 *   route expects. The Response's body, when drained, runs the agent
 *   loop and fires `onConversationComplete` via `onFinish`.
 *
 * - `streamSink: "none"` callers (synthetic runner) get the captured
 *   `messageHistory` synchronously — the engine ran inline with a no-op
 *   writer, no `createUIMessageStream`, no Response. `messageHistory`
 *   is the same array reference that was passed to
 *   `onConversationComplete` (if `runSucceeded && !aborted`).
 */
export interface ChatEngineLoopResult {
  response?: Response;
  messageHistory: ModelMessage[];
  turnTrace?: PersistedTurnTrace;
  aborted: boolean;
}

/**
 * Core engine for the MCPJam agentic chat loop.
 *
 * This is the body that used to live inside `handleMCPJamFreeChatModel`.
 * It owns the per-step Convex `/stream` fetch + local tool execution
 * cycle, the trace event emission, and the conversation persistence tap.
 *
 * Two delivery modes:
 *
 * - `streamSink: "ui"` wraps the loop in `createUIMessageStream` +
 *   `createUIMessageStreamResponse` and returns a Hono Response. This is
 *   byte-for-byte the same chunk sequence as before the extraction
 *   (covered by `mcpjam-stream-handler-snapshot.test.ts`).
 *
 * - `streamSink: "none"` runs the same `execute` closure with a no-op
 *   writer and then calls `onFinish` directly. No `Response` is built;
 *   the synthetic runner reads the transcript out of the returned
 *   `messageHistory` (also delivered via `onConversationComplete`).
 *
 * `handleMCPJamFreeChatModel` is now a thin wrapper around this in
 * `streamSink: "ui"` mode; `runAssistantTurn` calls it in either mode
 * depending on the caller's `streamSink` choice.
 */
export async function runChatEngineLoop(
  options: MCPJamHandlerOptions,
  streamSink: "ui" | "none"
): Promise<ChatEngineLoopResult> {
  const {
    messages,
    modelId,
    provider,
    systemPrompt,
    temperature,
    tools,
    authHeader,
    scenarioId,
    accessVersion,
    projectId,
    mcpClientManager,
    selectedServers,
    requireToolApproval,
    uiToolApprovals,
    modelVisibleMcpToolResults,
    approvalMode,
    mrtrResume,
    scopeStepUpResume,
    onConversationComplete,
    onStreamComplete,
    onStreamWriterReady,
    endpointPath,
    extraHeaders,
    extraBodyFields,
    chatSessionId,
    sourceType,
    clientIp,
    onLiveTextDelta,
    // PR 5b-pre callbacks.
    onToolCall,
    onToolResult,
    onStepFinish,
    // PR 5b-followup-2 callback.
    onEngineError,
    failureReporter: failureReporterOption,
    // Browser-rendered MCP App eval PR 2: advertised-tool narrowing hook.
    prepareAdvertisedTools,
    abortSignal,
    heartbeatIntervalMs,
    maxSteps,
    progressivePlan,
    discoveryState,
  } = options;
  // One typed route.operation.failed per turn, whatever combination of the
  // three failure sites fires; the system fallback covers eval/swarm runs
  // that have no request context. Later failures in the same turn still get
  // classified (capture-deduped) and keep their free-form rows.
  const failureReporter = oncePerTurn(
    failureReporterOption ?? createSystemStreamFailureReporter("chat-engine")
  );
  const resolvedEndpointPath = endpointPath ?? "/stream";
  const resolvedMaxSteps =
    typeof maxSteps === "number" && Number.isFinite(maxSteps) && maxSteps > 0
      ? Math.floor(maxSteps)
      : DEFAULT_MAX_STEPS;
  const resolvedHeartbeatMs =
    typeof heartbeatIntervalMs === "number" &&
    Number.isFinite(heartbeatIntervalMs) &&
    heartbeatIntervalMs >= 0
      ? Math.floor(heartbeatIntervalMs)
      : DEFAULT_HEARTBEAT_INTERVAL_MS;

  const toolDefs = serializeToolsForConvex(tools);
  const toolDefsByName = new Map<string, ToolDefinition>();
  for (const def of toolDefs) {
    toolDefsByName.set(def.name, def);
  }
  const messageHistory = [...messages];

  // Seed the pending-approval set from history so resumed turns keep
  // exposing the tool whose approval the user is about to answer. This is
  // a no-op in non-progressive mode.
  if (progressivePlan?.enabled && discoveryState) {
    const resultIds = new Set<string>();
    for (const msg of messageHistory) {
      if (msg?.role !== "tool") continue;
      for (const part of (msg as ToolModelMessage).content) {
        if (part.type === "tool-result") resultIds.add(part.toolCallId);
      }
    }
    for (const msg of messageHistory) {
      if (msg?.role !== "assistant") continue;
      const content = (msg as AssistantModelMessage).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (
          part.type === "tool-call" &&
          !resultIds.has(part.toolCallId) &&
          !META_TOOL_NAMES.includes(part.toolName)
        ) {
          const id = lookupToolIdByModelName(
            progressivePlan.catalog,
            part.toolName
          );
          if (id) discoveryState.pendingApprovalToolIds.add(id);
        }
      }
    }
  }
  const usedToolCallIds = collectUsedToolCallIds(messageHistory);
  const traceTurn: LiveTraceTurnContext = {
    turnId: generateLiveTraceTurnId(),
    promptIndex: getPromptIndex(messageHistory),
    promptMessageStartIndex: getPromptMessageStartIndex(messageHistory),
    turnStartedAt: Date.now(),
    turnSpans: [],
  };
  // Shared per-turn ritual (turn_start / onStepFinish / turn_finish /
  // PersistedTurnTrace), sharing `traceTurn`'s span array + clock so the live
  // snapshots (still emitted against `traceTurn`) and the driver stay in lockstep.
  const driver = new StreamTurnDriver({
    turnId: traceTurn.turnId,
    promptIndex: traceTurn.promptIndex,
    modelId,
    engine: "emulated",
    traceBaseMs: traceTurn.turnStartedAt,
    spans: traceTurn.turnSpans,
    onStepFinish,
  });
  const promptStepBaseIndex = getPromptAssistantStepBaseIndex(
    messageHistory,
    traceTurn.promptMessageStartIndex
  );
  let steps = 0;
  let runSucceeded = false;
  let aborted = false;

  // Engine `execute` closure. Factored so it can be invoked either via
  // `createUIMessageStream` (streamSink: "ui") or directly with a no-op
  // writer (streamSink: "none"). Captures the engine's shared state
  // (`messageHistory`, `traceTurn`, `steps`, `runSucceeded`, `aborted`)
  // via closure exactly as before.
  const executeEngine = async ({
    writer,
  }: {
    writer: { write: (chunk: UIMessageChunk) => void };
  }) => {
    let finishEmitted = false;
    let streamClosed = false;
    let lastWriteAt = Date.now();
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    // Wrap the writer to track quiescence (for idle heartbeat) and to
    // swallow write errors after the underlying stream has been torn
    // down. The latter prevents a stray heartbeat or trace event from
    // bringing down the agentic loop after a client disconnect.
    // The narrowed `{ write }` shape matches StepContext.writer and
    // MCPJamHandlerOptions.onStreamWriterReady, both of which only need
    // the writer for chunk forwarding.
    const safeWriter: {
      write: (chunk: UIMessageChunk) => void;
      isClosed: () => boolean;
    } = {
      // Whether the underlying controller is gone. Load-bearing for anything
      // that must know a chunk ACTUALLY reached the browser: `write` below is
      // deliberately no-throw (a client disconnect must not bring down the
      // agentic loop), so a caller with only `write` cannot distinguish
      // "delivered" from "silently dropped". The scenario sandbox notices use
      // this to avoid acking — and therefore permanently consuming — a notice
      // that was written into a closed stream.
      isClosed: () => streamClosed,
      write: (chunk: UIMessageChunk) => {
        lastWriteAt = Date.now();
        if (streamClosed) return;
        try {
          writer.write(chunk);
        } catch (writeError) {
          // The SDK closes the underlying controller on client
          // disconnect; subsequent writes throw. Treat this as a
          // signal that the stream is gone and stop further writes.
          streamClosed = true;
          if (!aborted) {
            logger.warn(
              "[mcpjam-stream-handler] writer.write failed; marking stream closed",
              {
                error:
                  writeError instanceof Error
                    ? writeError.message
                    : String(writeError),
              }
            );
          }
        }
      },
    };

    const effectiveSteps = () => promptStepBaseIndex + steps;
    const hitStepCap = () => effectiveSteps() >= resolvedMaxSteps;

    // Idle heartbeat: only fires when the stream has been quiet for at
    // least `resolvedHeartbeatMs`. Skipped during teardown and during
    // an active abort. Errors are swallowed — heartbeats must never
    // surface as user-visible failures.
    const startHeartbeat = () => {
      if (resolvedHeartbeatMs <= 0) return;
      heartbeatTimer = setInterval(() => {
        if (streamClosed || aborted) return;
        const sinceLastWrite = Date.now() - lastWriteAt;
        if (sinceLastWrite < resolvedHeartbeatMs) return;
        try {
          writeTraceEvent(safeWriter, {
            type: "heartbeat",
            turnId: traceTurn.turnId,
            promptIndex: traceTurn.promptIndex,
          });
        } catch (error) {
          // Should not happen — safeWriter swallows write errors —
          // but a final guard here keeps a misbehaving writeTraceEvent
          // from killing the loop.
          logger.warn("[mcpjam-stream-handler] heartbeat emit failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }, Math.max(250, Math.floor(resolvedHeartbeatMs / 2)));
    };

    // External abort listener: marks `aborted` so downstream catch
    // branches take the silent-cancellation path. The actual stream
    // reader cancellation happens inside processStream.
    let abortListener: (() => void) | undefined;
    if (abortSignal) {
      if (abortSignal.aborted) {
        aborted = true;
      } else {
        abortListener = () => {
          aborted = true;
        };
        abortSignal.addEventListener("abort", abortListener, { once: true });
      }
    }

    try {
      onStreamWriterReady?.(safeWriter);

      if (aborted) {
        // Already aborted before we even started — bail silently.
        return;
      }

      driver.emitTurnStart(safeWriter);

      startHeartbeat();

      // Process any pending approval responses from a previous request.
      //
      // The UI classification has to be honored here too, not just at the
      // emit gate. With the flag off, a destructive `ui_*` call now pauses
      // for approval — and DENYING it sends an approval response back (the
      // approve path ships a tool-result instead). Gating this on
      // `requireToolApproval` alone would leave that denial unprocessed and
      // the tool call unresolved: the turn would hang forever, which is the
      // exact failure the two-sided predicate exists to prevent.
      if (
        requireToolApproval ||
        (uiToolApprovals?.requiredNames.size ?? 0) > 0
      ) {
        const handled = await handlePendingApprovals(
          safeWriter,
          messageHistory,
          tools,
          mcpClientManager,
          traceTurn,
          effectiveSteps(),
          abortSignal,
          modelVisibleMcpToolResults,
          onToolResult,
          onToolCall
        );
        if (handled) {
          // Approvals were processed — if there are still unresolved tool
          // calls (shouldn't happen normally), fall through to the loop.
          // Otherwise the loop will call Convex with the new tool results.
        }
      }

      // ── Hosted MRTR resume pre-phase (§12.5, PR5) ─────────────────────────
      // A fresh request resuming a suspended tool call drives ONE retry leg
      // here — before the first model call — against the durable continuation.
      // On completion the driven result is spliced into the suspended tool-call
      // slot and the loop runs the model with it (resuming the agent loop to a
      // final assistant message). A further round re-suspends; a terminal /
      // indeterminate outcome pauses. This is the SAME engine that produced the
      // suspension, re-entered on any replica.
      let mrtrPaused = false;
      const operationResume = scopeStepUpResume ?? mrtrResume;
      if (
        operationResume &&
        !aborted &&
        !hasUnresolvedToolCall(messageHistory, operationResume.toolCallId)
      ) {
        // The resume request's `toolCallId` does not identify an unresolved
        // tool-call in the resent history (stale, tampered, or already
        // resolved). Do NOT drive — driving would claim/consume the durable
        // continuation and then have nowhere to splice the result, losing it.
        // Pause and let the client reconcile.
        logger.warn(
          "[mcpjam-stream-handler] MRTR resume: toolCallId is not an unresolved tool-call; skipping resume",
          { toolCallId: operationResume.toolCallId }
        );
        mrtrPaused = true;
      } else if (operationResume && !aborted) {
        const resolution = await operationResume.resolve((chunk) =>
          safeWriter.write(chunk)
        );
        if (resolution.kind === "complete" || resolution.kind === "recover") {
          const spliced = spliceMrtrToolResult(
            messageHistory,
            operationResume.toolCallId,
            resolution.toolResultMessage
          );
          if (spliced) {
            await emitToolResults(
              safeWriter,
              mcpClientManager,
              [resolution.toolResultMessage],
              traceTurn,
              effectiveSteps(),
              onToolResult
            );
            emitTraceSnapshot(safeWriter, messageHistory, tools, traceTurn);
            // Only run the model once EVERY tool-call in the resent history has
            // a result. If a sibling tool call in the same assistant step also
            // suspended to its own continuation, it is still unresolved here;
            // invoking the model now would send an assistant tool-call with no
            // matching tool-result (an invalid request) and strand that
            // sibling's continuation. Keep the turn paused so the client drives
            // the remaining continuation(s) on subsequent resume requests.
            if (hasUnresolvedToolCalls(messageHistory)) {
              mrtrPaused = true;
            }
            // Otherwise fall through to the loop: the model now sees the
            // resolved tool result and produces the final assistant message.
          } else {
            // The browser's resent history lacked the suspended tool-call. Do
            // not run the model on a mismatched turn; pause and let the client
            // reconcile.
            logger.warn(
              "[mcpjam-stream-handler] MRTR resume: suspended tool-call not found in history; pausing",
              { toolCallId: operationResume.toolCallId }
            );
            mrtrPaused = true;
          }
        } else {
          // suspended (another round) or halted (indeterminate / cancelled /
          // expired): the data part / resolved event was already emitted by the
          // leg. Pause without a model call — the epilogue emits finish and
          // persists the (still-unresolved) tool-call.
          mrtrPaused = true;
        }
      }

      while (!mrtrPaused && effectiveSteps() < resolvedMaxSteps) {
        if (aborted) break;
        const { shouldContinue, didEmitFinish } = await processOneStep({
          writer: safeWriter,
          messageHistory,
          toolDefs,
          toolDefsByName,
          tools,
          progressivePlan,
          discoveryState,
          authHeader,
          scenarioId,
          accessVersion,
          projectId,
          chatSessionId,
          sourceType,
          modelId,
          provider,
          systemPrompt,
          temperature,
          mcpClientManager,
          selectedServers,
          requireToolApproval,
          uiToolApprovals,
          modelVisibleMcpToolResults,
          approvalMode,
          stepIndex: effectiveSteps(),
          usedToolCallIds,
          traceTurn,
          endpointPath: resolvedEndpointPath,
          extraHeaders,
          extraBodyFields,
          clientIp,
          onLiveTextDelta,
          // PR 5b-pre: chunk-level callbacks. Passed through to the
          // step processor where the chunk-switch (onToolCall) +
          // tool-result emission (onToolResult) sites fire them.
          onToolCall,
          onToolResult,
          // PR 5b-followup-2: structured-error callback. Fires from
          // the two `processOneStep` error sites (non-OK Convex
          // response + processStream/tool catch).
          onEngineError,
          failureReporter,
          // Browser-rendered MCP App eval PR 2: advertised-tool narrowing.
          prepareAdvertisedTools,
          abortSignal,
        });

        steps++;
        if (didEmitFinish) {
          finishEmitted = true;
        }

        // PR 5b-pre: step-level callback. Fires after each
        // `processOneStep` returns and the step counter increments,
        // so the runner sees one event per completed step in order.
        // Routed through the shared driver (cumulative `turnUsage` from the
        // shared span/usage state, defensive `turnSpans` copy). The engine's
        // failure branches return `shouldContinue: false` + `didEmitFinish:
        // false` after emitting an error UI chunk; `settledWithError`
        // surfaces that so the runner can map it to eval's `step_finish`.
        driver.usage = traceTurn.turnUsage;
        driver.fireStepFinish(
          effectiveSteps() - 1,
          !didEmitFinish && !shouldContinue
        );

        if (!shouldContinue) {
          break;
        }
      }

      // Silent cancellation gate: an abort that fired between steps
      // exits the loop above via `if (aborted) break`, but the rest of
      // the success epilogue (high-step log, synthetic finish,
      // turn_finish, runSucceeded=true) would still run. Bail here so
      // the writer sees no terminal chunk and `onFinish` keeps the
      // turn out of persistence. `onStreamComplete` still runs via the
      // `finally` below.
      if (aborted || abortSignal?.aborted) {
        aborted = true;
        return;
      }

      // One structured log per turn that reached the historical "loose"
      // cap so we can validate whether 30 is the right new default
      // before tuning down. Fires only on success paths to avoid
      // double-logging abort/error turns.
      if (effectiveSteps() >= STEP_LOG_THRESHOLD) {
        logger.info("[mcpjam-stream-handler] turn reached high step count", {
          effectiveSteps: effectiveSteps(),
          maxSteps: resolvedMaxSteps,
          modelId,
          turnId: traceTurn.turnId,
        });
      }

      // Safety: ensure we always emit a finish event
      if (!finishEmitted) {
        safeWriter.write(
          createClientFinishChunk(
            null,
            traceTurn,
            hitStepCap() ? "length" : "stop"
          )
        );
        finishEmitted = true;
      }

      // Shared ritual: turn_finish + success flag (finish chunk already
      // emitted by the step or the safety block above).
      driver.usage = traceTurn.turnUsage;
      driver.finishReason = hitStepCap() ? "length" : "stop";
      driver.finishTurn(safeWriter, { alreadyEmittedFinish: true });

      runSucceeded = true;
    } catch (error) {
      // Abort is the cooperative cancellation signal — silent path:
      // no error chunk, no synthetic finish, no turn_finish, no
      // failure spans, no conversation persistence. The downstream
      // controller is already being torn down by the client.
      if (isAbortError(error) || abortSignal?.aborted) {
        aborted = true;
      } else {
        const failAbs = Date.now();
        const errorText =
          error instanceof Error ? error.message : String(error);
        // A thrower that classified with the structured body in hand wins:
        // a mid-stream error chunk reaches here as an Error whose message is
        // a sentence, and re-describing it would throw away the guardrail
        // code that settles ownership.
        const loopFailureCode = attachedFailureCode(error);
        const loopNormalized =
          attachedNormalized(error) ?? describeError(error);
        // Reporter, not a bare logger.error: the old call captured to Sentry
        // unconditionally — paging on user-fault failures — and left no typed
        // record a monitor could read (the response is a 200 stream). The
        // reporter classifies first, pages only on origin=mcpjam, keeps the
        // free-form row, and emits route.operation.failed.
        failureReporter({
          message: "[mcpjam-stream-handler] Error in agentic loop",
          error,
          source: "mcp.chat-v2.agentic-loop",
          hop: "user_server_hop",
          transport: "http_stream",
          normalized: loopNormalized,
          ...(loopFailureCode ? { errorCode: loopFailureCode } : {}),
          context: { promptIndex: traceTurn.promptIndex },
        });
        pushAiSdkTrailingErrorSpan(
          traceTurn.turnSpans,
          traceTurn.turnStartedAt,
          traceTurn.turnStartedAt,
          failAbs,
          traceTurn.promptIndex
        );
        emitTraceSnapshot(safeWriter, messageHistory, tools, traceTurn);
        writeTraceEvent(safeWriter, {
          type: "error",
          turnId: traceTurn.turnId,
          promptIndex: traceTurn.promptIndex,
          errorText,
        });
        writeTraceEvent(safeWriter, {
          type: "turn_finish",
          turnId: traceTurn.turnId,
          promptIndex: traceTurn.promptIndex,
          usage: traceTurn.turnUsage,
        });
        emitError(safeWriter, errorText);
        // PR 5b-followup-2: surface to `streamSink: "none"` consumers.
        // Site (3) — outer agentic-loop catch. No structured body,
        // no stepIndex.
        safelyEmitEngineError(onEngineError, {
          message: errorText,
          ...(loopFailureCode ? { code: loopFailureCode } : {}),
          rawText: errorText,
          promptIndex: traceTurn.promptIndex,
          normalized: loopNormalized,
        });
      }
    } finally {
      streamClosed = true;
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
      }
      if (abortListener && abortSignal) {
        abortSignal.removeEventListener("abort", abortListener);
      }
    }
  };

  // Engine `onFinish` closure. Same logic that used to live as the
  // `onFinish` option on `createUIMessageStream`. Captures the latest
  // `turnTrace` (if produced) so the engine result can surface it to
  // synthetic-runner callers via {@link ChatEngineLoopResult.turnTrace}.
  let capturedTurnTrace: PersistedTurnTrace | undefined;
  // `receiptWriter` is the RAW stream writer, never `safeWriter`: the finally
  // block above has already flipped `streamClosed`, so every safeWriter write
  // from here on is silently dropped. The underlying stream is still open —
  // `createUIMessageStream` does not close it until `execute` resolves.
  const onFinishEngine = async (receiptWriter?: {
    write: (chunk: UIMessageChunk) => void;
  }) => {
    try {
      // Persist only successful, non-aborted turns. An aborted turn is
      // partial by definition — recording it as a completed conversation
      // would corrupt history and reverse the cost-safety win.
      if (runSucceeded && !aborted) {
        const trace: PersistedTurnTrace = driver.buildPersistedTrace();
        capturedTurnTrace = trace;
        try {
          const persistOutcome = await onConversationComplete?.(
            [...messageHistory],
            trace
          );
          // Costs no latency: `onConversationComplete` already awaited the
          // ingest, which is what gates this stream's close in the first place.
          if (persistOutcome && chatSessionId) {
            writePersistReceipt(receiptWriter, persistOutcome, {
              chatSessionId,
              turnId: trace.turnId,
            });
          }
        } catch (persistenceError) {
          logger.error(
            "[mcpjam-stream-handler] Error while persisting conversation",
            persistenceError
          );
          // A thrown persist is still an answer the client deserves. Without
          // this the stream closes silent and the client waits out its whole
          // no-receipt reconciliation window before saying anything.
          if (chatSessionId) {
            writePersistReceipt(
              receiptWriter,
              { outcome: "failed", failureKind: "exception" },
              {
                chatSessionId,
                ...(capturedTurnTrace
                  ? { turnId: capturedTurnTrace.turnId }
                  : {}),
              }
            );
          }
        }
      }
    } finally {
      try {
        await onStreamComplete?.();
      } catch (cleanupError) {
        logger.error(
          "[mcpjam-stream-handler] Error while running stream cleanup",
          cleanupError
        );
      }
    }
  };

  if (streamSink === "ui") {
    const stream = createUIMessageStream({
      // Do not pass `onFinishEngine` as createUIMessageStream's `onFinish`.
      // AI SDK enables its own message-state reducer whenever that callback is
      // present. A resumed scope step-up begins with `tool-output-available`
      // for a tool call created in the pre-OAuth response, but this stream has
      // no matching `tool-input-available`; the reducer throws after the first
      // trace chunk and strands the browser in "streaming".
      //
      // Our engine already owns the authoritative ModelMessage history, so run
      // persistence/cleanup directly after execution. With no SDK `onFinish`
      // reducer, cross-response tool results pass through to the browser and
      // the exact resumed transcript is still persisted before the stream
      // closes.
      execute: async (context) => {
        try {
          await executeEngine(context);
        } finally {
          await onFinishEngine(context.writer);
        }
      },
    });
    const response = createUIMessageStreamResponse({ stream });
    return {
      response,
      messageHistory,
      aborted: false,
      // turnTrace will be captured inside `onFinish` once the caller
      // drains the Response body; we don't surface it on the eager
      // result for the UI-sink path because the live route doesn't
      // need it (persistence runs via `onConversationComplete`).
    };
  }

  // streamSink === "none": run the engine inline against a no-op writer.
  // The agent loop, trace events, and `onConversationComplete` tap all
  // still fire — we just discard the SSE chunks. No `Response` is
  // constructed and no body is drained, so `runAssistantTurn` can return
  // the captured transcript synchronously without the previous
  // facade-style drain dance.
  const noopWriter = {
    write: (_chunk: UIMessageChunk) => {
      // Discard. The agent-loop trace/persistence side-effects fire via
      // closures over engine state, not via the writer.
    },
  };
  try {
    await executeEngine({ writer: noopWriter });
  } finally {
    await onFinishEngine();
  }
  return {
    messageHistory,
    aborted,
    ...(capturedTurnTrace ? { turnTrace: capturedTurnTrace } : {}),
  };
}

/**
 * Main handler for MCPJam-provided models.
 *
 * Thin wrapper around {@link runChatEngineLoop} for the live `/stream`
 * path. The engine produces an SSE Response that the chat-v2 routes
 * hand directly back to Hono.
 *
 * The signature is preserved so `handleHostedOrgChatModel` (org BYOK
 * delegation chain) can continue forwarding `endpointPath: "/stream/org"`
 * and `extraBodyFields: { providerKey }` without modification.
 */
export async function handleMCPJamFreeChatModel(
  options: MCPJamHandlerOptions
): Promise<Response> {
  // A host with a `harness` selected (claude-code | codex) runs the real runtime
  // via runHarnessTurn; otherwise the emulated engine. `harness` is already a
  // validated HarnessId (readHarness → isHarness) or undefined, so a truthiness
  // check is the right gate — runHarnessTurn re-resolves the adapter defensively.
  // Both satisfy the same ChatEngineLoopResult contract (streamSink "ui" → Response).
  const useHarness = Boolean(options.harness && !options.scopeStepUpResume);
  const result = await (useHarness
    ? runHarnessTurn(options, "ui")
    : runChatEngineLoop(options, "ui"));
  if (!result.response) {
    throw new Error(
      `${
        useHarness ? "runHarnessTurn" : "runChatEngineLoop"
      }(streamSink: 'ui') returned no Response — internal invariant violated`
    );
  }
  return result.response;
}
