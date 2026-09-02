/**
 * Shared web-chat streaming turn.
 *
 * Encapsulates the streaming/persistence/provider-branching body that both
 * `web/chat-v2` and `web/mcpjam-agent` share. Extracted verbatim from
 * `web/chat-v2.ts` (commit history) so behavior is identical for the original
 * caller — see `feedback_mechanical_commit_framing` for why this lives in its
 * own commit.
 *
 * The caller is responsible for:
 *   - Parsing the inbound body.
 *   - Constructing the MCPClientManager (`createAuthorizedManager` for
 *     project-server chats, ad-hoc for self-hosted agent surfaces).
 *   - Pre-building the `hostConfig` payload (only direct-chat callers do;
 *     other callers omit it).
 *
 * This helper owns:
 *   - `prepareChatV2` (with the Anthropic-tool-name 400 catch).
 *   - The `isMCPJam` / org-BYOK / local-runtime branch.
 *   - Constructing `onConversationComplete` → `persistChatSessionToConvex`
 *     with optional tool-snapshot capture, gated on `manager.hasServer`.
 *   - `cleanupStream` → `manager.disconnectAllServers()`.
 *   - Throwing/propagating errors; the caller is expected to catch and run
 *     its own OAuth-error enrichment if applicable.
 */
import type { Context } from "hono";
import { type ToolSet, type UIMessageChunk } from "ai";
import { logger } from "./logger.js";
import { createRequestStreamFailureReporter } from "./stream-failure-reporter.js";
import {
  SANDBOX_NOTICE_DATA_PART_TYPE,
  type SandboxNoticeReason,
} from "@/shared/sandbox-notice";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { UIMessage } from "@ai-sdk/react";
import type {
  Harness,
  MCPClientManager,
  ToolTaskSeamOptions,
} from "@mcpjam/sdk";
import type {
  McpToolResultImageRenderingPolicy,
  ModelVisibleMcpToolResults,
} from "@mcpjam/sdk/host-config/internal";
import {
  handleMCPJamFreeChatModel,
  warnIfChatAbortSignalMissing,
} from "./mcpjam-stream-handler.js";
import type { ExecutionScope } from "./execution-scope.js";
import {
  handleHostedOrgChatModel,
  handleLocalOrgChatModel,
} from "./org-model-stream-handler.js";
import {
  deriveOrgProviderKey as deriveOrgProviderKeyResult,
  isLocalRuntimeEligible,
  resolveOrgProviderRuntime,
  type OrgProviderRuntime,
} from "./org-model-config.js";
import { type ModelDefinition } from "@/shared/types";
import { isHostedCatalogModel } from "../services/hosted-model-catalog.js";
import {
  buildWidgetModelContextSystemPrompt,
  prepareChatV2,
  type AppToolEntry,
  type UiToolEntry,
  type WidgetModelContextEntry,
} from "./chat-v2-orchestration.js";
import {
  persistChatSessionToConvex,
  pickEnrichmentHeaders,
  stampSenderUserIdsOnSessionMessages,
  type ChatOrigin,
  type DirectHostConfig,
  type PersistedTurnTrace,
} from "./chat-ingestion.js";
import {
  fetchRuntimeSecrets,
  resolveTurnRuntimeSecrets,
} from "./harness/runtime-secrets.js";
import { createSecretScrubber } from "./secrets/secret-scrubber.js";
import type { HarnessSessionCommitPayload } from "./harness/harness-session-state.js";
import { type RuntimeSkill } from "./harness/runtime-skills.js";
import { harnessUsesExternalAccount } from "./harness/registry.js";
import type { EffectiveCapabilitySet } from "../services/environments/effective-capabilities.js";
import type { TurnSkillProvenance } from "../services/environments/runtime.js";
import { exportConnectedServerToolSnapshotForEvalAuthoring } from "./export-helpers.js";
import { ErrorCode, WebRouteError } from "./../routes/web/errors.js";
import { readUrlElicitations } from "@/shared/http-tool-calls";
import { wrapToolsWithScopeStepUp } from "./insufficient-scope-step-up.js";
import {
  classifyUiToolApprovals,
  mergeUiToolApprovalClassifications,
  type UiToolApprovalClassification,
} from "@/shared/client-fulfilled-tools";
import { isRenderedUiContextText } from "@/shared/ui-context";
import type { createHostedRpcLogCollector } from "./../routes/web/hosted-rpc-logs.js";
import {
  emitInsufficientScopeChunk,
  type ElicitationChunkWriter,
  type HostedElicitationBridge,
} from "./../routes/web/hosted-elicitation.js";
import type { HostedMrtrBridge } from "./mrtr-hosted-bridge.js";
import type { HostedTaskCreatedBridge } from "./hosted-task-created-bridge.js";
import type { MrtrEngineResume } from "./mrtr-hosted-chat.js";
import {
  buildHostedScopeStepUpCancellation,
  buildHostedScopeStepUpResume,
  createHostedScopeStepUpContinuation,
} from "./hosted-scope-step-up-continuation.js";
import type {
  ScopeStepUpCancelRequest,
  ScopeStepUpResumeRequest,
} from "@/shared/scope-step-up";
import type { ChatRewind } from "@/shared/chat-v2";
import {
  bridgeHarnessRpcLogsToCollector,
  startCrossInstanceRpcLogPoll,
} from "./../routes/web/hosted-rpc-logs.js";
import { buildServerNamesById } from "./../routes/web/auth.js";
import type { CustomProviderConfig } from "./chat-helpers.js";
import { getClientIp } from "./client-ip.js";
import { convertToMcpjamModelMessages } from "./mcp-tool-result-model-output.js";
import {
  resolveWebAuthorizedHarnessStrategy,
  type HarnessMcpProxyStrategy,
} from "./harness/harness-proxy-strategy.js";

type RpcCollector = ReturnType<typeof createHostedRpcLogCollector>;

/**
 * The direct-chat `resumeConfig.selectedServers` list.
 *
 * Names when the browser supplied an index-aligned set, ids otherwise — and
 * `nonResumableServerIds` filtered out BY INDEX, never by value: two servers
 * can share a display name, and filtering names by value would drop the wrong
 * entry (the same rule `services/journeys/plugin-servers.ts` follows).
 */
export function resumableServers(persist: {
  selectedServerIds: string[];
  selectedServerNames?: string[];
  nonResumableServerIds?: string[];
}): string[] {
  const aligned =
    Array.isArray(persist.selectedServerNames) &&
    persist.selectedServerNames.length === persist.selectedServerIds.length
      ? persist.selectedServerNames
      : persist.selectedServerIds;
  const excluded = persist.nonResumableServerIds;
  if (!excluded || excluded.length === 0) return aligned;
  const nonResumable = new Set(excluded);
  return aligned.filter(
    (_, index) => !nonResumable.has(persist.selectedServerIds[index]!),
  );
}

/**
 * Persistence context for a web-chat turn — everything `persistChatSessionToConvex`
 * needs that isn't already in scope from the stream handlers.
 */
