/**
 * `runHarnessTurn` — the real Claude Code runtime behind a host's
 * `harness: "claude-code"` field. Drop-in alternative to `runChatEngineLoop`:
 * same `(MCPJamHandlerOptions, streamSink)` in, same `ChatEngineLoopResult`
 * out, same callbacks/trace, so chat / playground / eval all reuse it through
 * `runAssistantTurn`.
 *
 * Instead of MCPJam's emulated Convex `/stream` loop, it runs the AI SDK
 * **Claude Code harness** inside the host's E2B computer (Phase 2 provider),
 * attaches the host's MCP servers via a generated `.mcp.json` (Phase 3), and
 * adapts the harness event stream back into MCPJam's UI chunks + persistence.
 *
 * ── dual-`ai` boundary ────────────────────────────────────────────────────
 * The harness packages run on `ai@7-canary` (installed nested); this server is
 * `ai@6`. We never let v7 types cross into the typed server code: the harness
 * `fullStream` is read LOOSELY (by part `type`) and we hand-build `ai@6`
 * `UIMessageChunk`s. The `agent.stream(...)` input is cast at the call site.
 *
 * ── NOT runtime-verified here ─────────────────────────────────────────────
 * This compiles against the real APIs, but the live path (E2B connect, harness
 * bootstrap, exact fullStream part shapes, transcript reconstruction) needs a
 * live box + a model credential to exercise — same gate the Phase 0 spike ran.
 * Treat the stream-part mapping + message reconstruction as first-cut until a
 * live run confirms them.
 */
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type FinishReason,
  type ToolSet,
  type UIMessageChunk,
} from "ai";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import {
  emitTraceSnapshot,
  getPromptIndex,
  setToolSpanMessageRangesFromResults,
} from "../live-chat-trace-stream.js";
import { StreamTurnDriver } from "../stream-turn-driver.js";
import {
  getHarnessAdapter,
  buildBrokerDummyAuth,
  type HarnessAuth,
} from "./registry.js";
import {
  startHarnessModelBroker,
  revokeHarnessModelBroker,
} from "./harness-model-broker.js";

/** Inspector-side gate for E2B header-broker credential delivery. Default OFF —
 *  until enabled, harness runs use the existing client-lease path unchanged, so
 *  this PR is safe to merge dark. Requires the backend broker routes + flags. */
function harnessBrokerDeliveryEnabled(): boolean {
  return process.env.MCPJAM_HARNESS_BROKER_DELIVERY === "true";
}
import {
  emitError,
  emitFinish,
  emitTextDelta,
  emitTextEnd,
  emitTextStart,
  emitToolInput,
  emitToolOutput,
} from "../chat-stream-chunks.js";
import { mergeMcpToolOriginMetadata } from "@/shared/mcp-tool-origin-metadata";
import { tunnelManager } from "../../services/tunnel-manager.js";
import { logger } from "../logger.js";
import type {
  ChatEngineLoopResult,
  MCPJamHandlerOptions,
} from "../mcpjam-stream-handler.js";
import type { PersistedTurnTrace } from "../chat-ingestion.js";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { createOffsetInterval } from "@/shared/eval-trace";
import { getCanonicalModelId } from "@/shared/types";
import { createE2BHarnessSandboxProvider } from "./e2b-sandbox-provider.js";
import { resolveHarnessSandbox } from "./resolve-sandbox.js";
import {
  fetchRuntimeSkills,
  skillsFingerprint,
  claudeCodeSafeSkills,
} from "./runtime-skills.js";
import { reconcileSkillDirs } from "./reconcile-skill-dirs.js";
import {
  claimHarnessSessionState,
  heartbeatHarnessSessionState,
  releaseHarnessSessionState,
  type HarnessOwnerRef,
  type HarnessSessionCommitPayload,
} from "./harness-session-state.js";
import {
  buildHarnessMcpJson,
  harnessServerInputFromConfig,
  harnessServerKeyToName,
  type HarnessMcpServerInput,
} from "./mcp-config.js";

/** A minimal writer matching what `createUIMessageStream` hands `execute` and
 *  what the no-op (`streamSink: "none"`) path supplies. */
type ChunkWriter = { write: (chunk: UIMessageChunk) => void };

/**
 * Resolve the model credential the harness hands to the in-sandbox CLI — from
 * Convex, like every other model key (keys live in Convex; the inspector holds
 * none by design). The CLI makes its own model calls inside the sandbox, so it
 * needs a real credential; we fetch the system **AI Gateway** key via the
 * bearer-authed Convex endpoint and hand it to the adapter as `auth.gateway`.
 * One key serves Claude Code (Anthropic) and Codex (OpenAI).
 *
 * Per-request Gateway attribution tags (`providerOptions.gateway.user/tags`)
 * are NOT plumbed: the harness adapter only forwards env vars to the CLI
 * (AI_GATEWAY_API_KEY / *_BASE_URL), so it can't carry per-call tags. Issuance
 * is instead audited + rate-limited server-side; full per-generation spend
 * ingestion is a follow-up (see the harness plan).
 *
 * Fails closed: the endpoint rejects (harness disabled / not a member /
 * rate-limited / no gateway key) ⇒ we throw here, BEFORE the computer is woken
 * (this is the first step of the turn), so a misconfigured turn never provisions
 * a box.
 */
/**
 * Build the harness `.mcp.json` from the selected servers' live configs.
 * Resolves each id via `mcpClientManager.getServerConfig` and, for stdio
 * servers, the inspector's already-open tunnel (local processes aren't
 * reachable from the sandbox). A selected id with no config is skipped.
 */
function buildMcpJsonFromManager(
  manager: MCPJamHandlerOptions["mcpClientManager"],
  selectedServerIds: string[]
) {
  const inputs: HarnessMcpServerInput[] = [];
  for (const id of selectedServerIds) {
    const config = manager.getServerConfig(id);
    if (!config) {
      logger.warn("[harness] selected server has no live config; skipping", {
        serverId: id,
      });
      continue;
    }
    const tunnelUrl = tunnelManager.getServerTunnelUrl(id);
    inputs.push(harnessServerInputFromConfig(id, config, { tunnelUrl }));
  }
  return {
    mcpJson: buildHarnessMcpJson(inputs),
    // Sanitized .mcp.json key → serverId, so Claude Code's mcp__<key>__<tool>
    // tool names map back to a serverId for eval matching / spans / MCP App
    // rendering (which all key off serverId + the un-namespaced tool name).
    keyToServerId: harnessServerKeyToName(inputs),
  };
}

/** The Claude Code harness serializes MCP tool-call arguments as a JSON STRING
 *  (e.g. `'{"city":"NYC"}'`), but MCPJam's UI chunks, the onToolCall callback,
 *  eval arg-matching, and MCP App widget capture all expect the structured
 *  object. Parse a string input back to its object/array; fall back to the raw
 *  value when it isn't JSON or doesn't decode to a structure (don't coerce a
 *  bare string/number/bool, and pass already-structured inputs through). */
function coerceToolInput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? parsed : raw;
  } catch {
    return raw;
  }
}

/** Per-process id for lease attribution (logs/debugging). */
const HARNESS_INSTANCE_ID = crypto.randomUUID();
/** Lease TTL handed to Convex; heartbeats extend it while streaming. Real Claude
 *  Code turns can exceed this, so it's the crash-recovery bound, not the normal
 *  run bound (we heartbeat well within it). */
const HARNESS_LEASE_TTL_MS = 5 * 60_000;
const HARNESS_HEARTBEAT_MS = 90_000;

/** Stable hash of the session-scoped runtime inputs. A change forces a fresh
 *  harness session (a resumed Claude Code thread keeps the model/tools it was
 *  created with, so changing those mid-session is unsafe).
 *
 *  Deliberately EXCLUDES the system prompt. The inspector hands us the per-turn
 *  `effectiveEnhancedSystemPrompt`, which app/widget chats augment EVERY turn
 *  with live widget model context (web-chat-turn buildWidgetModelContextSystem-
 *  Prompt). Hashing it flipped the fingerprint each turn and cold-started every
 *  app/widget conversation. A resumed thread keeps its original instructions
 *  regardless, so the prompt isn't a safe fork trigger; model + server set are
 *  the stable, resume-invalidating dimensions. */
export function harnessRuntimeFingerprint(parts: {
  /** The harness id MUST be part of the fingerprint: two hosts that share
   *  model/servers/permission but run different runtimes are NOT resume-
   *  compatible, so a Codex turn must never reuse a Claude Code session lane. */
  harnessId: string;
  modelId: string;
  selectedServers?: string[];
  permissionMode: string;
}): string {
  const s = [
    (parts.selectedServers ?? []).slice().sort().join(","),
    parts.permissionMode,
  ].join("");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${parts.harnessId}|${parts.modelId}|${(h >>> 0).toString(16)}`;
}

export async function runHarnessTurn(
  options: MCPJamHandlerOptions,
  streamSink: "ui" | "none"
): Promise<ChatEngineLoopResult> {
  const {
    messages,
    modelId: rawModelId,
    provider,
    systemPrompt,
    authHeader,
    projectId,
    mcpClientManager,
    selectedServers,
    abortSignal,
    onConversationComplete,
    onStreamComplete,
    onStreamWriterReady,
    onToolCall,
    onToolResult,
    onStepFinish,
    onEngineError,
    onLiveTextDelta,
    requireToolApproval,
    chatSessionId,
    chatboxId,
    sourceType,
    harness,
    builtInTools,
  } = options;
  // Canonicalize the model id up front (bare hosted ids like `gpt-5-nano` →
  // `openai/gpt-5-nano`). Everything downstream — supportsModel, the adapter's
  // toNativeModel (Codex only maps the `openai/gpt-5*` form), credential
  // attribution, fingerprint — relies on the canonical form, so a bare id can't
  // make Codex silently fall back to its default model.
  const modelId = getCanonicalModelId(rawModelId, provider);
  // The harness adapter declares the per-harness bits (auth, native model
  // mapping, MCP delivery, tool-name attribution, file-change naming, approval,
  // skills). runHarnessTurn stays harness-agnostic and reads capabilities off it.
  //
  // Defensive: this path is only reached when a harness is selected (the dispatch
  // gates on a validated id), but eval/synthetic forward `harness` unconditionally
  // — so require it here rather than silently defaulting to claude-code, and let
  // getHarnessAdapter throw on an unknown id instead of mis-attributing the turn.
  if (!harness) {
    throw new Error("runHarnessTurn: harness id is required");
  }
  const harnessAdapter = getHarnessAdapter(harness);

  // The engine mutates a single messageHistory ref through the turn (parity
  // with runChatEngineLoop); we seed it with the inbound prompt messages.
  const messageHistory: ModelMessage[] = [...messages];
  const turnStartedAt = Date.now();
  const turnId = crypto.randomUUID();
  // Per-turn prompt index (user-message count − 1), computed from the inbound
  // history like runChatEngineLoop's getPromptIndex. Hardcoding 0 collapses a
  // multi-turn session: persisted traces rehydrate sorted by promptIndex, so
  // every turn claiming 0 mislabels/merges them in the Trace tab.
  const promptIndex = getPromptIndex(messages);
  let aborted = false;
  let runSucceeded = false;
  // Internal liveness abort: the heartbeat fires this when the lease is
  // DEFINITIVELY lost (stolen/expired) or when transient heartbeat failures
  // span the lease TTL. Combined with the caller's abortSignal so either tears
  // the turn down; declared at function scope so the catch can read it.
  const livenessAbort = new AbortController();
  const effectiveAbortSignal: AbortSignal = abortSignal
    ? AbortSignal.any([abortSignal, livenessAbort.signal])
    : livenessAbort.signal;
  let usage:
    | { inputTokens?: number; outputTokens?: number; totalTokens?: number }
    | undefined;
  let turnFinishReason: FinishReason = "stop";
  let capturedTurnTrace: PersistedTurnTrace | undefined;
  // §3 atomic commit: built in executeEngine's finally (after session.stop()),
  // consumed by onFinishEngine's onConversationComplete so the resume state
  // rides /ingest-chat with the transcript. `releaseHarnessLease` lets either
  // closure free the lane if the commit can't happen (stop/persist failure).
  let capturedHarnessCommit: HarnessSessionCommitPayload | undefined;
  let releaseHarnessLease: (() => Promise<void>) | undefined;
  // Broker-delivery run identity, set after the lease is installed into E2B's
  // egress transform; used to revoke + clear the rule on teardown.
  let brokerRunId: string | undefined;
  let brokerComputerId: string | undefined;
  let brokerRevoked = false;
  // Ownership handoff for the claimed continuity lane: false from the moment the
  // lane is claimed until the harness session is established (the point the
  // finalizer/heartbeat take over). While false, ANY failure (sandbox wake,
  // broker start, runtime/agent construction, createSession) must release the
  // lane in onFinishEngine, or the next chat turn is blocked until the lease TTL.
  let sessionEstablished = false;
  // Cumulative tool spans for the turn trace, hoisted so onFinishEngine (a
  // sibling closure) can read them into PersistedTurnTrace.spans.
  const capturedSpans: EvalTraceSpan[] = [];
  // ── Live trace emission (parity with runChatEngineLoop's writeTraceEvent) ──
  // The Trace tab is built entirely from `data-trace-event` SSE parts; the
  // harness path must emit turn_start / trace_snapshot / turn_finish or the tab
  // stays on its "Sample trace" placeholder forever. `traceTurnStarted` gates
  // the error-path finish so a pre-stream failure can't emit a phantom turn.
  // `stepStartedAt` clocks the synthetic per-step agent (llm) span — the span
  // that renders the "Agent:" row and guarantees non-empty spans even for
  // text-only turns (capturedSpans otherwise holds tool spans only).
  // `toolSetForTrace` is the harness-side stand-in for an `ai` ToolSet (there
  // is none — it drives the in-sandbox CLI via .mcp.json): a toolName→serverId
  // map so emitTraceSnapshot can attach actualToolCalls.serverId.
  // `traceBaseMs` is the zero-point for span offsets — set to STREAM start (after
  // credential/claim/box-wake/connect), not `turnStartedAt` (function entry).
  // Basing on function entry painted the per-turn setup latency as an empty gap
  // before every turn's bar; the emulated engine clocks from stream start too,
  // so this keeps the harness trace gapless and on parity. Setup time still
  // shows in the [harness][timing] phase log.
  let traceBaseMs = turnStartedAt;
  let stepStartedAt = turnStartedAt;
  const toolSetForTrace: Record<string, { _serverId?: string }> = {};
  // The shared per-turn ritual (turn_start / onStepFinish / turn_finish /
  // PersistedTurnTrace / abort). Constructed at STREAM start once `traceBaseMs`
  // is finalized; read by `onFinishEngine` (a sibling closure) for the trace.
  let driver: StreamTurnDriver | undefined;

  const executeEngine = async ({ writer }: { writer: ChunkWriter }) => {
    onStreamWriterReady?.(writer);
    if (effectiveAbortSignal.aborted) {
      aborted = true;
      return;
    }

    // Hoisted so the catch can close an open text block if the turn fails
    // after emitting text-start.
    let textId: string | undefined;
    // True once any assistant text reached the writer this turn. If the harness
    // delivers its answer as a final result instead of streamed `text-delta`
    // parts, this stays false and we synthesize chunks from `res.text` below so
    // the Chat pane never renders a blank reply on a successful turn.
    let emittedAnyText = false;

    try {
      if (!projectId) {
        throw new Error(
          "harness turn requires a projectId to resolve the computer"
        );
      }
      if (!authHeader) {
        throw new Error(
          "harness turn requires an auth bearer to resolve the computer"
        );
      }
      // Interactive tool approval isn't bridged into the harness yet (no
      // tool-approval-request continuation handling), and the harness runs
      // allow-all — it can neither pause for approval nor selectively deny one
      // call. So fail closed when the host actually wants approval gating:
      // requireToolApproval. Every harness-reachable caller threads the host's
      // real requireToolApproval through (chat/playground directly; eval +
      // synthetic forward resolvedExecution.requireToolApproval), so this is the
      // authoritative signal.
      //
      // approvalMode "auto-deny" alone is NOT rejected: it's the headless
      // "no human in the loop" default eval/synthetic always set. With a
      // non-approval host nothing needs denying, so allow-all is faithful; an
      // approval host is already caught by requireToolApproval above. To run a
      // Claude Code harness host that requires approval, use the emulated engine
      // until approval continuations land.
      if (requireToolApproval) {
        throw new Error(
          "harness (Claude Code) turns don't support interactive tool approval " +
            "yet — turn off requireToolApproval on this host, or use the " +
            "emulated engine, until approval continuation handling lands"
        );
      }

      // Phase timing — log where a turn spends its wall-clock (credential /
      // claim / box wake / session connect / model stream / finalize) so "takes
      // forever" can be attributed instead of guessed.
      const tStart = Date.now();
      let tAuth = tStart;
      let tClaim = tStart;
      let tSandbox = tStart;
      let tConnect = tStart;
      let resumedSession = false;

      // 0. Capability prechecks — BEFORE any credential/sandbox work (defense in
      // depth for eval/synthetic/unified paths that don't hit the route preflight).
      // Cheap + pure, so a misconfigured turn fails before we fetch/audit/rate-
      // limit the Gateway credential or wake the box.
      //   (a) the runtime must be able to run this model — else createX() would
      //       silently substitute its own default model.
      if (!harnessAdapter.supportsModel(modelId)) {
        throw new Error(
          `The ${harnessAdapter.displayName} harness can't run model "${modelId}".`
        );
      }
      //   (b) a harness that can't deliver the host's selected MCP servers must
      //       NOT silently run without them.
      if (
        !harnessAdapter.supportsSelectedMcpServers &&
        (selectedServers?.length ?? 0) > 0
      ) {
        throw new Error(
          `The ${harnessAdapter.displayName} harness doesn't support MCP servers yet, ` +
            `but this host has ${selectedServers?.length} selected — remove them to run it.`
        );
      }

      // 1. Resolve the model credential. CLIENT path: fetch the gateway key from
      // Convex FIRST — fail-fast before resolveHarnessSandbox wakes the box, so a
      // misconfigured turn never touches it. BROKER path: the lease is installed
      // into E2B's egress transform AFTER the sandbox id is known (step 3b) and
      // the CLI runs with dummy creds, so auth is deferred.
      const useBroker = harnessBrokerDeliveryEnabled();
      let auth: HarnessAuth | undefined = useBroker
        ? undefined
        : await harnessAdapter.resolveAuth({
            projectId,
            modelId,
            bearer: authHeader,
            ...(abortSignal ? { signal: abortSignal } : {}),
          });
      tAuth = Date.now();

      // 2. Build the .mcp.json from the selected servers. Pure + fail-fast —
      // harnessServerInputFromConfig throws e.g. for a local stdio server with
      // no tunnel — so build it BEFORE waking the computer: a bad MCP config
      // shouldn't wake/provision the box (or bump its activity) only to fail.
      //
      // Progressive tool discovery (progressivePlan / discoveryState) is
      // intentionally NOT applied here. It is an EMULATED-engine mechanism:
      // runChatEngineLoop injects MCPJam's meta-tools (search_mcp_tools, …) and
      // narrows the advertised tool catalog per step to mimic how a host lazily
      // reveals tools. In harness mode the REAL Claude Code runs its own native
      // tool discovery from the .mcp.json (the CLI's real progressiveToolDiscovery
      // behavior), so we attach the full selected-server set and let the runtime
      // own discovery. Re-applying the emulation would double it, defeat the
      // "observe the real runtime" purpose, and isn't expressible anyway —
      // .mcp.json has no knob to inject MCPJam meta-tools into the real loop.
      // Only adapters that deliver MCP servers (Claude Code) build the config;
      // the undeliverable-servers case already failed closed in step 0(b) above.
      const { mcpJson, keyToServerId } =
        harnessAdapter.supportsSelectedMcpServers
          ? buildMcpJsonFromManager(mcpClientManager, selectedServers ?? [])
          : { mcpJson: { mcpServers: {} }, keyToServerId: {} };

      // 2b. Claim the harness session lane (multi-turn continuity). Done BEFORE
      // waking the box so a "turn already running" (409) doesn't provision it.
      // Continuity needs a chat owner (chatSessionId + auth + a supported
      // ownerType); eval/synthetic harness turns (streamSink "none", no
      // chatSessionId, or eval/sandbox sourceType) run fresh with no lane.
      // Runtime skills (Convex source of truth) feed BOTH the harness `skills`
      // param (the adapter writes them in-sandbox) and resume invalidation (a
      // skill change must force a fresh session so the adapter re-writes them).
      // TRI-STATE: a fetch FAILURE must never read as "zero skills" — `skillsHash`
      // stays `undefined` so it is OMITTED from claim/commit, and the backend
      // reuses the stored hash (no resume churn, no empty-hash commit). The skills
      // fingerprint is tracked SEPARATELY from `runtimeFingerprint` precisely so
      // "unknown" (failure) is distinguishable from "" (empty project).
      const skillsFetch =
        projectId && authHeader
          ? await fetchRuntimeSkills(authHeader, projectId)
          : { ok: true as const, skills: [] };
      const runtimeSkills = skillsFetch.ok ? skillsFetch.skills : null;
      const skillsHash =
        runtimeSkills !== null ? skillsFingerprint(runtimeSkills) : undefined;

      const runtimeFingerprint = harnessRuntimeFingerprint({
        harnessId: harnessAdapter.id,
        modelId,
        selectedServers: selectedServers ?? [],
        permissionMode: harnessAdapter.defaultPermissionMode,
      });
      const ownerType: HarnessOwnerRef["ownerType"] | undefined =
        sourceType === "chatbox"
          ? "chatbox-chat"
          : sourceType === "eval" || sourceType === "sandbox"
          ? undefined
          : "direct-chat";
      let continuity:
        | {
            owner: HarnessOwnerRef;
            leaseId: string;
            stateVersion: number;
            state: {
              harnessSessionId: string;
              resumeState: unknown;
              computerId: string;
            } | null;
          }
        | undefined;
      if (
        chatSessionId &&
        projectId &&
        authHeader &&
        ownerType &&
        (ownerType !== "chatbox-chat" || chatboxId)
      ) {
        const owner: HarnessOwnerRef = {
          projectId,
          // Lane key dimension: a Codex turn and a Claude Code turn for the same
          // chat occupy SEPARATE lanes, so neither can resume the other's
          // sidecar. The backend keys (projectId, harnessId, ownerType, ownerKey).
          harnessId: harnessAdapter.id,
          ownerType,
          chatSessionId,
          ...(chatboxId ? { chatboxId } : {}),
        };
        const leaseId = crypto.randomUUID();
        const claim = await claimHarnessSessionState({
          owner,
          runtimeFingerprint,
          ...(skillsHash !== undefined ? { skillsHash } : {}),
          leaseId,
          leasedBy: `${HARNESS_INSTANCE_ID}:${turnId}`,
          leaseTtlMs: HARNESS_LEASE_TTL_MS,
          bearer: authHeader,
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        if (!claim.ok) {
          // FAIL CLOSED for chat-backed owners (this block only runs for
          // direct-chat/chatbox-chat). Never silently start a fresh,
          // non-persisted harness session when continuity can't be guaranteed —
          // that would mislead the user into thinking they're in a continuous
          // conversation.
          if (claim.status === 409) {
            throw new Error(
              "Another turn is already running for this chat — wait for it to finish."
            );
          }
          logger.warn("[harness] session-state claim failed; failing closed", {
            status: claim.status,
            error: claim.error,
          });
          throw new Error(
            `Couldn't start a ${harnessAdapter.displayName} session — the ` +
              "continuity service is unavailable right now. Please try again in " +
              "a moment."
          );
        } else {
          continuity = {
            owner,
            leaseId,
            stateVersion: claim.stateVersion,
            // A runtime-fingerprint change (model / server set / SKILLS) MUST
            // yield no resumable state, so the adapter re-writes skills on a
            // fresh start (it skips writes on resume). Enforce here rather than
            // trusting the endpoint to null `state` on mismatch.
            state: claim.fingerprintChanged ? null : claim.state,
          };
          releaseHarnessLease = () =>
            releaseHarnessSessionState({
              owner,
              leaseId,
              bearer: authHeader,
            }).catch(() => {});
        }
      }
      tClaim = Date.now();

      // 3. Resolve (and wake) the host's computer → sandbox id.
      const { computerId, sandboxId } = await resolveHarnessSandbox({
        bearer: authHeader,
        projectId,
        signal: abortSignal,
      });
      tSandbox = Date.now();

      // 3b. BROKER delivery: the sandbox id is now known, so have Convex mint the
      // lease, lock the sandbox's egress to the proxy, and install the lease into
      // E2B's egress transform — the inspector never sees the lease. Run the CLI
      // with dummy creds pointed at the returned proxy. Fail-fast on install
      // error (the box is awake but no real credential exists anywhere).
      if (useBroker) {
        // PRECOMPUTE the run id and record it (+ the computer) BEFORE the POST.
        // If the backend installs the E2B rule but the response is lost/aborted,
        // teardown can still revoke by this id (backend keys revoke on runId).
        brokerRunId = crypto.randomUUID();
        brokerComputerId = String(computerId);
        const broker = await startHarnessModelBroker({
          projectId,
          computerId: String(computerId),
          harnessId: harnessAdapter.id,
          modelId,
          runId: brokerRunId,
          bearer: authHeader,
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        if (!broker.ok) {
          // Throws propagate to the turn's outer catch; onFinishEngine frees the
          // claimed lane (sessionEstablished still false) and revokes the broker
          // lease (brokerRunId set) if the backend installed before a lost response.
          throw new Error(broker.error);
        }
        auth = buildBrokerDummyAuth(harnessAdapter.id, broker.proxyBaseUrl);
      }
      if (!auth) {
        throw new Error("harness turn: model auth was not resolved");
      }

      // 4. Assemble the harness over the host's E2B computer.
      const sandbox = createE2BHarnessSandboxProvider({ sandboxId });
      // Approval-required turns are refused at the availability preflight (the
      // adapter declares it can't pause for native/MCP tool approval), so the
      // remaining turns run with the adapter's declared mode (allow-all today).
      const permissionMode = harnessAdapter.defaultPermissionMode;

      // The adapter maps the host modelId to the harness's native model and
      // constructs it (for Claude Code: the gateway `creator/model` id becomes a
      // CLI-native alias `sonnet|opus|haiku`; the raw gateway id makes the CLI
      // do zero inference). Returns the HarnessAgent boundary type directly.
      const harnessRuntime = harnessAdapter.createHarness({ modelId, auth });
      // MCPJam's server-executed built-in tools (e.g. web_search). The harness
      // forwards each as a tool spec to the runtime; when Claude Code calls one
      // it pauses, the agent runs the tool's `execute()` HERE on MCPJam's
      // server, and submits the result back. MCP-server tools are NOT included
      // (they reach the runtime via `.mcp.json` and its own MCP client), so the
      // model never sees a tool twice. Cast across the dual-`ai` boundary, same
      // as the harness adapter above (structurally identical ToolSet types).
      const hostExecutedTools = (builtInTools ?? {}) as Record<string, unknown>;
      const agent = new HarnessAgent({
        harness: harnessRuntime,
        sandbox,
        // Deliver skills via the adapter's own param (host-agnostic: it writes
        // them natively at the real $HOME). Only for adapters that support skills
        // (Claude Code today). The Claude Code adapter interpolates `description`
        // into YAML frontmatter RAW, so pre-encode descriptions safely here. Codex
        // v1 doesn't deliver skills (`supportsSkills: false`).
        ...(harnessAdapter.supportsSkills &&
        runtimeSkills &&
        runtimeSkills.length
          ? {
              skills: claudeCodeSafeSkills(runtimeSkills) as NonNullable<
                ConstructorParameters<typeof HarnessAgent>[0]["skills"]
              >,
            }
          : {}),
        ...(systemPrompt ? { instructions: systemPrompt } : {}),
        ...(Object.keys(hostExecutedTools).length
          ? {
              tools: hostExecutedTools as NonNullable<
                ConstructorParameters<typeof HarnessAgent>[0]["tools"]
              >,
            }
          : {}),
        permissionMode,
        onSandboxSession: async ({ session, sessionWorkDir }) => {
          // Deliver the host's MCP servers into the session before the runtime
          // starts, via the adapter's own strategy (Claude Code writes a
          // `.mcp.json`). Codex v1 has no delivery (`supportsSelectedMcpServers:
          // false`), so this is a no-op there.
          if (harnessAdapter.supportsSelectedMcpServers) {
            // Capability invariant: an adapter that advertises MCP support MUST
            // provide a delivery strategy. Treating a missing hook as a no-op
            // would silently run without the host's servers — fail loud instead.
            if (!harnessAdapter.deliverMcpServers) {
              throw new Error(
                `The ${harnessAdapter.displayName} harness advertises MCP support ` +
                  "but has no deliverMcpServers strategy (adapter misconfigured)."
              );
            }
            await harnessAdapter.deliverMcpServers({
              // Bind to the live session here (it lives behind the dual-`ai`
              // boundary) so the adapter stays free of the harness session type.
              writeTextFile: async (a) => {
                await session.writeTextFile(a);
              },
              sessionWorkDir,
              mcpJson,
            });
          }
          // The adapter writes skill CONTENT (via the `skills` param above); this
          // pass only removes managed dirs deleted/renamed in Convex (the adapter
          // has no deletion semantics and the box persists). Skipped on a fetch
          // failure (`runtimeSkills === null`) so a transient blip never deletes,
          // and only for skills-capable adapters.
          if (harnessAdapter.supportsSkills && runtimeSkills !== null) {
            await reconcileSkillDirs({
              session,
              skills: runtimeSkills,
              skillsHash: skillsHash ?? "",
              ...(abortSignal ? { signal: abortSignal } : {}),
            }).catch(() => {});
          }
        },
      });

      // maxSteps (MCPJamHandlerOptions) is intentionally NOT enforced here. It
      // caps MCPJam's *emulated* agentic loop; the harness exposes no equivalent
      // knob and the real Claude Code owns its own loop, so its "steps" aren't
      // MCPJam steps — a client-side cap would cut the real agent off mid-task
      // and defeat the point of observing it (same rationale as progressive tool
      // discovery above). The turn-level abortSignal/timeout (propagated into
      // agent.stream below) is the cost/runaway backstop.
      //
      // Resume-or-fresh: if the claimed lane has resume state captured on THIS
      // computer (the workdir lives there), reattach the Claude Code thread so
      // prior turns carry over. Any resume failure falls back fresh (lossy,
      // logged). A computer mismatch (reset/reprovision) ⇒ fresh.
      const resumable =
        continuity?.state && continuity.state.computerId === computerId
          ? continuity.state
          : undefined;
      let session: Awaited<ReturnType<typeof agent.createSession>>;
      if (resumable) {
        try {
          session = await agent.createSession({
            sessionId: resumable.harnessSessionId,
            resumeFrom: resumable.resumeState,
          } as unknown as Parameters<typeof agent.createSession>[0]);
          resumedSession = true;
        } catch (resumeErr) {
          logger.warn("[harness] resume failed; starting fresh", {
            error: resumeErr instanceof Error ? resumeErr.message : resumeErr,
          });
          session = await agent.createSession();
        }
      } else {
        session = await agent.createSession();
      }
      tConnect = Date.now();
      // Session is up: the finalizer + heartbeat now own the continuity lane, so
      // the pre-session cleanup in onFinishEngine no longer needs to free it.
      sessionEstablished = true;

      // Heartbeat the lease while we stream (turns can outlive the TTL). The
      // heartbeat is the liveness guard: it aborts the turn on a DEFINITIVE
      // lease loss, tolerates transient failures (network blips), and gives up
      // only if those transients span the whole lease TTL ("lost liveness").
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      if (continuity) {
        const c = continuity;
        let firstRetryableAt = 0;
        heartbeatTimer = setInterval(() => {
          void heartbeatHarnessSessionState({
            owner: c.owner,
            leaseId: c.leaseId,
            leaseTtlMs: HARNESS_LEASE_TTL_MS,
            bearer: authHeader,
          }).then((result) => {
            if (result === "ok") {
              firstRetryableAt = 0;
              return;
            }
            if (result === "lost") {
              logger.warn("[harness] lease lost — aborting turn", {
                leaseId: c.leaseId,
              });
              livenessAbort.abort(new Error("harness lease lost"));
              return;
            }
            // retryable: tolerate blips, but don't run blind forever
            if (firstRetryableAt === 0) firstRetryableAt = Date.now();
            const elapsedMs = Date.now() - firstRetryableAt;
            logger.warn("[harness] heartbeat transient failure; will retry", {
              elapsedMs,
            });
            if (elapsedMs >= HARNESS_LEASE_TTL_MS) {
              logger.warn(
                "[harness] heartbeat lost liveness past TTL — aborting turn"
              );
              livenessAbort.abort(new Error("harness lost liveness"));
            }
          });
        }, HARNESS_HEARTBEAT_MS);
      }
      try {
        // v6 messages → v7 agent input: a documented loose cast at the boundary.
        // `session` is REQUIRED — agent.stream() reads options.session in
        // _startTurn (session.promptTurn); omitting it throws "Cannot read
        // properties of undefined (reading 'promptTurn')". `_resolveTurnInput`
        // accepts `messages` and uses the last role:"user" entry as the prompt.
        const res = await agent.stream({
          session,
          messages,
          // Hand the harness the combined abort signal so a user cancel OR a
          // lost-lease liveness abort propagates into the in-sandbox run rather
          // than only stopping our forwarding.
          abortSignal: effectiveAbortSignal,
        } as unknown as Parameters<typeof agent.stream>[0]);

        // Read the harness fullStream LOOSELY and hand-build ai@6 UI chunks.
        // Reconstruct the transcript INCREMENTALLY so persisted history keeps
        // the required assistant → tool → assistant ordering across steps:
        // assistantParts holds the in-progress assistant message (text
        // interleaved with tool-calls in stream order); pendingResults holds the
        // current step's tool results. New assistant content after results means
        // the next step has begun, so the prior segment is flushed first.
        const assistantParts: Array<
          | { type: "text"; text: string }
          | {
              type: "tool-call";
              toolCallId: string;
              toolName: string;
              input: unknown;
              providerOptions?: Record<string, unknown>;
            }
        > = [];
        const pendingResults: Array<{
          toolCallId: string;
          toolName: string | undefined;
          output: unknown;
          isError: boolean;
          serverId?: string;
        }> = [];
        const flushSegment = () => {
          if (assistantParts.length > 0) {
            const assistantMsgIndex = messageHistory.length;
            messageHistory.push({
              role: "assistant",
              content: [...assistantParts],
            } as unknown as ModelMessage);
            assistantParts.length = 0;
            // Synthetic agent span: renders the "Agent:" row (llm category) and
            // guarantees non-empty trace spans even when the step produced only
            // text. The harness can't observe genuine LLM latency/tokens, so the
            // span is a wall-clock envelope; cumulative usage is attached once
            // the final flush runs after `await res.text` settles it.
            capturedSpans.push({
              id: crypto.randomUUID(),
              name: modelId,
              category: "llm",
              // Span times are turn-relative offsets (ms from traceBaseMs), not
              // absolute epoch — the timeline treats endMs as an offset
              // (getTraceSpansDurationMs = max(endMs)) and rebases turns end-to-end.
              ...createOffsetInterval(traceBaseMs, stepStartedAt, Date.now()),
              promptIndex,
              stepIndex,
              status: "ok",
              messageStartIndex: assistantMsgIndex,
              messageEndIndex: assistantMsgIndex,
              modelId,
              finishReason: turnFinishReason,
              ...(usage
                ? {
                    ...(typeof usage.inputTokens === "number"
                      ? { inputTokens: usage.inputTokens }
                      : {}),
                    ...(typeof usage.outputTokens === "number"
                      ? { outputTokens: usage.outputTokens }
                      : {}),
                    ...(typeof usage.totalTokens === "number"
                      ? { totalTokens: usage.totalTokens }
                      : {}),
                  }
                : {}),
            });
          }
          const flushedToolCallIds = new Set(
            pendingResults.map((tr) => tr.toolCallId)
          );
          for (const tr of pendingResults) {
            messageHistory.push({
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: tr.toolCallId,
                  toolName: tr.toolName ?? "tool",
                  // Failures use error-text (matches the emulated engine) so
                  // eval/trace consumers distinguish errors from success.
                  output: tr.isError
                    ? {
                        type: "error-text",
                        value:
                          typeof tr.output === "string"
                            ? tr.output
                            : JSON.stringify(tr.output),
                      }
                    : { type: "json", value: tr.output },
                  ...(tr.serverId
                    ? {
                        providerOptions: mergeMcpToolOriginMetadata(
                          undefined,
                          tr.serverId,
                        ),
                      }
                    : {}),
                },
              ],
            } as unknown as ModelMessage);
          }
          pendingResults.length = 0;
          // Back-fill messageStartIndex/EndIndex on this step's tool spans now
          // that their tool-result messages exist in messageHistory (trace ↔
          // transcript correlation; parity with runChatEngineLoop).
          setToolSpanMessageRangesFromResults(
            capturedSpans,
            messageHistory,
            promptIndex,
            stepIndex,
            flushedToolCallIds
          );
        };
        // Step + tool-identity tracking. A "step" spans assistant content + its
        // tool results; the next assistant content after results begins the next
        // step. finishStep emits the emulated engine's onStepFinish contract
        // (eval's stream runner turns it into a `step_finish` SSE snapshot).
        let stepIndex = 0;
        const toolMeta = new Map<
          string,
          { serverId?: string; toolName: string }
        >();
        const toolStartMs = new Map<string, number>();
        const finishStep = () => {
          // Usage is only known at the harness `finish`, so intermediate steps
          // carry what's settled (driver reads its cumulative `usage`).
          activeDriver.fireStepFinish(stepIndex, false);
          // Stream the cumulative spans + messages to the live Trace tab. This
          // is the event that flips the tab off its "Sample trace" placeholder.
          emitTraceSnapshot(
            writer,
            messageHistory,
            toolSetForTrace as unknown as ToolSet,
            activeDriver.snapshotContext(messageHistory)
          );
          stepIndex += 1;
          stepStartedAt = Date.now();
        };
        // Emit turn_start here (not at function entry) so a pre-stream failure
        // (credential/box/connect) never creates a phantom turn in the trace.
        // Anchor the trace clock to stream start so setup latency isn't a gap.
        traceBaseMs = Date.now();
        const activeDriver = new StreamTurnDriver({
          turnId,
          promptIndex,
          modelId,
          traceBaseMs,
          spans: capturedSpans,
          onStepFinish,
        });
        driver = activeDriver;
        activeDriver.emitTurnStart(writer);
        stepStartedAt = traceBaseMs;
        for await (const part of res.fullStream as AsyncIterable<
          Record<string, unknown> & { type?: string }
        >) {
          if (effectiveAbortSignal.aborted) {
            aborted = true;
            break;
          }
          const type = part.type;
          if (type === "text-delta" || type === "text") {
            const delta = String(
              (part as { text?: unknown; delta?: unknown }).delta ??
                (part as { text?: unknown }).text ??
                ""
            );
            if (!delta) continue;
            // Assistant text after tool results begins the next step.
            if (pendingResults.length > 0) {
              flushSegment();
              finishStep();
            }
            if (textId === undefined) {
              textId = crypto.randomUUID();
              emitTextStart(writer, textId);
            }
            // Append to the open trailing text part, or start a new one, so
            // text keeps its order relative to tool-calls.
            const lastPart = assistantParts[assistantParts.length - 1];
            if (lastPart && lastPart.type === "text") {
              lastPart.text += delta;
            } else {
              assistantParts.push({ type: "text", text: delta });
            }
            emitTextDelta(writer, textId, delta);
            emittedAnyText = true;
            onLiveTextDelta?.(delta);
          } else if (type === "tool-call" || type === "tool-input-available") {
            // A tool-call after tool results begins the next step.
            if (pendingResults.length > 0) {
              flushSegment();
              finishStep();
            }
            // Flush any open text block before the tool so the UI stream stays
            // balanced (matches the emulated engine's flush-before-tool order);
            // later text opens a fresh block with a new id.
            if (textId !== undefined) {
              emitTextEnd(writer, textId);
              textId = undefined;
            }
            const toolCallId = String(
              (part as { toolCallId?: unknown }).toolCallId ??
                crypto.randomUUID()
            );
            const rawToolName = String(
              (part as { toolName?: unknown }).toolName ?? "tool"
            );
            // Claude Code namespaces MCP tools as mcp__<server>__<tool>; map back
            // to { serverId, un-namespaced toolName } so the UI chunks, engine
            // callbacks, and persisted transcript carry MCPJam tool identity
            // (eval matching + MCP App rendering key off it). Native harness
            // tools (Bash, Read, …) have no prefix → serverId stays undefined.
            const { serverId, toolName } = harnessAdapter.parseToolName(
              rawToolName,
              keyToServerId
            );
            const input = coerceToolInput(
              (part as { input?: unknown }).input ??
                (part as { args?: unknown }).args ??
                {}
            );
            toolMeta.set(toolCallId, {
              ...(serverId ? { serverId } : {}),
              toolName,
            });
            // Stand-in ToolSet entry so emitTraceSnapshot's collectActualToolCalls
            // can resolve this tool's serverId (the harness has no `ai` ToolSet).
            toolSetForTrace[toolName] = serverId ? { _serverId: serverId } : {};
            toolStartMs.set(toolCallId, Date.now());
            // providerExecuted:true — the harness runs ALL tools in-sandbox
            // (Claude Code executes them itself). Without it the client treats
            // these as client-side tools to fulfill and `sendAutomaticallyWhen`
            // auto-continues, re-submitting the turn forever.
            const providerMetadata = mergeMcpToolOriginMetadata(
              undefined,
              serverId
            );
            writer.write({
              type: "tool-input-available",
              toolCallId,
              toolName,
              input,
              providerExecuted: true,
              ...(providerMetadata ? { providerMetadata } : {}),
            });
            await onToolCall?.({
              toolCallId,
              toolName,
              input,
              stepIndex,
              promptIndex,
              serverId,
            });
            assistantParts.push({
              type: "tool-call",
              toolCallId,
              toolName,
              input,
              ...(providerMetadata
                ? { providerOptions: providerMetadata }
                : {}),
            });
          } else if (
            type === "tool-result" ||
            type === "tool-output-available"
          ) {
            const toolCallId = String(
              (part as { toolCallId?: unknown }).toolCallId ?? ""
            );
            const output =
              (part as { output?: unknown }).output ??
              (part as { result?: unknown }).result;
            // Surface tool failures the harness reports so eval/trace consumers
            // that key off isError classify them correctly.
            const isError =
              (part as { isError?: unknown }).isError === true ||
              (part as { error?: unknown }).error != null;
            // Reuse the identity resolved at tool-call time (the result part may
            // omit the name); fall back to parsing the result's own toolName.
            const meta =
              toolMeta.get(toolCallId) ??
              harnessAdapter.parseToolName(
                String((part as { toolName?: unknown }).toolName ?? "tool"),
                keyToServerId
              );
            // Provider-executed (in-sandbox) — see tool-input-available above.
            emitToolOutput(writer, {
              toolCallId,
              output,
              providerExecuted: true,
            });
            await onToolResult?.({
              toolCallId,
              toolName: meta.toolName,
              output,
              isError,
              stepIndex,
              promptIndex,
              serverId: meta.serverId,
            });
            // Record a tool span for the turn trace (cumulative; snapshotted into
            // each onStepFinish and the final PersistedTurnTrace.spans).
            capturedSpans.push({
              id: crypto.randomUUID(),
              name: meta.toolName,
              category: "tool",
              // Turn-relative offsets (see the llm span above).
              ...createOffsetInterval(
                traceBaseMs,
                toolStartMs.get(toolCallId) ?? Date.now(),
                Date.now()
              ),
              promptIndex,
              stepIndex,
              status: isError ? "error" : "ok",
              toolCallId,
              toolName: meta.toolName,
              ...(meta.serverId ? { serverId: meta.serverId } : {}),
            });
            pendingResults.push({
              toolCallId,
              toolName: meta.toolName,
              output,
              isError,
              ...(meta.serverId ? { serverId: meta.serverId } : {}),
            });
          } else if (type === "file-change") {
            // Some runtimes (Codex) report file mutations as a `file-change`
            // stream part that does NOT originate from a model-callable tool.
            // Surface it as a synthetic NATIVE provider-executed tool (serverId
            // undefined, like Bash) so it flows through the same UI emit + trace
            // span + transcript path. No serverId ⇒ eval MCP-tool matching
            // ignores it automatically. Only adapters that declare a
            // `fileChangeToolName` emit these (Claude Code does not).
            const fcName = harnessAdapter.fileChangeToolName;
            if (fcName) {
              // Begins a new step after prior results; close any open text block.
              if (pendingResults.length > 0) {
                flushSegment();
                finishStep();
              }
              if (textId !== undefined) {
                emitTextEnd(writer, textId);
                textId = undefined;
              }
              const toolCallId = crypto.randomUUID();
              const input = coerceToolInput({
                event: (part as { event?: unknown }).event,
                path: (part as { path?: unknown }).path,
              });
              const startMs = Date.now();
              toolMeta.set(toolCallId, { toolName: fcName });
              toolSetForTrace[fcName] = {};
              emitToolInput(writer, {
                toolCallId,
                toolName: fcName,
                input,
                providerExecuted: true,
              });
              await onToolCall?.({
                toolCallId,
                toolName: fcName,
                input,
                stepIndex,
                promptIndex,
                // Native file mutation — not an MCP-server tool.
                serverId: undefined,
              });
              assistantParts.push({
                type: "tool-call",
                toolCallId,
                toolName: fcName,
                input,
              });
              // The part is self-contained (no separate result frame) — emit a
              // matching result immediately so the pair stays balanced.
              emitToolOutput(writer, {
                toolCallId,
                output: input,
                providerExecuted: true,
              });
              await onToolResult?.({
                toolCallId,
                toolName: fcName,
                output: input,
                isError: false,
                stepIndex,
                promptIndex,
                serverId: undefined,
              });
              capturedSpans.push({
                id: crypto.randomUUID(),
                name: fcName,
                category: "tool",
                ...createOffsetInterval(traceBaseMs, startMs, Date.now()),
                promptIndex,
                stepIndex,
                status: "ok",
                toolCallId,
                toolName: fcName,
              });
              pendingResults.push({
                toolCallId,
                toolName: fcName,
                output: input,
                isError: false,
              });
            }
          } else if (type === "finish") {
            const fr = (part as { finishReason?: unknown }).finishReason;
            if (typeof fr === "string" && fr)
              turnFinishReason = fr as FinishReason;
            const u =
              (part as { totalUsage?: unknown; usage?: unknown }).totalUsage ??
              (part as { usage?: unknown }).usage;
            if (u && typeof u === "object") {
              const ur = u as Record<string, unknown>;
              usage = {
                ...(typeof ur.inputTokens === "number"
                  ? { inputTokens: ur.inputTokens }
                  : {}),
                ...(typeof ur.outputTokens === "number"
                  ? { outputTokens: ur.outputTokens }
                  : {}),
                ...(typeof ur.totalTokens === "number"
                  ? { totalTokens: ur.totalTokens }
                  : {}),
              };
            }
          }
        }
        // Close any open text block first so BOTH the cancelled and normal
        // paths leave a balanced UI stream.
        if (textId !== undefined) emitTextEnd(writer, textId);

        // Cancelled mid-stream: do NOT drain res.text (it would block until the
        // full harness run finishes). The finally below destroys the harness
        // session, stopping the in-sandbox Claude Code run.
        if (aborted) return;

        // The AI SDK terminal result is authoritative for the final assistant
        // answer + usage. `res.text` settles the complete answer even when the
        // bridge delivered it as a final result rather than streamed
        // `text-delta` parts. Drain it before building the persisted transcript.
        const finalText = await res.text;

        // Settle cumulative usage + finish reason on the driver NOW — usage is
        // known from the finish part. Set before the completeness fallback below
        // so the synthesized tool step's finishStep() (and every step settling
        // after this point) reports the known cumulative turnUsage, not undefined.
        activeDriver.usage = usage;
        activeDriver.finishReason = turnFinishReason;

        // Completeness reconciliation against the authoritative result: if the
        // live stream yielded no assistant text (answer arrived as a final
        // result, not deltas), the hand-built transcript + UI projection would
        // be blank on an otherwise-successful turn. Project the authoritative
        // `res.text` into both the UI stream and the persisted assistant
        // message so live render + persistence match the terminal result.
        if (
          !emittedAnyText &&
          typeof finalText === "string" &&
          finalText.length > 0
        ) {
          // Final assistant text after tool results begins the next step — flush
          // the pending tool segment FIRST (mirrors the `text-delta` path),
          // otherwise the synthesized text would be appended to the same
          // assistant message as the preceding tool-call, persisting
          // assistant(tool-call + text) → tool instead of the correct
          // assistant(tool-call) → tool → assistant(text) ordering.
          if (pendingResults.length > 0) {
            flushSegment();
            finishStep();
          }
          const finalTextId = crypto.randomUUID();
          emitTextStart(writer, finalTextId);
          emitTextDelta(writer, finalTextId, finalText);
          emitTextEnd(writer, finalTextId);
          emittedAnyText = true;
          onLiveTextDelta?.(finalText);
          const lastPart = assistantParts[assistantParts.length - 1];
          if (lastPart && lastPart.type === "text") {
            lastPart.text += finalText;
          } else {
            assistantParts.push({ type: "text", text: finalText });
          }
        }

        // Flush the final step's assistant message + its tool results. Earlier
        // steps were flushed as new assistant content arrived after results, so
        // the persisted history preserves assistant → tool → assistant ordering.
        flushSegment();
        // Final step settles now that usage is known from the finish part.
        finishStep();
        emitFinish(writer, {
          finishReason: turnFinishReason,
          messageMetadata: usage,
        });
        // Shared ritual: write turn_finish + mark success (finish chunk already
        // emitted above).
        activeDriver.finishTurn(writer, { alreadyEmittedFinish: true });
        runSucceeded = true;
        const tStream = Date.now();
        // Values inlined into the message — this logger drops the 2nd arg.
        logger.info(
          `[harness][timing] credential=${tAuth - tStart}ms claim=${
            tClaim - tAuth
          }ms boxWake=${tSandbox - tClaim}ms sessionConnect=${
            tConnect - tSandbox
          }ms modelStream=${tStream - tConnect}ms total=${
            tStream - tStart
          }ms resumed=${resumedSession}`
        );
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        try {
          // On a clean turn with continuity: STOP (not destroy) to get the
          // resume payload, then BUILD the commit (don't send it here). The
          // commit rides /ingest-chat atomically with the transcript in
          // onFinishEngine so transcript + sidecar advance together. stop()
          // exits the in-sandbox bridge; MCPJam's E2B provider stop() is a no-op
          // so the computer (and the workdir holding the Claude Code thread)
          // stays alive. On abort/error: destroy + release the lease.
          if (runSucceeded && !aborted && continuity) {
            const resumeState = await session.stop();
            capturedHarnessCommit = {
              ownerType: continuity.owner.ownerType as
                | "direct-chat"
                | "chatbox-chat",
              chatSessionId: continuity.owner.chatSessionId as string,
              ...(continuity.owner.chatboxId
                ? { chatboxId: continuity.owner.chatboxId }
                : {}),
              leaseId: continuity.leaseId,
              expectedStateVersion: continuity.stateVersion,
              harnessId: harnessAdapter.id,
              harnessSessionId: session.sessionId,
              resumeState,
              computerId,
              runtimeFingerprint,
              // Persist only a real (ok:true) hash; omit on failure so the
              // backend keeps the prior stored hash (no empty-hash regression).
              ...(skillsHash !== undefined ? { skillsHash } : {}),
            };
          } else {
            await session.destroy();
            if (continuity) await releaseHarnessLease?.();
          }
        } catch (finalizeErr) {
          logger.warn(
            "[harness] session finalize failed; releasing lease, sidecar not committed",
            { error: finalizeErr }
          );
          // stop()/destroy() threw → no resume payload to commit. Drop any
          // half-built commit and free the lane so the next turn can claim.
          capturedHarnessCommit = undefined;
          await releaseHarnessLease?.();
        }
      }
    } catch (err) {
      if (effectiveAbortSignal.aborted || isAbortError(err)) {
        aborted = true;
        return;
      }
      const errorText = err instanceof Error ? err.message : String(err);
      logger.error("[harness] turn failed", err);
      // Close any open text block so the UI stream stays balanced.
      if (textId !== undefined) emitTextEnd(writer, textId);
      emitError(writer, errorText);
      // A mid-stream failure still gets a final snapshot + turn_finish so the
      // Trace tab renders what happened (parity with runChatEngineLoop). Guarded
      // by the driver's `traceStarted` so a pre-stream failure emits no phantom
      // turn.
      if (driver?.traceStarted) {
        driver.usage = usage;
        emitTraceSnapshot(
          writer,
          messageHistory,
          toolSetForTrace as unknown as ToolSet,
          driver.snapshotContext(messageHistory)
        );
        driver.emitErrorTurnFinish(writer);
      }
      onEngineError?.({
        message: errorText,
        rawText: errorText,
        promptIndex,
      });
    }
  };

  const onFinishEngine = async () => {
    // Broker teardown runs FIRST — the model stream has ended, so revoke the lease
    // + clear the E2B egress rule before the persistence/cleanup callbacks below,
    // which could hang and would otherwise keep the credential live until TTL/cron.
    // Runs on BOTH stream paths (UI onFinish + inline finally). Idempotent
    // (guarded) + best-effort; a miss is backstopped by lease TTL + the cron.
    if (!brokerRevoked && brokerRunId && authHeader) {
      brokerRevoked = true;
      await revokeHarnessModelBroker({
        runId: brokerRunId,
        ...(brokerComputerId ? { computerId: brokerComputerId } : {}),
        ...(projectId ? { projectId } : {}),
        bearer: authHeader,
      }).catch(() => {});
    }
    if (runSucceeded && !aborted && driver) {
      // Stream start (matches the span offset base) so rehydrated traces align
      // with the live ones — see traceBaseMs.
      const trace: PersistedTurnTrace = driver.buildPersistedTrace();
      capturedTurnTrace = trace;
      // §3: hand the resume-state commit to onConversationComplete so it rides
      // /ingest-chat atomically with the transcript. On success the backend
      // commit releases the lease; if persistence is absent or fails, the
      // sidecar did NOT advance — release the lane best-effort.
      let persistOk = false;
      try {
        await onConversationComplete?.(
          [...messageHistory],
          trace,
          capturedHarnessCommit
        );
        persistOk = true;
      } catch (persistErr) {
        logger.error("[harness] onConversationComplete failed", persistErr);
      }
      if (capturedHarnessCommit && (!onConversationComplete || !persistOk)) {
        await releaseHarnessLease?.();
      }
    }
    // Pre-session cleanup: if the session was never established (the turn failed
    // or aborted after claimHarnessSessionState but before createSession — sandbox
    // wake, broker start, runtime/agent construction, or createSession threw), no
    // finalizer owns the claimed lane, so free it here or the next chat turn is
    // blocked with "Another turn is already running" until the lease TTL. This runs
    // on BOTH stream paths (UI onFinish + inline finally). Idempotent, and a no-op
    // on non-continuity turns (releaseHarnessLease is undefined).
    if (!sessionEstablished) {
      await releaseHarnessLease?.();
    }
    // Mirror the emulated engine (mcpjam-stream-handler.ts): a cleanup/teardown
    // error must not reject stream finalization after an otherwise successful
    // turn (the trace + onConversationComplete already ran above).
    try {
      await onStreamComplete?.();
    } catch (cleanupError) {
      logger.error(
        "[harness] error while running stream cleanup",
        cleanupError
      );
    }
  };

  if (streamSink === "ui") {
    const stream = createUIMessageStream({
      execute: executeEngine,
      onFinish: onFinishEngine,
    });
    const response = createUIMessageStreamResponse({ stream });
    return { response, messageHistory, aborted: false };
  }

  // streamSink === "none": run inline against a no-op writer; trace +
  // onConversationComplete still fire via closures.
  const noopWriter: ChunkWriter = { write: () => {} };
  try {
    await executeEngine({ writer: noopWriter });
  } finally {
    // onFinishEngine runs the broker teardown for this path too (see above).
    await onFinishEngine();
  }
  return {
    messageHistory,
    aborted,
    ...(capturedTurnTrace ? { turnTrace: capturedTurnTrace } : {}),
  };
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}