export interface WebChatTurnPersistContext {
  /** Required to enable persistence; without it, no ingest. */
  chatSessionId: string | undefined;
  projectId: string;
  /** Closed union per `chatIngestion/common.ts`. */
  sourceType: "scenario" | "direct";
  /**
   * Closed union per backend `chatOriginValidator`. Required at this boundary
   * so a new caller can't skip choosing one — `sourceType` answers the
   * persistence/billing bucket; `origin` answers the product surface
   * (training-data discriminator).
   */
  origin: ChatOrigin;
  /** Only set when sourceType === "scenario". */
  surface?: "preview" | "share_link";
  scenarioId?: string;
  accessVersion?: number;
  /** Phase 3 execution scope (scenario/host runtime-config). Threaded into the
   *  harness path so the backend re-resolves live access + per-swarm caps. */
  executionScope?: ExecutionScope;
  /** Server-authenticated user id (Convex), forwarded to message-sender stamping. */
  authenticatedUserId?: string | null;
  /** UI messages from the inbound request — used to stamp `senderUserId`. */
  originalMessages: UIMessage[] | unknown[];
  /** Direct-chat only. */
  directVisibility?: "private" | "project";
  /** Direct-chat lineage when this session was created by message edit. */
  rewind?: ChatRewind;
  /**
   * Optimistic-concurrency baseline for a resumed thread: the session version
   * the client believes it is continuing from. The client has always sent it;
   * this path used to discard it, leaving hosted sessions with no protection
   * against a second tab or device overwriting a turn.
   */
  expectedVersion?: number;
  /**
   * Direct-chat only. May be a pre-built payload, `null` to opt out (e.g.
   * agent surfaces), or a builder closure that receives the post-prepare
   * `resolvedTemperature` (matches legacy chat-v2 which fed
   * `resolvedTemperature` into `buildDirectHostConfig`). `undefined` is
   * equivalent to `null`.
   */
  hostConfig?:
    | DirectHostConfig
    | null
    | ((args: {
        resolvedTemperature: number | undefined;
      }) => DirectHostConfig | null);
  /** Direct-chat only — selectedServers as names when available. */
  selectedServerNames?: string[];
  /** Required for `resumeConfig.selectedServers` fallback on direct chat. */
  selectedServerIds: string[];
  /**
   * Server ids that ran this turn but must NOT be written into
   * `resumeConfig.selectedServers` — today, plugin-contributed servers.
   *
   * `resumeConfig` is a DURABLE reconnect instruction the Sessions viewer
   * replays with no plugin lifecycle check, so a plugin server id stored here
   * outlives the plugin's disable/uninstall and re-attaches it — the same
   * bypass that keeps `plugin_component` ids out of `hostConfigs.serverIds`
   * (and that `services/journeys/plugin-servers.ts` already filters for journeys).
   * It is also how a Playground's EPHEMERAL plugin narrowing would leak into a
   * durable record: whatever the user toggled off this turn would be written
   * down as the session's server set. Which plugin versions ran stays
   * recorded as trace provenance; it is never a restorable pin.
   */
  nonResumableServerIds?: string[];
  /** Resolved per-turn config — forwarded into `resumeConfig`. */
  systemPrompt?: string;
  temperature?: number;
  requireToolApproval?: boolean;
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
  /** Resolved host harness (absent ⇒ emulated). Routes a claude-code host
   *  through the real Claude Code runtime via handleMCPJamFreeChatModel. */
  harness?: Harness;
  respectToolVisibility?: boolean;
  /**
   * When `false`, skip the `exportConnectedServerToolSnapshotForEvalAuthoring`
   * fanout on conversation complete. Used by surfaces whose
   * `selectedServerIds` are synthetic (e.g. the mcpjam-docs agent) — the
   * backend would discard the snapshot and the inspector would have done
   * the work for no reason. Defaults to `true` to preserve chat-v2
   * behavior.
   */
  captureToolSnapshot?: boolean;
  /**
   * Resolved Project-Environment skills for this turn (Phase 1.4), HARNESS
   * side. Forwarded verbatim to `handleMCPJamFreeChatModel` → `runHarnessTurn`,
   * where presence (even empty) skips the live project-wide skills fetch.
   *
   * It lives on the persist context rather than the prepare inputs because the
   * harness path is reached through the persist/stream half of this helper —
   * the same place `harness` and `executionScope` already travel.
   */
  runtimeSkillsOverride?: RuntimeSkill[];
  /**
   * The same turn's `EffectiveCapabilitySet`, HARNESS side (INS-7). Paired with
   * `runtimeSkillsOverride`: the flat list is what the adapter writes to disk,
   * this is what the Computer delivery path needs on top of it — the resolved
   * per-skill supporting files (including plugin ones, which the project-wide
   * file query cannot return) and the pinned plugin versions that make a
   * resumed sandbox with stale plugin material ineligible.
   */
  effectiveCapabilities?: EffectiveCapabilitySet;
  /**
   * The Project Environment this turn resolved, if any — the GRANT BOUNDARY for
   * project secrets.
   *
   * An id rather than the resolved spec, deliberately. `resolveEnvironmentForRuntime`
   * and `ResolvedEnvironmentRuntime` never carry secrets: `toEnvironmentPreview`
   * spreads nothing and must never see a value, and a resolved spec that could
   * carry one would put a credential on the same object every preview, log line
   * and telemetry field already reads. The harness turn fetches its own secrets
   * from Convex with the user's own bearer instead, and this is the only thing
   * it needs to do that.
   *
   * Absent ⇒ this turn has no grant, which is a normal state, not a failure.
   *
   * ALSO the direct-chat resume pin: written into
   * `resumeConfig.environmentId` so a reopened Playground conversation can be
   * restored onto the target it actually ran on rather than the viewer's
   * current selection. See the persist site below for why sending it on every
   * turn is safe.
   */
  environmentId?: string;
  /**
   * This turn's MATERIALIZED secrets, when the ROUTE already resolved them.
   *
   * Presence is semantic (even empty): supplied ⇒ do not fetch again. `chat-v2`
   * resolves them before it builds the emulated `bash` tool, so by the time
   * this helper runs the list already exists — and re-fetching would both cost
   * a second KMS decrypt and risk the scrubber registering a different set than
   * the box received. A caller that has not resolved them omits this and the
   * helper fetches from {@link environmentId}.
   */
  runtimeSecrets?: { name: string; value: string }[];
  /**
   * The secrets fetch FAILED — distinct from "this turn has none".
   *
   * Forces the harness runtime fingerprint to change, so the session forks onto
   * a fresh bridge instead of resuming one that may still hold previously
   * delivered values this process can no longer enumerate (and therefore could
   * not scrub out of the transcript). See `runtime-secrets.ts`.
   */
  secretsUnavailable?: boolean;
  /**
   * Fired when this turn's materialized secrets actually reach an execution
   * surface — a bash command that carries them, or a started harness session
   * holding them. Used to stamp delivery honestly; see `sandbox-bash`.
   */
  onSecretEnvDelivered?: () => void;
  /**
   * What this turn should RECORD about the configuration it ran with —
   * `{environmentAtTurn, skillsAtTurn}` from `turnSkillProvenance`, computed
   * from the POST-narrowing spec so it reflects what actually ran.
   *
   * Separate from `runtimeSkillsOverride` and `effectiveCapabilities` on
   * purpose: those decide what reaches the model, this only decides what gets
   * written down. Delivery is byte-identical whether this is present or not.
   */
  turnProvenance?: TurnSkillProvenance;
}

/**
 * `prepareChatV2` inputs. Mirrors the orchestration option shape but typed
 * here so the helper signature is self-contained.
 */
export interface WebChatTurnPrepareInputs {
  selectedServerIds: string[];
  modelDefinition: ModelDefinition;
  systemPrompt?: string;
  temperature?: number;
  requireToolApproval?: boolean;
  respectToolVisibility?: boolean;
  /**
   * MCP tool names this surface declines to advertise, whichever selected
   * server offers them. See `PrepareChatV2Options.excludeMcpToolNames`.
   */
  excludeMcpToolNames?: readonly string[];
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  customProviders?: CustomProviderConfig[];
  /** UI messages from the inbound request, converted to ModelMessages by helper. */
  uiMessages: UIMessage[] | unknown[];
  /** Optional progressive-discovery override. */
  progressiveToolDiscovery?: { enabled: boolean };
  /** Resolved host harness. Harness runtimes own native tool discovery. */
  harness?: Harness;
  /**
   * Resolved task-seam options. The CALLER resolves the mode, because hosted
   * chat and the MCPJam agent both come through here and are different rows in
   * the policy matrix. Absent ⇒ tasks off for this turn.
   */
  tasks?: ToolTaskSeamOptions;
  appTools?: AppToolEntry[];
  /** WebMCP-shaped MCPJam UI tools (client-fulfilled, like `appTools`). */
  uiTools?: UiToolEntry[];
  /** Server-side built-in tools (e.g. web_search) to merge into the tool set. */
  builtInTools?: ToolSet;
  /**
   * Approval classification for the `browser_*` tools this turn advertises,
   * produced by `resolveHostTools`. Merged with the `ui_*` classification
   * below: the engines have ONE `uiToolApprovals` slot, and whichever
   * namespace filled it alone left the other falling through to the
   * `requireToolApproval` default (off by default) — which strands a turn
   * whose gated call never gets its approval request.
   */
  browserToolApprovals?: UiToolApprovalClassification;
  /** Host-configured computer working directory (COMP-16); roots the harness
   *  Shell under the same dir the bash tool runs in. */
  computerWorkdir?: string;
  widgetModelContext?: WidgetModelContextEntry[];
  /**
   * Whether this turn's `effectiveCapabilities` describe a LIVE surface rather
   * than a captured environment.
   *
   * A live turn also composes SEP-2640 skills from its connected servers; an
   * environment turn does not, because its server skills were captured and
   * fetching more would falsify the snapshot. Set by the hosted chat route for
   * its host/adhoc targets, which resolve no environment at all.
   */
  liveSkillSurface?: boolean;
  /**
   * Resolved Project-Environment skills for this turn (Phase 1.4), EMULATED
   * side. When set (even empty) they are the only skills the emulated engine
   * advertises: `prepareChatV2` receives them as `skillsSource: "resolved"`,
   * which is now the ONLY skill source `prepareChatV2` accepts.
   *
   * Ignored when `harness` is set: a harness turn delivers skills natively
   * through the adapter (see `WebChatTurnPersistContext.runtimeSkillsOverride`),
   * and advertising emulated skill tools there is a prompt/tool mismatch.
   *
   * INS-3: this stays the HARNESS-shaped list (name/description/content, which
   * is all an adapter writes to disk). The emulated side takes
   * {@link WebChatTurnPrepareInput.effectiveCapabilities} instead, because its
   * tools address skills by ref and need the plugin origin this list drops.
   */
  runtimeSkillsOverride?: RuntimeSkill[];
  /**
   * The turn's resolved `EffectiveCapabilitySet` (INS-3). Set alongside
   * `runtimeSkillsOverride` for an environment turn; drives the EMULATED skill
   * tools (ref-addressed, plugin-origin-aware, supporting-file capable).
   *
   * Presence is what makes it authoritative — a set that resolves zero skills
   * advertises zero, and never falls back to the project-wide pool.
   */
  effectiveCapabilities?: EffectiveCapabilitySet;
}

/** Runtime knobs (auth, abort, rpc collector, Hono context for cleanup). */
export interface WebChatTurnRuntime {
  /** Authorization header (Bearer …) — forwarded to ingest + stream calls. */
  authHeader: string | undefined;
  clientIp: string | null;
  abortSignal: AbortSignal | undefined;
  /** Hosted RPC log collector — attached to the stream writer. Optional. */
  rpcCollector?: RpcCollector;
  /**
   * Hosted elicitation bridge — attached to the stream writer alongside the
   * RPC collector, and disposed on stream completion. Present only for
   * interactive turns whose host declares the elicitation capability AND whose
   * client speaks the hosted-elicitation handshake; see `chat-v2.ts`.
   */
  elicitationBridge?: HostedElicitationBridge;
  /**
   * Hosted MRTR (§12.5, PR5) bridge — attached to the stream writer so the
   * suspending collector can emit `data-mrtr-input-required` parts. Present only
   * for emulated-engine turns whose host declares elicitation AND whose client
   * speaks the MRTR handshake. Continuations are durable, so unlike the
   * elicitation bridge it is NOT disposed at end of turn.
   */
  mrtrBridge?: HostedMrtrBridge;
  /**
   * Delivers `data-task-created` parts. Present only when the host policy
   * enables tasks for this surface AND the client sent a compatible
   * `hostedTasksVersion`. A mismatch leaves this undefined — the turn proceeds
   * without the part rather than failing, because the task already exists.
   */
  taskCreatedBridge?: HostedTaskCreatedBridge;
  /**
   * Hosted MRTR resume descriptor — forwarded to the emulated engine only. On a
   * fresh resume request the engine drives one retry leg before the first model
   * call and splices the driven result. Emulated MCPJam engine only.
   */
  mrtrResume?: MrtrEngineResume;
  /**
   * Durable SEP-2350 chat suspension context. The bearer never reaches the
   * browser; it is used only for the opaque Convex continuation store.
   */
  scopeStepUp?: {
    bearer: string;
    authPrincipal: string;
    resumeRequest?: ScopeStepUpResumeRequest;
    cancelRequest?: ScopeStepUpCancelRequest;
  };
  /**
   * One-time notices about this conversation's ephemeral sandbox, PEEKED from
   * the control plane by the caller (chat-v2 provisions before the stream
   * exists, so it cannot emit them itself).
   *
   * Flushed once, at `onStreamWriterReady`, on whichever engine this turn takes
   * — they describe the machine, not the model — and ACKED immediately after
   * the write, which is what marks them delivered. Until that ack lands they
   * remain pending server-side, so a turn that dies before streaming re-delivers
   * them next time instead of losing them.
   */
  sandboxNotices?: SandboxNoticeReason[];
  /**
   * Acks the notices above once they are on the wire. Supplied by the caller
   * (it holds the bearer and the sandbox row id); absent when the backend
   * already consumed them at provision time (legacy fused path).
   *
   * Best-effort: a failed ack re-delivers, which is the correct direction to
   * fail for "your sandbox was reset, earlier files are gone".
   */
  ackSandboxNotices?: (notices: SandboxNoticeReason[]) => void;
  /** Hono context (needed for getClientIp fallback / future hooks). */
  c: Context;
}

/**
 * A stream writer that can optionally report whether the stream is still open.
 * `isClosed` is implemented by the emulated engine's no-throw `safeWriter`; the
 * other engines pass a writer that throws on a dead controller, which the
 * try/catch handles instead.
 */
type SandboxNoticeWriter = ElicitationChunkWriter & {
  isClosed?: () => boolean;
};

/**
 * Flush the turn's sandbox notices onto the freshly-ready stream writer, then
 * ACK the ones that actually made it out.
 *
 * The ack is what closes the delivery gap: the control plane keeps a notice
 * pending until this point, so a turn that dies before the writer exists
 * re-delivers it rather than losing it. Only notices actually DELIVERED are
 * acked.
 *
 * "Delivered" cannot be inferred from `write()` returning normally. The
 * emulated engine hands us `safeWriter` (mcpjam-stream-handler.ts), which is
 * deliberately no-throw — it swallows controller failures and silently no-ops
 * once the stream is closed, so that a client disconnect cannot bring down the
 * agentic loop. Trusting a clean return there would let us ack (and therefore
 * permanently consume) a notice the browser never received. So the writer is
 * asked directly via {@link SandboxNoticeWriter.isClosed}, and the abort signal
 * is consulted too.
 *
 * Best-effort per notice in both directions: neither a failed write nor a
 * failed ack may take down a turn whose only problem is that we couldn't
 * narrate the machine. Bailing out early costs a duplicate notice next turn,
 * never a lost one.
 */
function emitSandboxNotices(
  writer: SandboxNoticeWriter | null | undefined,
  notices: SandboxNoticeReason[] | undefined,
  ack?: (delivered: SandboxNoticeReason[]) => void,
  abortSignal?: AbortSignal,
): void {
  if (!writer || !notices?.length) return;
  const closed = () => writer.isClosed?.() === true || abortSignal?.aborted;
  const delivered: SandboxNoticeReason[] = [];
  for (const reason of notices) {
    if (closed()) break;
    try {
      writer.write({
        type: SANDBOX_NOTICE_DATA_PART_TYPE,
        data: { reason },
        transient: true,
      } as unknown as UIMessageChunk);
      // Re-checked AFTER the write: this is the call that may have discovered
      // the stream was gone, and the chunk that discovered it did not land.
      if (closed()) break;
      delivered.push(reason);
    } catch (error) {
      logger.warn("[chat] sandbox notice stream write failed", {
        reason,
        error,
      });
    }
  }
  if (delivered.length > 0) ack?.(delivered);
}

export interface StreamWebChatTurnArgs {
  manager: InstanceType<typeof MCPClientManager>;
  prepare: WebChatTurnPrepareInputs;
  persist: WebChatTurnPersistContext;
  runtime: WebChatTurnRuntime;
}

/**
 * Drop rendered UI-context blocks from history on its way to storage.
 *
 * Persistence stores CONVERTED ModelMessages, not UI messages — by then the
 * data part is already the text block the model read. Left in, it would come
 * back on reload as visible text the user appears to have typed, and the
 * client re-attaches fresh context to the next turn anyway.
 *
 * Only exact, whole text parts produced by `renderUiContextText` are
 * removed, and only from USER messages. Never a substring replace: a user who
 * types the marker into chat keeps their message intact.
 */
export function stripUiContextModelParts(
  messages: ModelMessage[],
): ModelMessage[] {
  let changed = false;
  const out = messages.map((message) => {
    if (message?.role !== "user" || !Array.isArray(message.content)) {
      return message;
    }
    const content = message.content.filter(
      (part) =>
        !(
          part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          isRenderedUiContextText((part as { text?: unknown }).text)
        ),
    );
    if (content.length === message.content.length) return message;
    changed = true;
    return { ...message, content } as ModelMessage;
  });
  return changed ? out : messages;
}

/**
 * Per-tool approval policy for this turn's `ui_*` tools, from the VALIDATED
 * snapshot's MCP annotations — never from the raw name, which a third-party
 * server could spoof. Must be fed prepareChatV2's `effectiveUiTools` (the
 * post-collision set), not the raw snapshot: a server-executed `ui_*` tool
 * that won its name collision follows ordinary approval semantics. Consumed
 * by the MCPJam loop's approval gate (see `toolCallNeedsApproval` in
 * mcpjam-stream-handler); the BYOK `streamText` path gets the same policy
 * baked into each tool's `needsApproval` by `buildUiTools`.
 */
function uiToolApprovalsFrom(
  uiTools: UiToolEntry[] | undefined,
  requireToolApproval: boolean | undefined,
  browserToolApprovals?: UiToolApprovalClassification,
): UiToolApprovalClassification {
  return mergeUiToolApprovalClassifications(
    classifyUiToolApprovals(uiTools, requireToolApproval === true),
    browserToolApprovals,
  );
}

/**
 * Run a single web-chat streaming turn.
 *
 * Returns the streaming Response. Throws WebRouteError / runtime errors;
 * the caller is responsible for disconnecting the manager on the throw
 * path and mapping the error to a `webError(...)` response.
 */
export async function streamWebChatTurn(
  args: StreamWebChatTurnArgs,
): Promise<Response> {
  const { manager, prepare, persist, runtime } = args;
  const { c } = runtime;
  // Mid-stream failures happen after this route has already returned a 200
  // stream, where the HTTP failure events can't see them. The request-scoped
  // reporter gives every engine below one typed route.operation.failed path
  // carrying the full request envelope (orgId/route/requestId/release).
  const failureReporter = createRequestStreamFailureReporter(c, "chat");

  // Guard the env once at the top — both branches POST to Convex.
  if (!process.env.CONVEX_HTTP_URL) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration",
    );
  }

  const sessionStartedAt = Date.now();
  // Convert UI messages to ModelMessage[] up front so prepareChatV2 can
  // replay prior `load_mcp_tools` calls into discovery state.
  const modelMessages = await convertToMcpjamModelMessages(
    prepare.uiMessages as never,
    {
      modelVisibleMcpToolResults: prepare.modelVisibleMcpToolResults,
      // Browser-sent history can replay already-resolved media, but must not
      // trigger new linked resource reads. Fresh server-side tool execution
      // resolves resource_link results through trusted tool-origin metadata.
      abortSignal: c.req.raw.signal as AbortSignal | undefined,
    },
  );

  let prepared;
  try {
    prepared = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: prepare.selectedServerIds,
      modelDefinition: prepare.modelDefinition,
      systemPrompt: prepare.systemPrompt,
      temperature: prepare.temperature,
      requireToolApproval: prepare.requireToolApproval,
      respectToolVisibility: prepare.respectToolVisibility,
      ...(prepare.excludeMcpToolNames
        ? { excludeMcpToolNames: prepare.excludeMcpToolNames }
        : {}),
      modelVisibleMcpToolResults: prepare.modelVisibleMcpToolResults,
      customProviders: prepare.customProviders,
      priorMessages: modelMessages,
      ...(prepare.harness ? { harness: prepare.harness } : {}),
      ...(prepare.tasks ? { tasks: prepare.tasks } : {}),
      ...(prepare.progressiveToolDiscovery !== undefined
        ? { progressiveToolDiscovery: prepare.progressiveToolDiscovery }
        : {}),
      appTools: prepare.appTools,
      uiTools: prepare.uiTools,
      builtInTools: prepare.builtInTools,

      // Environment-resolved skills outrank the cloud/HOSTED/local chain for the
      // EMULATED engine only. On a harness turn the adapter delivers them
      // natively, so advertising emulated `loadSkill` (+ file tools) on top would describe
      // a second, different delivery of the same set to the same model.
      ...(prepare.effectiveCapabilities !== undefined && !prepare.harness
        ? {
            skillsSource: {
              kind: "resolved" as const,
              capabilities: prepare.effectiveCapabilities,
              ...(prepare.liveSkillSurface
                ? { composeLiveServerSkills: true as const }
                : {}),
              // So a supporting-file read stops when the client disconnects
              // instead of holding a worker for its full fetch timeout.
              ...(runtime.abortSignal
                ? { abortSignal: runtime.abortSignal }
                : {}),
            },
          }
        : {}),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("Invalid tool name(s) for Anthropic")) {
      throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, msg);
    }
    throw error;
  }

  const {
    allTools: preparedTools,
    enhancedSystemPrompt,
    resolvedTemperature,
    scrubMessages,
    progressivePlan,
    discoveryState,
    effectiveUiTools,
  } = prepared;

  // The raw per-turn stream writer, captured at `onStreamWriterReady` below.
  // Present for EVERY turn that produces a stream, independent of the
  // elicitation gate — so the display-only `insufficient_scope` notice can fire
  // even for a host that never advertised elicitation (hence has no bridge).
  let scopeChallengeWriter: ElicitationChunkWriter | null = null;

  // SEP-2350 id→display-name map for the writer-only step-up fallback (no
  // elicitation bridge). Built from the SAME `selectedServerIds`/
  // `selectedServerNames` pair the bridge uses (`chat-v2.ts`), so a hosted
  // dashboard turn — whose `serverId` is a Convex document id — resolves to the
  // display name the client keys `appState.servers` by. Without this the
  // fallback would emit an id-only event that never matches the name-keyed
  // client store and step-up would silently no-op.
  const scopeStepUpServerNamesById =
    buildServerNamesById(
      persist.selectedServerIds,
      persist.selectedServerNames,
    ) ?? {};
  let suspendedScopeStepUpToolCallId: string | undefined;
  const scopeStepUpResume =
    runtime.scopeStepUp?.resumeRequest && persist.chatSessionId
      ? buildHostedScopeStepUpResume({
          request: runtime.scopeStepUp.resumeRequest,
          bearer: runtime.scopeStepUp.bearer,
          authPrincipal: runtime.scopeStepUp.authPrincipal,
          projectId: persist.projectId,
          chatSessionId: persist.chatSessionId,
          manager,
          messages: modelMessages,
          tools: preparedTools,
          modelVisibleMcpToolResults: prepare.modelVisibleMcpToolResults,
          abortSignal: runtime.abortSignal,
        })
      : runtime.scopeStepUp?.cancelRequest
      ? buildHostedScopeStepUpCancellation({
          request: runtime.scopeStepUp.cancelRequest,
          bearer: runtime.scopeStepUp.bearer,
          messages: modelMessages,
          tools: preparedTools,
        })
      : undefined;
  const createScopeStepUpContinuation =
    runtime.scopeStepUp && persist.chatSessionId
      ? async ({
          info,
          toolName,
          toolInput,
        }: {
          info: Parameters<
            typeof createHostedScopeStepUpContinuation
          >[0]["info"];
          toolName: string;
          toolInput: unknown;
        }) => {
          const event = await createHostedScopeStepUpContinuation({
            bearer: runtime.scopeStepUp!.bearer,
            authPrincipal: runtime.scopeStepUp!.authPrincipal,
            projectId: persist.projectId,
            chatSessionId: persist.chatSessionId!,
            manager,
            serverName: scopeStepUpServerNamesById[info.serverId],
            info,
            toolName,
            toolInput,
            abortSignal: runtime.abortSignal,
          });
          suspendedScopeStepUpToolCallId = event.toolCallId;
          return event;
        }
      : undefined;

  /**
   * Observe in-process tool-call failures from every ToolSet-driven engine to
   * surface out-of-band notices.
   *
   * Wrapped here, on the tool set, rather than in the engines: `prepareChatV2`
   * builds this set once and all three consumers share it (MCPJam-free,
   * org-BYOK local, org-BYOK hosted). The org branches run `runDirectChatTurn`,
   * where the AI SDK owns the tool loop and never touches the shared
   * `executeToolCallsFromMessages` catch — so an engine-level hook compiled
   * fine and silently never fired for BYOK users, who advertise and handle
   * elicitation like everyone else.
   *
   * Wrapped UNCONDITIONALLY (not gated on the elicitation bridge): each emit
   * guards on its own channel. `url_required` still rides the bridge only, so it
   * stays a no-op without one — identical to before. `insufficient_scope` is a
   * display-only step-up notice that must fire whether or not elicitation was
   * advertised, so it falls back to the raw stream writer when there is no
   * bridge (SEP-2350).
   *
   * Harness MCP-server tools execute out of process through `.mcp.json` and
   * therefore use the correlated harness-proxy side channel instead. Host-
   * executed harness tools still pass through this set.
   *
   * The shared wrapper rethrows always: this only observes. The engines' own
   * error handling still produces the tool result the model sees.
   */
  const allTools = wrapToolsWithScopeStepUp(
    preparedTools,
    () => scopeChallengeWriter,
    {
      onToolError: ({ error, serverId, toolCallId }) => {
        const elicitations = readUrlElicitations(error);
        if (elicitations) {
          runtime.elicitationBridge?.emitUrlRequired({
            serverId,
            toolCallId,
            elicitations,
          });
        }
      },
      emitInsufficientScope: (challenge) => {
        if (runtime.elicitationBridge) {
          // Bridge enriches with the server name from its id→name map.
          runtime.elicitationBridge.emitInsufficientScope(challenge);
        } else {
          // No bridge (elicitation unadvertised): still surface the step-up
          // display-only on the raw writer. Resolve the display name from the
          // same id→name map the bridge uses so a hosted Convex `serverId`
          // matches the name-keyed client store.
          emitInsufficientScopeChunk(
            scopeChallengeWriter,
            scopeStepUpServerNamesById[challenge.serverId],
            challenge,
          );
        }
      },
      ...(createScopeStepUpContinuation
        ? {
            createContinuation: ({ info, toolName, toolInput }) =>
              createScopeStepUpContinuation({
                info: { ...info, toolCallId: info.toolCallId! },
                toolName,
                toolInput,
              }),
          }
        : {}),
    },
  );

  const widgetModelContextSystemPrompt = buildWidgetModelContextSystemPrompt(
    prepare.widgetModelContext ?? [],
  );
  const effectiveEnhancedSystemPrompt = [
    enhancedSystemPrompt,
    widgetModelContextSystemPrompt,
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");

  const hostedChatSessionId = persist.chatSessionId;

  // MATERIALIZED PROJECT SECRETS for this turn, fetched ONCE here because two
  // very different things need the same list and must not disagree about it:
  //
  //   1. the SANDBOX, which receives the values as environment variables (the
  //      harness turn takes them via `runtimeSecrets` below);
  //   2. the SCRUBBER, which replaces those same values with `[secret:NAME]`
  //      in everything this turn persists.
  //
  // Two fetches would mean two KMS decrypts per turn AND a window where the
  // registry is missing something the box already has — which is the one way
  // this feature leaks by accident. Values that reach the box but not the
  // registry are values that get written to the transcript verbatim.
  //
  // ONE RESOLUTION PER TURN, and a caller's FAILURE is a resolution.
  //
  // The tri-state has three answers, and all three have to survive the trip:
  // secrets, none, or "could not find out". An earlier version keyed only on
  // `runtimeSecrets !== undefined`, which conflated the third with "the caller
  // did not resolve" — so a caller that fetched and FAILED fell through to the
  // fetch below and got a second attempt.
  //
  // That second attempt is what made it dangerous rather than merely wasteful.
  // If it SUCCEEDED, this turn delivered real secrets into the box while the
  // caller's established failure still forced `secretsUnavailable`, so the
  // session persisted the `"unavailable"` fingerprint. A later turn whose
  // fetches both fail computes that same fingerprint, RESUMES that
  // secret-bearing bridge, and has no list to build a scrubber from — the exact
  // unscrubbed resume the fork was introduced to prevent, reached by way of a
  // recovery.
  //
  // So an established failure short-circuits: no retry, no delivery, and the
  // fingerprint that says "unavailable" is only ever persisted by a turn that
  // genuinely delivered nothing.
  const secretsFetch = await resolveTurnRuntimeSecrets({
    ...(persist.runtimeSecrets !== undefined
      ? { callerSecrets: persist.runtimeSecrets }
      : {}),
    ...(persist.secretsUnavailable === true ? { callerUnavailable: true } : {}),
    fetch: () =>
      fetchRuntimeSecrets(runtime.authHeader, {
        ...(persist.projectId ? { projectId: persist.projectId } : {}),
        ...(persist.environmentId
          ? { environmentId: persist.environmentId }
          : {}),
        ...(hostedChatSessionId ? { chatSessionId: hostedChatSessionId } : {}),
      }),
  });
  const runtimeSecrets = secretsFetch.ok ? secretsFetch.secrets : null;
  // A failed fetch here forks the session for the same reason it does in
  // `chat-v2`: we cannot enumerate what the box may already hold. Now exactly
  // equivalent to `!secretsFetch.ok` — the caller's failure is already folded
  // in above — and kept as one expression so the invariant is stated once.
  const secretsUnavailable = !secretsFetch.ok;
  const secretScrubber = runtimeSecrets
    ? createSecretScrubber(runtimeSecrets)
    : null;

  const cleanupStream = async () => {
    // Withdraw pending elicitation rows BEFORE dropping the connections: once
    // the stream is gone nobody can answer, and an abandoned row would stay
    // answerable until its TTL. Disposal is best-effort and must never block
    // the disconnect, so failures are swallowed inside the bridge.
    await runtime.elicitationBridge?.dispose();
    await manager.disconnectAllServers();
  };

  const isScenarioSession = persist.sourceType === "scenario";
  // Provider is REQUIRED here: bare hosted ids (`gpt-5-nano` + `openai`) only
  // canonicalize to their prefixed form (`openai/gpt-5-nano`) when the provider
  // is supplied. Without it, a bare id fails this check and the turn silently
  // branches into org-BYOK — skipping runHarnessTurn even when the route's
  // harness preflight (which does pass the provider) approved the turn.
  const isMCPJam =
    Boolean(prepare.modelDefinition.id) &&
    isHostedCatalogModel(
      String(prepare.modelDefinition.id),
      prepare.modelDefinition.provider,
    );
  // …OR an EXTERNAL-ACCOUNT harness, whose host carries a sentinel model
  // (`cursor/auto`) that is deliberately not MCPJam-hosted.
  //
  // Without this the branch below sends a Cursor turn down the org-BYOK path,
  // which never reaches `runHarnessTurn` at all: the harness pre-flight would
  // approve the turn and the turn would then run on a completely different
  // engine, reported as Cursor. `deriveOrgProviderKeyResult` would also reject
  // `cursor/auto` outright, so the visible symptom is a 400 on a host the
  // product just told the user was ready.
  //
  // Not folded into `isMCPJam` itself: that name means "MCPJam pays for this
  // model", and an external-account turn is exactly the case where it does not.
  // The two reasons to take the non-BYOK branch are different facts, so they
  // stay separate values.
  const isExternalAccountHarnessTurn =
    !!persist.harness && harnessUsesExternalAccount(persist.harness);
  const usesMcpjamFreePath = isMCPJam || isExternalAccountHarnessTurn;

  // Resolve the host config now that `resolvedTemperature` is known.
  // Legacy chat-v2 fed `resolvedTemperature` into `buildDirectHostConfig`;
  // callers preserve that by passing a closure here.
  const resolvedHostConfig: DirectHostConfig | null =
    typeof persist.hostConfig === "function"
      ? persist.hostConfig({ resolvedTemperature }) ?? null
      : persist.hostConfig ?? null;

  // Build the persist callback once — it's a closure over a lot of context
  // and is identical between MCPJam-free and org-BYOK other than the modelId
  // + modelSource.
  const buildOnConversationComplete = (
    modelId: string,
    modelSource: "mcpjam" | "byok" | "local_byok" | "external-account",
  ) => {
    if (!hostedChatSessionId) return undefined;
    return async (
      fullHistory: ModelMessage[],
      turnTrace: PersistedTurnTrace,
      harnessSessionCommit?: HarnessSessionCommitPayload,
    ) => {
      const isDirectChat = !isScenarioSession;
      // Capture the live tool catalog. Failures must never block the persist.
      // Surfaces with synthetic server ids (mcpjam-agent) opt out via
      // `persist.captureToolSnapshot === false`.
      let toolSnapshot: unknown;
      if (persist.captureToolSnapshot !== false) {
        try {
          const knownIds =
            typeof manager.hasServer === "function"
              ? persist.selectedServerIds.filter((id) => manager.hasServer(id))
              : persist.selectedServerIds;
          if (knownIds.length > 0) {
            toolSnapshot =
              await exportConnectedServerToolSnapshotForEvalAuthoring(
                manager,
                knownIds,
                { logPrefix: "chat-v2.persist" },
              );
          }
        } catch {
          toolSnapshot = undefined;
        }
      }

      // Returned, not discarded: the engine turns this into the turn's
      // `data-persist-receipt` so the client is TOLD what happened to its save
      // rather than inferring it from a version poll.
      return await persistChatSessionToConvex({
        chatSessionId: hostedChatSessionId,
        // Applied to the SERIALIZED ingest body, so it covers every payload
        // this call can carry — session messages, the tool snapshot, assistant
        // text, a nested JSON string a tool returned — without a per-field list
        // somebody has to remember to extend.
        ...(secretScrubber ? { secretScrubber } : {}),
        modelId,
        modelSource,
        projectId: persist.projectId,
        sourceType: persist.sourceType,
        origin: persist.origin,
        ...(isScenarioSession && persist.surface
          ? { surface: persist.surface }
          : {}),
        scenarioId: persist.scenarioId,
        authHeader: runtime.authHeader,
        // WHAT WAS SENT, for the Raw view and `get_chat_session` — distinct
        // from `resumeConfig.systemPrompt` below, which is what a RESUMED turn
        // replays.
        //
        // Those are different questions and the hosted path only ever answered
        // the second, so Raw showed the bare host prompt while the model had
        // been given more: the skills catalog, widget model context, the
        // environment block. A debugger that cannot show what the model was
        // told cannot answer "did it even know that skill existed?" — which is
        // the first question anyone asks when an agent ignores a skill.
        //
        // Resume must NOT read this one. Turn-injected content is true of the
        // turn that happened, not of the next one: replaying "your sandbox was
        // reset" long after the fact is the confabulation `resumeConfig`'s raw
        // prompt exists to prevent. Hence two fields, both already on the
        // ingest contract — the local route has always filled this one.
        systemPrompt: effectiveEnhancedSystemPrompt,
        sessionMessages: stampSenderUserIdsOnSessionMessages(
          stripUiContextModelParts(fullHistory),
          persist.originalMessages as unknown[],
          { authenticatedUserId: persist.authenticatedUserId },
        ),
        startedAt: sessionStartedAt,
        lastActivityAt: Date.now(),
        ...(toolSnapshot ? { toolSnapshot } : {}),
        ...(isDirectChat
          ? {
              directVisibility: persist.directVisibility,
              ...(persist.rewind ? { rewind: persist.rewind } : {}),
              resumeConfig: {
                systemPrompt: persist.systemPrompt,
                temperature: persist.temperature,
                requireToolApproval: persist.requireToolApproval,
                respectToolVisibility: persist.respectToolVisibility,
                modelVisibleMcpToolResults: prepare.modelVisibleMcpToolResults,
                mcpToolResultImageRendering:
                  persist.mcpToolResultImageRendering,
                selectedServers: resumableServers(persist),
                // WHAT THIS CONVERSATION RAN ON — the missing half of resume.
                //
                // Every other field here restores how the turn was configured;
                // none of them said WHERE it executed. So a browser Playground
                // conversation reopened later had no recorded execution target
                // at all, and the client fell back to whatever the VIEWER had
                // selected in localStorage — a conversation that ran on a
                // Cursor harness in a Project Environment reopened showing an
                // unrelated host and model, and a follow-up typed there ran on
                // that unrelated target without ever saying so.
                //
                // Only `origin: "api"` sessions wrote this before (see
                // `routes/v1/chat-session-turn.ts`), which is why the browser
                // half was blind.
                //
                // Sent on EVERY turn, not just the first, and that is correct:
                // `preserveAgentResumePins` makes the four
                // `AGENT_RESUME_PIN_KEYS` — this among them — first-write-wins
                // at the ingest boundary, so a continuation cannot repin a
                // conversation onto a different environment, while a session
                // that started before this field existed still gets filled in
                // on its next turn instead of staying unpinned forever.
                //
                // Absent ⇒ this turn had no environment (a plain host-mode or
                // untargeted turn). Nothing is written rather than a
                // placeholder: an empty pin would read as "recorded, and it
                // was nothing", which is exactly the false certainty the
                // client's "as-run configuration unavailable" disclosure
                // exists to avoid.
                ...(persist.environmentId
                  ? { environmentId: persist.environmentId }
                  : {}),
              },
              ...(resolvedHostConfig ? { hostConfig: resolvedHostConfig } : {}),
            }
          : {}),
        // Merged OUTSIDE the `isDirectChat` gate above: a scenario turn runs
        // through an environment too, and skipping it there would leave User
        // Testing's most environment-driven surface with no record of what it
        // ran. Distinct from `resumeConfig`, which is gated because it is the
        // restorable-resume surface; this is provenance and restores nothing.
        turnTrace: persist.turnProvenance
          ? { ...turnTrace, ...persist.turnProvenance }
          : turnTrace,
        ...(persist.expectedVersion !== undefined
          ? { expectedVersion: persist.expectedVersion }
          : {}),
        // §3: chat-backed harness resume-state commit, applied atomically with
        // the transcript inside the ingest mutation.
        ...(harnessSessionCommit ? { harnessSessionCommit } : {}),
        forwardHeaders: pickEnrichmentHeaders(c.req.raw.headers),
      });
    };
  };

  if (!usesMcpjamFreePath) {
    const providerKeyResult = deriveOrgProviderKeyResult(
      prepare.modelDefinition,
    );
    if (!providerKeyResult.ok) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        providerKeyResult.error,
      );
    }
    const providerKey = providerKeyResult.key;
    const modelId = String(prepare.modelDefinition.id);
    const scrubbedMessages = scrubMessages(modelMessages);

    // Cloud-only providers skip the /stream/org/resolve round-trip — the
    // answer is always "cloud" for those. See chat-v2 history for the
    // BYOK regression that motivated this fast path.
    const orgRuntime: OrgProviderRuntime = isLocalRuntimeEligible(providerKey)
      ? await resolveOrgProviderRuntime(
          persist.projectId,
          providerKey,
          modelId,
          {
            authHeader: runtime.authHeader,
            scenarioId: persist.scenarioId,
            accessVersion: persist.accessVersion,
            serverIds: persist.selectedServerIds,
          },
        )
      : { runtimeLocation: "cloud", providerKey };

    const onConversationComplete = buildOnConversationComplete(
      modelId,
      orgRuntime.runtimeLocation === "local" ? "local_byok" : "byok",
    );

    warnIfChatAbortSignalMissing(runtime.abortSignal, "web/chat-v2");

    if (orgRuntime.runtimeLocation === "local") {
      return handleLocalOrgChatModel({
        provider: orgRuntime.provider,
        failureReporter,
        projectId: persist.projectId,
        modelId,
        chatSessionId: hostedChatSessionId,
        sourceType: persist.sourceType,
        messages: scrubbedMessages,
        systemPrompt: effectiveEnhancedSystemPrompt,
        temperature: resolvedTemperature,
        tools: allTools as ToolSet,
        progressivePlan,
        discoveryState,
        authHeader: runtime.authHeader,
        scenarioId: persist.scenarioId,
        accessVersion: persist.accessVersion,
        selectedServers: persist.selectedServerIds,
        serverIds: persist.selectedServerIds,
        requireToolApproval: persist.requireToolApproval,
        onConversationComplete,
        onStreamComplete: cleanupStream,
        onStreamWriterReady: (writer) => {
          scopeChallengeWriter = writer;
          emitSandboxNotices(
            writer,
            runtime.sandboxNotices,
            runtime.ackSandboxNotices,
            runtime.abortSignal,
          );
          runtime.rpcCollector?.attachStreamWriter(writer);
          runtime.elicitationBridge?.attachStreamWriter(writer);
          runtime.taskCreatedBridge?.attachStreamWriter(writer);
        },
        ...(scopeStepUpResume ? { scopeStepUpResume } : {}),
        shouldPauseAfterStep: () =>
          suspendedScopeStepUpToolCallId !== undefined,
        suspendedToolCallId: () => suspendedScopeStepUpToolCallId,
        abortSignal: runtime.abortSignal,
      });
    }

    return handleHostedOrgChatModel({
      projectId: persist.projectId,
      failureReporter,
      providerKey: orgRuntime.providerKey,
      modelId,
      chatSessionId: hostedChatSessionId,
      sourceType: persist.sourceType,
      messages: scrubbedMessages,
      systemPrompt: effectiveEnhancedSystemPrompt,
      temperature: resolvedTemperature,
      tools: allTools as ToolSet,
      progressivePlan,
      discoveryState,
      authHeader: runtime.authHeader,
      clientIp: runtime.clientIp ?? getClientIp(c),
      scenarioId: persist.scenarioId,
      accessVersion: persist.accessVersion,
      mcpClientManager: manager,
      selectedServers: persist.selectedServerIds,
      serverIds: persist.selectedServerIds,
      requireToolApproval: persist.requireToolApproval,
      uiToolApprovals: uiToolApprovalsFrom(
        effectiveUiTools,
        persist.requireToolApproval,
        prepare.browserToolApprovals,
      ),
      modelVisibleMcpToolResults: prepare.modelVisibleMcpToolResults,
      onConversationComplete,
      onStreamComplete: cleanupStream,
      onStreamWriterReady: (writer) => {
        scopeChallengeWriter = writer;
        emitSandboxNotices(
          writer,
          runtime.sandboxNotices,
          runtime.ackSandboxNotices,
          runtime.abortSignal,
        );
        runtime.rpcCollector?.attachStreamWriter(writer);
        runtime.elicitationBridge?.attachStreamWriter(writer);
        runtime.taskCreatedBridge?.attachStreamWriter(writer);
      },
      ...(scopeStepUpResume ? { scopeStepUpResume } : {}),
      abortSignal: runtime.abortSignal,
    });
  }

  // MCPJam-free path.
  const mcpjamModelId = String(prepare.modelDefinition.id);
  // …except when the HARNESS pays for its own model. An external-account
  // runtime (Cursor) reaches its provider on the customer's account with the
  // runtime vendor, so MCPJam is not charged for the turn and must not record
  // it as though it were — `'mcpjam'` is what makes a turn consume the org's
  // MCPJam spend limit.
  //
  // `'external-account'` rather than `'byok'`, though both mean "not charged to
  // MCPJam": byok additionally asserts a configured model PROVIDER and its key,
  // which this turn does not have. See `chatModelSourceValidator` in the
  // backend for the two surfaces that read it that way.
  const onConversationComplete = buildOnConversationComplete(
    mcpjamModelId,
    isExternalAccountHarnessTurn ? "external-account" : "mcpjam",
  );
  warnIfChatAbortSignalMissing(runtime.abortSignal, "web/chat-v2");

  // Harness MCP proxy — WEB-AUTHORIZED plane: this is an /api/web request, so
  // the harness reaches MCPJam either directly (public inspector) or via a
  // scoped harness-web relay (private/dev inspector), decided purely by whether
  // the inspector is publicly reachable. The token (with the user's identity) is
  // minted by Convex from the same bearer. If relay infra is needed but absent,
  // the turn fails closed later, at tunnel creation.
  const harnessMcpProxy: HarnessMcpProxyStrategy | undefined = persist.harness
    ? resolveWebAuthorizedHarnessStrategy()
    : undefined;

  // Harness observation: the turn's MCP traffic arrives as separate
  // `/api/web/harness-mcp` requests (not through THIS request's manager), so
  // bridge the in-process rpc-log bus into this turn's collector while the
  // stream is live — the Logs panel then fills exactly like an emulated turn.
  // Subscribed at stream start (not before — a pre-stream failure must not
  // leave a live subscription) and torn down with the stream.
  let stopHarnessRpcLogBridge: (() => void) | undefined;
  // COMP-21: cross-instance half of the harness log bridge (polls the shared
  // Convex sink for frames other instances produced). Paired with the bus bridge.
  let stopCrossInstanceRpcLogPoll: (() => void) | undefined;

  return handleMCPJamFreeChatModel({
    messages: modelMessages,
    failureReporter,
    modelId: mcpjamModelId,
    provider: prepare.modelDefinition.provider,
    chatSessionId: hostedChatSessionId,
    sourceType: persist.sourceType,
    systemPrompt: effectiveEnhancedSystemPrompt,
    temperature: resolvedTemperature,
    tools: allTools as ToolSet,
    progressivePlan,
    discoveryState,
    authHeader: runtime.authHeader,
    clientIp: runtime.clientIp ?? getClientIp(c),
    scenarioId: persist.scenarioId,
    accessVersion: persist.accessVersion,
    projectId: persist.projectId,
    // Phase 3: thread the runtime-config execution scope into the harness path
    // (sandbox reserve, skills, broker, session-state, commit).
    ...(persist.executionScope
      ? { executionScope: persist.executionScope }
      : {}),
    mcpClientManager: manager,
    selectedServers: persist.selectedServerIds,
    requireToolApproval: persist.requireToolApproval,
    uiToolApprovals: uiToolApprovalsFrom(
      effectiveUiTools,
      persist.requireToolApproval,
      prepare.browserToolApprovals,
    ),
    modelVisibleMcpToolResults: prepare.modelVisibleMcpToolResults,
    // Harness engine only: it builds its own MCP tool set (host-executed
    // delivery) rather than consuming `allTools`, so the host's
    // tool-construction policies have to reach it separately. Inert on the
    // emulated path, which is handed tools already built by prepareChatV2.
    ...(prepare.respectToolVisibility !== undefined
      ? { respectToolVisibility: prepare.respectToolVisibility }
      : {}),
    ...(prepare.tasks ? { tasks: prepare.tasks } : {}),
    ...(persist.harness ? { harness: persist.harness } : {}),
    // Presence is semantic (even an empty array): the harness turn then skips
    // the live project-wide skills fetch entirely.
    ...(persist.runtimeSkillsOverride !== undefined
      ? { runtimeSkillsOverride: persist.runtimeSkillsOverride }
      : {}),
    ...(persist.effectiveCapabilities
      ? { effectiveCapabilities: persist.effectiveCapabilities }
      : {}),
    ...(persist.environmentId ? { environmentId: persist.environmentId } : {}),
    // Presence is semantic, exactly like `runtimeSkillsOverride`: supplied
    // (even empty) means "this turn's secrets are already resolved".
    //
    // ABSENT MEANS NO SECRETS ARE DELIVERED — it does not mean somebody else
    // fetches them. `run-harness-turn` takes the list from its caller and never
    // reads Convex itself (`runtimeSecretsOverride ?? null`), deliberately, so
    // that delivery and transcript-scrubbing come from ONE read. A driver that
    // has not wired secrets therefore runs with an empty env bag, silently.
    // That is fail-closed, and it is exactly why the eval and swarm drivers
    // need wiring rather than inheriting this for free.
    ...(runtimeSecrets !== null ? { runtimeSecrets } : {}),
    ...(secretsUnavailable ? { secretsUnavailable: true } : {}),
    ...(persist.onSecretEnvDelivered
      ? { onSecretEnvDelivered: persist.onSecretEnvDelivered }
      : {}),
    ...(harnessMcpProxy ? { harnessMcpProxy } : {}),
    // Hosted MRTR (§12.5) resume: emulated engine only. On a fresh resume
    // request the engine drives one retry leg (reconstructing tool
    // output-schema validation) before the first model call, splices the
    // driven result, and resumes the loop to a final assistant message.
    ...(runtime.mrtrResume ? { mrtrResume: runtime.mrtrResume } : {}),
    ...(scopeStepUpResume ? { scopeStepUpResume } : {}),
    ...(persist.harness && createScopeStepUpContinuation
      ? {
          createHarnessScopeStepUpContinuation: createScopeStepUpContinuation,
        }
      : {}),
    // Forwarded SEPARATELY (also merged into `tools` for the emulated engine)
    // so the harness path can hand MCPJam's server-executed built-ins
    // (web_search) to HarnessAgent without the MCP-server tools, which the
    // harness gets via .mcp.json.
    ...(prepare.builtInTools ? { builtInTools: prepare.builtInTools } : {}),
    // COMP-16: root the harness Shell at the host-configured working directory
    // (same source as the bash tool's cwd).
    ...(prepare.computerWorkdir
      ? { computerWorkdir: prepare.computerWorkdir }
      : {}),
    abortSignal: runtime.abortSignal,
    onConversationComplete,
    onStreamComplete: async () => {
      stopHarnessRpcLogBridge?.();
      stopHarnessRpcLogBridge = undefined;
      stopCrossInstanceRpcLogPoll?.();
      stopCrossInstanceRpcLogPoll = undefined;
      await cleanupStream();
    },
    onStreamWriterReady: (writer) => {
      scopeChallengeWriter = writer;
      emitSandboxNotices(
        writer,
        runtime.sandboxNotices,
        runtime.ackSandboxNotices,
        runtime.abortSignal,
      );
      runtime.rpcCollector?.attachStreamWriter(writer);
      // NOTE: for HARNESS hosts this writer exists but elicitation still won't
      // fire — harness MCP traffic goes through separate /api/web/harness-mcp
      // requests, not this turn's manager, so the callback is never invoked.
      // Attaching is harmless and keeps the three sites uniform.
      runtime.elicitationBridge?.attachStreamWriter(writer);
      // MRTR suspend emits `data-mrtr-input-required` on this same stream.
      runtime.mrtrBridge?.attachStreamWriter(writer);
      // A task can be created on ANY engine path, so unlike the MRTR bridge
      // this one attaches at all three sites, following the elicitation bridge.
      runtime.taskCreatedBridge?.attachStreamWriter(writer);
      if (persist.harness && runtime.rpcCollector && !stopHarnessRpcLogBridge) {
        stopHarnessRpcLogBridge = bridgeHarnessRpcLogsToCollector(
          persist.selectedServerIds,
          runtime.rpcCollector,
        );
        // COMP-21: cross-instance frames (harness-mcp landed on another
        // instance) arrive via the shared Convex sink. No-op single-instance.
        stopCrossInstanceRpcLogPoll = startCrossInstanceRpcLogPoll(
          persist.selectedServerIds,
          runtime.rpcCollector,
        );
      }
    },
  });
}
