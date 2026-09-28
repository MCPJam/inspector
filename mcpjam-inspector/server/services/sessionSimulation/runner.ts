import {
  AdmissionWaitBudget,
  withAdmissionRetry,
  spendRefusalOf,
  type SpendRefusal,
} from "./admission-retry.js";
import {
  peekPageToolsForChatTurn,
  pageToolsSnapshotFrom,
} from "../browserd/page-tools-peek.js";
import { webmcpPageToolsMode } from "../../config.js";
import {
  deadlineClockOf,
  withDeadline,
  type DeadlineHandle,
} from "../../utils/run-supervisor/deadline.js";
import type { ResolvedExecutionBudgets } from "@mcpjam/sdk/contract";
import { BROWSER_BUILT_IN_TOOL_ID } from "@/shared/client-fulfilled-tools";
import {
  toMintedPageToolRecords,
  type MintedDeclaredTool,
} from "@/shared/declared-tools";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { ToolSet } from "ai";
import type {
  MCPClientManager,
  Harness,
  ModelReasoningEffort,
  ModelSelection,
} from "@mcpjam/sdk";
import type {
  McpToolResultImageRenderingPolicy,
  ModelVisibleMcpToolResults,
} from "@mcpjam/sdk/host-config/internal";
import { ConvexHttpClient } from "convex/browser";
import type { ModelDefinition } from "@/shared/types";
// `getModelById` lookup is now wrapped by `buildSyntheticModelDefinition`
// (org-model-config.ts) — that helper falls back to BYOK provider parsing
// when the scenario modelId isn't in SUPPORTED_MODELS, which is the common
// case for org-BYOK scenarios (Ollama, custom: providers, OpenRouter ids).
import { logger } from "../../utils/logger.js";
import type { MCPJamHandlerOptions } from "../../utils/mcpjam-stream-handler.js";
import { resolveLocalOrgMaxSteps } from "../../utils/org-model-stream-handler.js";
import type { DirectChatTurnTraceEvents } from "../../utils/direct-chat-turn.js";
import type { SwarmStreamPayload } from "../../../shared/swarm-stream-events.js";
import { getHostedTurnFailure } from "../../utils/hosted-turn-failure.js";
import { runUnifiedAssistantTurn } from "../../utils/turn-execution.js";
import {
  resolveTurnRuntime,
  classifyTurnFailure,
  type TurnRunAttribution,
} from "../../utils/resolve-turn-runtime.js";
import {
  resolveSyntheticModelSource,
  type SyntheticModelSource,
} from "../../utils/org-model-config.js";
import { prepareChatV2 } from "../../utils/chat-v2-orchestration.js";
import type {
  PinnableSkill,
  PinnedSkillArtifact,
} from "../../../shared/skill-types.js";
import {
  resolveHostTools,
  type HostComputerResource,
  type TrustedSandboxBinding,
} from "../../utils/built-in-tools/registry.js";
import type { TrustedHarnessSandboxBinding } from "../../utils/harness/resolve-sandbox.js";
import { BASH_TOOL_NAME } from "../../utils/built-in-tools/bash.js";
import { browserApprovalDeliveryFor } from "../evals/browser-tool-policy.js";
import {
  listCloudRuntimeSkills,
  shouldEnableCloudSkillTools,
  skillsFailureFrom,
  type SkillsFetchFailure,
} from "../../utils/computers/cloud-skill-tools.js";
import type { RuntimeStandaloneSkill } from "../../services/environments/effective-capabilities.js";
import {
  buildLiveEffectiveCapabilities,
  type EffectiveCapabilitySet,
} from "../../services/environments/effective-capabilities.js";
import {
  persistChatSessionToConvex,
  type PersistChatOutcome,
  type PersistedTurnTrace,
  type ChatOrigin,
} from "../../utils/chat-ingestion.js";
import { exportConnectedServerToolSnapshotForEvalAuthoring } from "../../utils/export-helpers.js";

/**
 * Headless runs have no stream to carry a `data-persist-receipt`, but the
 * outcome still matters: a synthetic run whose transcripts never landed used to
 * be indistinguishable from one that saved cleanly. `not-attempted` is silent —
 * it means persistence was not configured for this run, which is expected.
 */
function warnIfSimulationPersistNotSaved(
  outcome: PersistChatOutcome | undefined,
  stage: "empty-session" | "turn",
  chatSessionId: string,
): void {
  // This is observability, not control flow — it must never be the thing that
  // takes a synthetic run down, so an absent outcome is simply nothing to say.
  if (
    !outcome ||
    outcome.outcome === "saved" ||
    outcome.outcome === "duplicate" ||
    outcome.outcome === "not-attempted"
  ) {
    return;
  }
  logger.warn("[sessionSimulation] chat persist did not save", {
    stage,
    // Concurrent synthetic sessions interleave in the log, so the warning has
    // to name the session it is about to be actionable at all.
    chatSessionId,
    outcome: outcome.outcome,
    ...(outcome.outcome === "failed"
      ? { failureKind: outcome.failureKind }
      : {}),
  });
}
import { captureMcpAppWidgetSnapshots } from "../../utils/mcp-app-widget-capture.js";
import {
  createBrowserSessionContext,
  type BrowserSessionContext,
} from "../browser-session-context.js";
import type { BrowserArtifactOutbox } from "../browser-artifact-outbox.js";
import { finalizeWithBrowserArtifacts } from "../browser-artifact-finalize.js";
import {
  appendDedupedModelMessages,
  type EvalTraceWidgetSnapshot,
} from "@/shared/eval-trace";
import {
  evalTraceSnapshotToPayload,
  sanitizeWidgetForBackend,
} from "@/shared/widget-snapshot";
import { resolveWebAuthorizedHarnessStrategy } from "../../utils/harness/harness-proxy-strategy.js";
import type { HarnessSessionCommitPayload } from "../../utils/harness/harness-session-state.js";
import { resolveBrowserSecrets } from "../../utils/secrets/browser-secrets.js";
import { markRuntimeSecretsDelivered } from "../../utils/harness/runtime-secrets.js";

export interface SimulationManagerFactory {
  /**
   * Builds a fresh, fully-connected MCPClientManager for one session, scoped
   * to the scenario's `selectedServerIds`. The runner disposes it after the
   * session completes (success or failure).
   *
   * Implemented by the route handler so the runner stays free of authorize
   * + secrets fetch wiring.
   */
  (): Promise<{
    manager: MCPClientManager;
    /** Server IDs that successfully connected (skip-listed OAuth servers excluded). */
    connectedServerIds: string[];
    /**
     * Optional human-readable names aligned 1:1 with `connectedServerIds`.
     * Persisted into the session's `resumeConfig.selectedServers` so the
     * Scenario Sessions viewer can reconnect the right servers when the user
     * opens the session later (live `readResource()` for MCP App widgets).
     */
    connectedServerNames?: string[];
    /**
     * Connected server IDs that must NOT be written into
     * `resumeConfig.selectedServers`. Today: servers contributed by an
     * environment's pinned PLUGIN versions. The session legitimately connects
     * them, but `resumeConfig` is a durable reconnect instruction replayed
     * later with NO plugin lifecycle check — persisting a `plugin_component`
     * id there would let the Sessions viewer reconnect a disabled or
     * uninstalled plugin's server, which is exactly the bypass that keeps
     * those ids out of `hostConfigs.serverIds` in the first place. A plugin
     * server reaches a run only through a re-gate, never through a stored id.
     */
    nonResumableServerIds?: string[];
    /** Async cleanup invoked after the session terminates. */
    dispose: () => Promise<void>;
  }>;
}

type SessionOutcome = "succeeded" | "failed" | "rate_limited";

/**
 * Live browser frames (the "watch it click" channel). On by default; set
 * `MCPJAM_SWARM_LIVE_FRAMES=false` to turn the channel off entirely, in which
 * case no `onBrowserAction` sink is wired and the browser context does no
 * thumbnail work — a true no-op, not a suppressed emit.
 */
export function liveBrowserFramesEnabled(): boolean {
  return process.env.MCPJAM_SWARM_LIVE_FRAMES?.trim().toLowerCase() !== "false";
}

/**
 * Deadline on the terminal browser-artifact flush. `ConvexHttpClient.mutation`
 * has no timeout of its own, and this runs as the session unwinds — nothing is
 * pinned by then, but a hung mutation would hold a swarm worker slot.
 */
const TERMINAL_ARTIFACT_FLUSH_TIMEOUT_MS = 30_000;

/**
 * Resolve `promise`, or `fallback` if it hasn't settled within `timeoutMs`. The
 * abandoned promise keeps running (nothing here can cancel a Convex mutation) —
 * it just stops holding the caller. Rejections resolve to `fallback` too, so a
 * terminal path can't be broken by what it is only observing.
 */
/** Written for a human reading a failed session, not for a parser. */
function formatBudgetMs(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`;
}

function sessionTimeoutMessage(budgetMs: number, turn?: number): string {
  const where = turn === undefined ? "" : ` (at turn ${turn + 1})`;
  return `Session exceeded its ${formatBudgetMs(budgetMs)} budget${where}`;
}

function turnTimeoutMessage(budgetMs: number, turn?: number): string {
  const where = turn === undefined ? "" : ` (turn ${turn + 1})`;
  return `Turn exceeded its ${formatBudgetMs(budgetMs)} budget${where}`;
}

/**
 * Rejects when `signal` aborts, and otherwise never settles.
 *
 * Its rejection carries the signal's REASON — the deadline's own stamped
 * error when a clock fired — so the session's catch can tell a blown budget
 * from a cancel rather than seeing a bare "aborted".
 */
function whenSessionAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const fail = () =>
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("aborted"),
      );
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The `details.reason` a route error classified itself with (WebRouteError and
 * the local-route envelope both use that key). Read structurally rather than by
 * `instanceof`: the throw can cross a route boundary — a connect failure from
 * `createAuthorizedManager` arrives as a WebRouteError, but the same shape also
 * comes back re-thrown from a local route helper.
 */
function readErrorReason(error: unknown): string | undefined {
  const details = (error as { details?: unknown } | null)?.details;
  if (!details || typeof details !== "object") return undefined;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim() ? reason : undefined;
}

// `errorMessage` rides along on failures so the batch loop can persist the
// first one onto the run record (RunRecord.error) — previously the message
// only reached server logs and the dialog rendered a bare "Failed".
//
// `errorReason` is the STRUCTURED tag a thrown WebRouteError classified itself
// with (`details.reason`), when it had one. Without it the swarm runner would
// have to re-derive "is this an authorization handshake that needs re-running?"
// by pattern-matching the sentence it is about to store — so the tag travels
// with the failure instead, and becomes the attempt's `errorCode`.
interface SessionResult {
  outcome: SessionOutcome;
  errorMessage?: string;
  errorReason?: string;
  errorRefusal?: SpendRefusal;
}

// --- Shared synthetic host-session core ----------------------------------
//
// `runSyntheticHostSession` is the per-session host-turn machinery that is
// IDENTICAL for the legacy scenario session-simulation and the swarm
// (journey-execution) runners: manager lifecycle + dispose, `resolveHostTools`
// + cloud skills, `prepareChatV2`, the per-turn persona→`drainAssistantTurn`
// loop, per-turn transcript persistence, browser/widget capture, empty-session
// persistence, and failure classification. A surface adapter injects the three
// pieces that differ between scenario sim and swarm: (1) the persona-next-turn
// source, (2) the persistence attribution tags, and (3) the pinned host
// runtime config (scenario sim: scenario runtime config; swarm: pinned snapshot
// host — NEVER a refetch of the live host config).

/** Pinned host runtime a synthetic session executes against. */
export interface SyntheticHostRuntime {
  modelDefinition: ModelDefinition;
  /**
   * The saved selection behind `modelDefinition`, already checked with
   * `backendModelSelection()` (never `local`). Forwarded to the backend as the
   * request body's `modelSelection` on the rail it names. Absent ⇒ legacy.
   */
  modelSelection?: ModelSelection;
  systemPrompt: string;
  /**
   * The effective temperature: the saved selection's setting over the host's
   * (`resolveEffectiveModelSettings`), so the top-level field the backend
   * prefers can never contradict the forwarded selection.
   */
  temperature?: number;
  /** The saved selection's reasoning effort, applied on the resolved rail. */
  reasoningEffort?: ModelReasoningEffort;
  /**
   * Tool-step cap for ONE assistant turn. Absent ⇒ the engine's own default
   * (the Playground's 30). A synthetic persona turn resends every tool result
   * of the turn on every step, so the cap bounds both wall clock and tokens;
   * the swarm runner pins its own, the scenario runner keeps the default.
   */
  maxSteps?: number;
  requireToolApproval: boolean;
  respectToolVisibility?: boolean;
  progressiveToolDiscovery?: boolean;
  builtInToolIds?: string[];
  /**
   * What the hosted `browser_*` tools may do in this unattended run. A
   * journey/swarm session never pauses, so approval does not exist here and a
   * DECLARED policy is the only thing that can authorize them; absent or
   * malformed ⇒ they are not advertised (fail-closed).
   */
  browserToolPolicy?: unknown;
  /** Explicit profile pin for this unattended synthetic session. */
  browserProfileId?: string;
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
  computer?: HostComputerResource;
  /**
   * A disposable sandbox this session already owns (B-isolation). Present ⇒
   * `bash` binds to that box instead of the acting member's personal computer,
   * which is what makes a swarm session's filesystem its own.
   *
   * TRUSTED: it reaches the resolver on `ctx`, never on the host config, so
   * only an in-process caller that just provisioned can set it. Nothing parsed
   * from a run snapshot or a request body can produce one.
   */
  sandboxBinding?: TrustedSandboxBinding;
  /**
   * The SPECIFIC reason this session gets no shell, when one is known — e.g.
   * "this environment has no built image yet". Replaces the resolver's generic
   * "swarm sessions don't get bash" message in the surfaced notice.
   *
   * The generic message was true while swarm bash was suppressed
   * unconditionally; now that a swarm session CAN have bash, telling a user
   * their run is bash-less "because swarms don't support it" would point them
   * at the wrong fix. The reason is frozen at launch and travels on the run
   * snapshot, so it names the actual configuration problem.
   */
  bashUnavailableReason?: string;
  /**
   * Set when this session's harness turn must be REFUSED rather than run
   * (B-isolation F4).
   *
   * `runHarnessTurn` bypasses `resolveHostTools` entirely, so the ONLY thing
   * keeping a swarm harness off the launcher's shared personal computer is
   * {@link harnessSandboxBinding} being present. When the caller could not
   * produce one, it must say so here — a harness turn with no binding would
   * silently reserve the shared machine and contaminate every other session in
   * the run, which is exactly what B-isolation exists to remove.
   *
   * Phase 6 narrowed WHEN this is set (a harness with a binding now runs) but
   * not what it means: absent binding ⇒ refuse, always.
   */
  harnessBlockedReason?: string;
  /**
   * The disposable box this session's HARNESS runs on (B-isolation phase 6).
   *
   * Separate from {@link sandboxBinding} because the two travel to different
   * places: the bash binding rides `ctx` into `resolveHostTools`, while
   * `runHarnessTurn` never goes through the tool resolver at all — it takes its
   * box on the handler options. Both are the SAME physical box for a given
   * attempt, and both are trusted the same way (in-process only, never on a
   * host config or run snapshot).
   */
  harnessSandboxBinding?: TrustedHarnessSandboxBinding;
  harness?: Harness;
  /**
   * Scenario-access version for the drain's `/stream/org/resolve` authorization
   * and the scenario-scoped widget capture. Set on the scenario surface; the
   * swarm surface uses project-member access and leaves it undefined.
   */
  accessVersion?: number;
  /**
   * Scenario id for scenario-scoped access authorization on the drain. The swarm
   * surface authorizes via project membership and leaves it undefined.
   */
  scenarioId?: string;
  /**
   * Authoritative pinned skills for an ENVIRONMENT-based swarm target
   * (Project Environments, D3). `undefined` ⇒ live-pool semantics: the project
   * catalog as a resolved capability set, plus the connected servers' own
   * skills. An array — possibly EMPTY, meaning deliberately skill-less — ⇒
   * skills come EXCLUSIVELY from these pinned artifacts: the emulated engine
   * gets them via prepareChatV2 `skillsSource`, and a harness turn gets them
   * via the pinned harness path (never `fetchRuntimeSkills`, and NEVER through
   * prepareChatV2's pinned branch, which throws on harness).
   */
  pinnedSkills?: PinnedSkillArtifact[];
  /**
   * The Project Environment this target runs (`environmentRef.environmentId` on
   * the pinned execution spec). Absent for a legacy host target, which has no
   * environment and therefore no secret grant at all.
   *
   * Threaded for the harness path's EXTERNAL-ACCOUNT credential check: brokered
   * project secrets are composed onto a box from its environment's
   * `secretSelection`, so this is what separates "the run's environment grants
   * this credential" from "some environment in the project does". Without it a
   * bound-but-unselected secret reads as available and the attempt provisions a
   * box that then fails vendor auth against a placeholder.
   */
  environmentId?: string;
}

/** Attribution tags stamped onto every transcript persist for this session. */
export interface SyntheticPersistAttribution {
  sourceType: "scenario" | "swarm";
  origin: ChatOrigin;
  surface?: "preview" | "share_link";
  scenarioId?: string;
  journeyRunId?: string;
  hostId?: string;
  /** Opaque swarm execution-target id — echoed on chat ingestion so two
   * same-host targets stay attributable. Absent for legacy/scenario surfaces. */
  targetId?: string;
  personaId?: string;
  personaLabel?: string;
  personaRefId?: string;
}

export interface SyntheticHostSessionAdapter {
  runId: string;
  projectId: string;
  /** Deterministic chat session id — the claim key for swarm attempts. */
  chatSessionId: string;
  maxTurns: number;
  /**
   * The run's FROZEN execution budgets. A swarm session spends
   * `unitTimeoutMs` on the whole conversation and `turnTimeoutMs` on each
   * reply within it; `maxTurns` bounds the COUNT of turns, which is a
   * different thing and never bounded their duration.
   */
  budgets: ResolvedExecutionBudgets;
  runtime: SyntheticHostRuntime;
  /**
   * Bearer used for the hosted drain + transcript persist. The persona driver
   * and any surface-specific side-persistence (scenario widget capture) hold
   * their own auth tokens in their closures.
   */
  authHeader: string;
  managerFactory: SimulationManagerFactory;
  abortSignal?: AbortSignal;
  /** Surface persona driver: produce the next simulated user message. */
  nextPersonaTurn(
    transcriptSoFar: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<{ message: string; endSession: boolean }>;
  /** Persistence attribution tags (scenario vs swarm). */
  persist: SyntheticPersistAttribution;
  /**
   * Optional per-turn side-persistence — MCP App widget snapshots (the scenario
   * surface via scenario-scoped auth; the swarm surface via the mutation's
   * direct-session path). Browser-rendered artifacts do NOT go here: they ride
   * {@link browserArtifacts} instead, because their terminal flush has to be
   * ordered against browser teardown, which only this core can do.
   */
  onTurnPersisted?(args: {
    messages: ModelMessage[];
    browser: BrowserSessionContext;
    manager: MCPClientManager;
    connectedServerIds: string[];
    promptIndex: number;
  }): Promise<void>;
  /**
   * Opt IN to durable browser-artifact capture (render observations, Computer
   * Use steps, and the replay `.webm`). The SURFACE creates the outbox because
   * it owns the Convex identity; the core drives it, because only the core knows
   * when the harness can be torn down — `collectVideo()` must run before
   * Chromium dies, and the uploads must run after, or a stalled upload pins both
   * the browser and the MCP manager open behind it.
   *
   * Absent ⇒ artifacts are collected in memory and discarded at dispose, which
   * is what every surface did before this existed.
   */
  browserArtifacts?: BrowserArtifactOutbox;
  /**
   * Optional live SSE emitter (swarm). Envelope (runId/hostId/chatSessionId/
   * sessionIndex) is bound by the caller — this only receives payloads.
   */
  emit?(payload: SwarmStreamPayload): void;
}

export async function runSyntheticHostSession(
  adapter: SyntheticHostSessionAdapter,
): Promise<SessionResult> {
  const {
    runId,
    projectId,
    chatSessionId,
    maxTurns,
    budgets,
    runtime,
    authHeader,
    managerFactory,
    abortSignal,
    nextPersonaTurn,
    persist,
    onTurnPersisted,
    browserArtifacts,
    emit,
  } = adapter;
  const {
    modelDefinition,
    systemPrompt,
    temperature,
    maxSteps,
    requireToolApproval,
    respectToolVisibility,
    progressiveToolDiscovery,
    builtInToolIds,
    browserToolPolicy,
    browserProfileId,
    modelVisibleMcpToolResults,
    mcpToolResultImageRendering,
    computer,
    harness,
    sandboxBinding,
    harnessSandboxBinding,
    accessVersion,
    scenarioId,
    environmentId,
    modelSelection,
    reasoningEffort,
  } = runtime;

  // FAIL CLOSED before anything is built (B-isolation F4). `runHarnessTurn`
  // does not go through `resolveHostTools`, so without an explicit ephemeral
  // binding it falls back to `resolveHarnessSandbox` — the launcher's shared
  // personal computer. Refusing here means that reserve is never reached; the
  // alternative — running the harness anyway — is the exact contamination
  // B-isolation exists to remove.
  //
  // The SURFACE decides, and passes its decision in — this core is shared with
  // the scenario simulation, where a harness on the acting member's own computer
  // is exactly right. Deliberately NOT re-derived here as "swarm + no binding":
  // the swarm runner knows whether the ephemeral regime is in force, and a
  // rule here that assumed it would refuse every harness on the legacy path
  // too. The runner sets this whenever it could not produce a binding.
  if (runtime.harness && runtime.harnessBlockedReason) {
    const reason = runtime.harnessBlockedReason;
    logger.warn("[sessionSimulation.runner] harness turn refused", {
      runId: adapter.runId,
      chatSessionId: adapter.chatSessionId,
      reason,
    });
    emit?.({
      type: "session_notice",
      kind: "tool_suppressed",
      toolId: "harness",
      message: reason,
    });
    return { outcome: "failed", errorMessage: reason };
  }

  const sessionStartedAt = Date.now();
  // The session's clock, nested under whatever the caller passed (the run's
  // stop signal, composed with cancel and the spend cap). `withDeadline`
  // COMPOSES rather than replaces, so everything downstream still sees one
  // signal and it fires on whichever bound trips first.
  //
  // Declared before the `try` because the `finally` disposes it, and because
  // `sessionSignal` is what the turn loop reads instead of the raw
  // `abortSignal` — reading the raw one would miss this session's own budget.
  const sessionDeadline = withDeadline(
    abortSignal,
    budgets.unitTimeoutMs,
    "session",
  );
  const sessionSignal = sessionDeadline.signal;
  /** The turn currently in flight. Exactly one is armed at a time. */
  let turnDeadline: DeadlineHandle | undefined;
  const admissionBudget = new AdmissionWaitBudget();
  const admissionOptions = {
    budget: admissionBudget,
    signal: sessionSignal,
    onWait: () => {
      turnDeadline?.dispose();
      return () => {
        turnDeadline = withDeadline(
          sessionSignal,
          budgets.turnTimeoutMs,
          "turn",
        );
      };
    },
  };
  let manager: MCPClientManager | undefined;
  let dispose: (() => Promise<void>) | undefined;
  // Browser-rendered MCP App pipeline (same machinery as eval iterations):
  // declared before the try so the terminal path can capture artifacts and
  // dispose a launched Chromium on every exit. Construction is cheap; Chromium
  // launches lazily on the first widget render, so sessions that never touch an
  // MCP App pay nothing.
  let browser: BrowserSessionContext | undefined;

  // --- Terminal-path state -------------------------------------------------
  // Hoisted out of the try so the terminal path can persist a session row on
  // EVERY exit, the failure branches included. A first-turn failure is the
  // single most valuable thing to be able to watch back, and it used to return
  // with no `chatSessions` row at all — leaving the artifacts it did produce
  // with nothing to attach to.
  let anyTurnPersisted = false;
  let sessionRowEnsured = false;
  let selectedServerIds: string[] = [];
  // Derived from the persist signature rather than restated, so hoisting this
  // out of the try can't quietly widen what the persist accepts.
  let resumeConfig:
    | Parameters<typeof persistChatSessionToConvex>[0]["resumeConfig"]
    | undefined;
  // Captured from the first drained turn so per-session persist calls stamp the
  // correct modelSource on chatSessions. The scenario/target modelId is pinned at
  // start, so this is stable across turns.
  let sessionModelSource: SyntheticModelSource | undefined;
  // The last turn the browser context was stamped with — the fallback bucket for
  // an artifact that somehow arrives without its own promptIndex.
  let lastPromptIndex = 0;

  /**
   * Persist the session row when no turn ever did. Idempotent.
   *
   * The flag records "the write was ATTEMPTED", not "the row exists":
   * `persistChatSessionToConvex` is fail-soft — an HTTP error, a timeout, or a
   * missing `CONVEX_HTTP_URL`/auth header returns a non-`saved` outcome rather
   * than throwing (it is logged, and now also reported through the returned
   * outcome). So a failed write is not re-attempted from the terminal path. It
   * only re-attempts a write that THREW. The outbox absorbs the rest:
   * `recordBrowserArtifacts` returns `null` while the row is missing, and the
   * batch stays held.
   *
   * No-ops before the manager is built — a session that failed to connect has
   * neither artifacts nor a transcript, so a row would carry nothing.
   */
  const ensureSessionPersisted = async (): Promise<void> => {
    if (anyTurnPersisted || sessionRowEnsured || !resumeConfig) return;
    // No turn ever ran, so `sessionModelSource` is undefined. Use the same
    // resolver `drainAssistantTurn` uses so a local-runtime org-BYOK host isn't
    // mis-attributed as cloud byok on the fallback row. Soft-fall-back to
    // "byok" on resolver failure — real turns would have errored before
    // reaching this persist; we're best-effort labeling an attribution row that
    // exists only because the run ended (or died) before any turn landed.
    let emptySessionModelSource: SyntheticModelSource;
    try {
      const resolution = await resolveSyntheticModelSource({
        modelDefinition,
        projectId,
        authHeader,
        scenarioId,
        accessVersion,
        serverIds: selectedServerIds,
      });
      emptySessionModelSource = resolution.source;
    } catch {
      emptySessionModelSource = "byok";
    }
    // Headless: no stream to carry a receipt, but the outcome is still worth
    // seeing — a synthetic run whose transcripts never landed used to look
    // identical to one that saved cleanly.
    const emptySessionPersist = await persistChatSessionToConvex({
      chatSessionId,
      modelId: String(modelDefinition.id),
      modelSource: emptySessionModelSource,
      authHeader,
      projectId,
      sourceType: persist.sourceType,
      origin: persist.origin,
      ...(persist.surface ? { surface: persist.surface } : {}),
      ...(persist.scenarioId ? { scenarioId: persist.scenarioId } : {}),
      sessionMessages: messageHistory,
      startedAt: sessionStartedAt,
      lastActivityAt: Date.now(),
      synthetic: true,
      ...(persist.personaId ? { personaId: persist.personaId } : {}),
      ...(persist.personaLabel ? { personaLabel: persist.personaLabel } : {}),
      ...(persist.personaRefId ? { personaRefId: persist.personaRefId } : {}),
      ...(persist.journeyRunId ? { journeyRunId: persist.journeyRunId } : {}),
      ...(persist.hostId ? { hostId: persist.hostId } : {}),
      ...(persist.targetId ? { targetId: persist.targetId } : {}),
      resumeConfig,
    });
    warnIfSimulationPersistNotSaved(
      emptySessionPersist,
      "empty-session",
      chatSessionId,
    );
    sessionRowEnsured = true;
  };

  // Transcript so far — hoisted for `ensureSessionPersisted`, which persists
  // whatever the session managed to say before it died.
  let messageHistory: ModelMessage[] = [];

  try {
    // Raced against the session clock, because the factory takes no signal:
    // it awaits plugin re-gating, a bearer mint and `createAuthorizedManager`,
    // and none of them observes `sessionSignal`. Without the race a factory
    // that hangs parks execution here forever — the deadline fires, aborts the
    // signal, and nothing is left running to notice, so the session never
    // reaches the terminal timeout path the clock exists to provide.
    const built = await Promise.race([
      // A factory that settles LATE still owns a live manager and a browser
      // context. Nothing downstream will dispose it, because the session has
      // already unwound — so the loser of the race tears down its own work.
      managerFactory().then((value) => {
        if (sessionSignal.aborted) {
          void Promise.resolve(value.dispose()).catch(() => undefined);
        }
        return value;
      }),
      whenSessionAborted(sessionSignal),
    ]);
    manager = built.manager;
    dispose = built.dispose;
    selectedServerIds = built.connectedServerIds;
    const selectedServerNames = built.connectedServerNames;
    // Servers the session may USE but must not be told to RECONNECT later.
    const nonResumable = new Set(built.nonResumableServerIds ?? []);

    // Mirror chat-v2's direct-chat resumeConfig shape so the Scenario Sessions
    // viewer can reconnect the same servers when the user opens this session
    // later. Without this, `readResource()` for MCP App widgets fails at
    // replay time and `create_view` collapses to a tool pill.
    resumeConfig = {
      systemPrompt,
      ...(temperature !== undefined ? { temperature } : {}),
      requireToolApproval,
      ...(respectToolVisibility !== undefined ? { respectToolVisibility } : {}),
      ...(modelVisibleMcpToolResults !== undefined
        ? { modelVisibleMcpToolResults }
        : {}),
      ...(mcpToolResultImageRendering !== undefined
        ? { mcpToolResultImageRendering }
        : {}),
      // Plugin-contributed servers are filtered OUT (see
      // `nonResumableServerIds`): resume is replayed with no lifecycle check,
      // so it must never carry an id that outlives the plugin. Filtering by
      // INDEX keeps the name/id alignment the contract promises.
      selectedServers:
        Array.isArray(selectedServerNames) &&
        selectedServerNames.length === selectedServerIds.length
          ? selectedServerNames.filter(
              (_, i) => !nonResumable.has(selectedServerIds[i]!),
            )
          : selectedServerIds.filter((id) => !nonResumable.has(id)),
    };

    // Built-in tools from the scenario host config (e.g. web_search) resolve
    // the same way a real visitor's chat-v2 turn would: billed via Convex
    // against this project, namespaced under the synthetic session id.
    const browserApprovalDelivery = browserApprovalDeliveryFor(
      browserToolPolicy,
      { source: "sessionSimulation" },
    );
    // WHAT THE RUN'S OWN PAGE OFFERS, from the box this session provisioned.
    // Read-only and fail-empty, and skipped entirely unless this session
    // declared a browser policy AND brought a desktop box — a journey session
    // with neither must not pay a daemon round trip to learn it has no browser.
    // What this run advertised from the page, for the turn trace. A synthetic
    // session's transcript is read back like any other, and a card in it wants
    // the same answer: which tool on which page, as it was then.
    let advertisedPageTools: MintedDeclaredTool[] = [];
    const pageToolsSnapshot = pageToolsSnapshotFrom(
      sandboxBinding?.runtimeKind === "desktop-browser" &&
        browserApprovalDelivery
        ? await peekPageToolsForChatTurn({
            builtInToolIds,
            browserToolId: BROWSER_BUILT_IN_TOOL_ID,
            firstClass: webmcpPageToolsMode() === "first_class",
            // A harness takes its toolset as a constructor argument and never
            // re-reads it, so page tools it could not use are latency spent on
            // definitions nothing will call.
            isHarnessTurn: Boolean(harness),
            hasV1PageTools: false,
            engine: "hosted",
            projectId,
            bearer: authHeader,
            sandboxRowId: sandboxBinding.sandboxRowId,
          })
        : undefined,
    );
    // Secrets the browser may type. They are substituted inside the daemon and
    // never become env vars (see the `runtimeSecrets` note below).
    const browserSecrets = browserApprovalDelivery
      ? await resolveBrowserSecrets({
          bearer: authHeader,
          projectId,
          ...(environmentId ? { environmentId } : {}),
          chatSessionId,
        })
      : [];
    const builtInTools = resolveHostTools(
      { builtInToolIds, computer },
      {
        authHeader,
        projectId,
        chatSessionId,
        ...(browserSecrets.length > 0
          ? {
              browserSecrets,
              onBrowserSecretDelivered: () => {
                void markRuntimeSecretsDelivered(authHeader, {
                  projectId,
                  ...(environmentId ? { environmentId } : {}),
                  secretCount: browserSecrets.length,
                });
              },
            }
          : {}),
        isScenarioSession: true,
        // Journey (swarm) surface: WITHOUT a sandbox binding the resolver
        // suppresses computer-backed tools here, because every session in a run
        // would otherwise share the launcher's one project computer. See the
        // `bash` gate in registry.ts.
        isJourneySession: persist.sourceType === "swarm",
        // Unattended: the run's declared policy is the only authorization
        // browser tools can have here, since nothing can pause to ask.
        ...(browserApprovalDelivery ? { browserApprovalDelivery } : {}),
        ...(browserProfileId ? { browserProfileId } : {}),
        browserSessionScope: {
          kind:
            persist.sourceType === "swarm" ? "swarm_attempt" : "eval_iteration",
          sessionId: chatSessionId,
        },
        // A swarm runs many sessions per run, so tag rows with both ids.
        browserCorrelation: {
          chatSessionId,
          ...(persist.journeyRunId ? { swarmId: persist.journeyRunId } : {}),
        },
        // …and WITH one, bash binds to this session's own disposable box. The
        // binding rides `ctx`, never `config`, so it cannot be forged from the
        // snapshot this runtime was built from.
        ...(sandboxBinding ? { sandboxBinding } : {}),
        ...(pageToolsSnapshot ? { browserPageTools: pageToolsSnapshot } : {}),
        onBrowserPageTools: ({ minted }) => {
          advertisedPageTools = minted;
        },
        requireToolApproval,
        // Surface the suppression in the run instead of letting the tool go
        // quietly missing (which reads as a host-config bug).
        onToolSuppressed: ({ id, reason }) => {
          // Prefer the launch-time reason when we have one: the resolver only
          // knows "this is a swarm session", the snapshot knows "this
          // environment has no built image", and only the second tells the
          // reader what to change.
          const message =
            id === BASH_TOOL_NAME && runtime.bashUnavailableReason
              ? runtime.bashUnavailableReason
              : reason;
          logger.warn("[sessionSimulation.runner] built-in tool suppressed", {
            runId,
            chatSessionId,
            toolId: id,
            reason: message,
          });
          emit?.({
            type: "session_notice",
            kind: "tool_suppressed",
            toolId: id,
            message,
          });
        },
      },
    );

    // Cloud Skills parity with a real chat-v2 visitor: a synthetic session is
    // always member-initiated (the route authenticates the generator), so the
    // guest gate never trips here. Skills are delivered the same two ways chat
    // does — natively via the harness `skills` param when the turn runs the
    // real Claude Code runtime, or as the emulated prompt-inlined catalog +
    // `loadSkill` otherwise. `shouldEnableCloudSkillTools` returns false on the
    // harness path (it delivers skills itself), so this only wires the emulated
    // path, mirroring `web/chat-v2.ts`. Zero skills → no tools/stanza.
    //
    // BUT skip skills entirely when the scenario requires tool approval. A
    // synthetic visitor is headless and can't grant approval: the local-runtime
    // BYOK path fail-closes on ANY non-empty tool set when approval is on (see
    // `drainAssistantTurn` below), and the cloud/MCPJam paths auto-deny every
    // call — so advertising `loadSkill` on a project that has skills would turn
    // an otherwise-toolless approval simulation into one that fails every
    // session for no benefit. The skip stays correct even though empty
    // projects no longer advertise phantom tools.
    const pinnedSkills = runtime.pinnedSkills;
    const cloudSkillsEnabled =
      pinnedSkills === undefined &&
      !requireToolApproval &&
      Boolean(authHeader) &&
      Boolean(projectId) &&
      shouldEnableCloudSkillTools({
        isGuest: false,
        harness,
        modelId: String(modelDefinition.id),
        provider: modelDefinition.provider,
        hasProjectId: Boolean(projectId),
      });

    // Authoritative pinned mode (env-based swarm target): the emulated engine
    // gets frozen pinned tools via `skillsSource` — NEVER the live cloud-skill
    // tools. `kind: "none"` covers (a) a deliberately skill-less target, (b) the
    // approval-mode no-skills semantics (a headless visitor can't approve, same
    // rationale as the live-catalog gate above), and (c) HARNESS turns —
    // prepareChatV2 THROWS on harness+pinned, so a harness target's pinned
    // artifacts ride `pinnedHarnessSkills` on the drain instead.
    // The live arm, for a run with no pins: the project pool as a capability
    // set. Previously this was "pass nothing and let the orchestrator fall
    // through to its cloud branch"; that fallback is gone, so the source is
    // now stated here.
    //
    // A catalog failure degrades to a live set with no PROJECT skills — never
    // to `{ kind: "none" }`. The source also carries `composeLiveServerSkills`,
    // so collapsing it would take the connected servers' SEP-2640 skills down
    // with the project's, and those never failed: losing skills we could not
    // fetch is a degradation, losing skills we could is a bug. The failure is
    // recorded here rather than read back off `prepared`, because the fetch now
    // happens on this side of `prepareChatV2` and the orchestrator cannot know
    // how it went.
    let liveCapabilities: EffectiveCapabilitySet | undefined;
    let skillsFetchFailed: SkillsFetchFailure | undefined;
    // `!harness` explicitly, not just via `cloudSkillsEnabled`: that gate only
    // suppresses a harness on a hosted-catalog model, so a harness on a BYOK
    // model would otherwise build a live set and hit the disjointness refusal.
    if (!harness && cloudSkillsEnabled && authHeader && projectId) {
      const startedAt = Date.now();
      let standaloneSkills: RuntimeStandaloneSkill[] = [];
      try {
        standaloneSkills = await listCloudRuntimeSkills({
          authHeader,
          projectId,
        });
      } catch (error) {
        skillsFetchFailed = skillsFailureFrom(error, Date.now() - startedAt);
      }
      liveCapabilities = buildLiveEffectiveCapabilities({ standaloneSkills });
    }

    const skillsSource:
      | { kind: "pinned"; skills: PinnableSkill[] }
      | { kind: "none" }
      | {
          kind: "resolved";
          capabilities: EffectiveCapabilitySet;
          composeLiveServerSkills?: boolean;
        } =
      pinnedSkills === undefined
        ? liveCapabilities
          ? {
              kind: "resolved",
              capabilities: liveCapabilities,
              // Live surface: server skills come from the connected servers,
              // preserving what the fallthrough arm used to compose.
              composeLiveServerSkills: true,
            }
          : { kind: "none" }
        : harness || requireToolApproval || pinnedSkills.length === 0
        ? { kind: "none" }
        : {
            kind: "pinned",
            skills: pinnedSkills.map(
              (a): PinnableSkill => ({
                name: a.name,
                description: a.description,
                content: a.content,
                contentHash: a.contentHash,
              }),
            ),
          };

    const prepared = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: selectedServerIds,
      modelDefinition,
      systemPrompt,
      temperature,
      requireToolApproval,
      respectToolVisibility,
      modelVisibleMcpToolResults,
      ...(harness ? { harness } : {}),
      ...(progressiveToolDiscovery !== undefined
        ? {
            progressiveToolDiscovery: {
              enabled: progressiveToolDiscovery,
            },
          }
        : {}),
      ...(builtInTools ? { builtInTools } : {}),
      skillsSource,
    });

    if (skillsFetchFailed) {
      logger.warn("[sessionSimulation.runner] skills catalog fetch failed", {
        runId,
        chatSessionId,
        errorClass: skillsFetchFailed.errorClass,
        status: skillsFetchFailed.status,
        latencyMs: skillsFetchFailed.latencyMs,
      });
      emit?.({
        type: "session_notice",
        kind: "tool_suppressed",
        toolId: "skills",
        message: skillsFetchFailed.message,
      });
    }

    // One browser context per session: renders MCP App tool results in the
    // headless harness (render observations for every model) and, for assistant
    // models with vision + tool calling, adds the `computer` / `finish_widget` tools so the
    // simulated assistant can interact with rendered widgets (interaction
    // steps). `injectOpenAiCompat` is omitted to match the snapshot capture
    // below — the scenario runtime config doesn't carry the flag.
    browser = await createBrowserSessionContext({
      model: String(modelDefinition.id),
      // Session simulation is the ONE surface that opts into Computer Use: its
      // agentic personas drive rendered widgets by screenshots. Evals stay
      // deterministic and never enable it.
      enableComputerUse: true,
      mcpClientManager: manager,
      logScope: "sessionSimulation",
      // Live view: a frame per action, at CAPTURE time. Only wired when this
      // surface has a stream to put it on and the flag is on — absent, the
      // context does no thumbnail work at all.
      ...(emit && liveBrowserFramesEnabled()
        ? {
            onBrowserAction: (frame) => emit({ type: "browser_frame", frame }),
          }
        : {}),
    });

    let lastTranscript: Array<{ role: "user" | "assistant"; content: string }> =
      [];

    // Harness MCP-proxy plane. A synthetic run builds an ephemeral authorized
    // manager (like `/api/web/chat-v2`), so it's a WEB-authorized plane request:
    // resolve the strategy the same way `web-chat-turn.ts` does. Only needed when
    // this host runs a real harness — the emulated engine ignores it. Without it,
    // a harness host WITH selected MCP servers throws in runHarnessTurn.
    const harnessMcpProxy = harness
      ? resolveWebAuthorizedHarnessStrategy()
      : undefined;

    emit?.({ type: "session_start" });

    for (let turn = 0; turn < maxTurns; turn++) {
      if (sessionSignal.aborted) {
        // The session's OWN clock, told apart from a cancel the same way the
        // eval runner does it: `firedClock()` reports only this handle's bound.
        const sessionTimedOut = sessionDeadline.firedClock() === "session";
        const errorMessage = sessionTimedOut
          ? sessionTimeoutMessage(budgets.unitTimeoutMs, turn)
          : "aborted";
        emit?.({
          type: "session_complete",
          status: "failed",
          errorMessage,
        });
        return {
          outcome: "failed",
          errorMessage,
          ...(sessionTimedOut ? { errorReason: "session_timeout" } : {}),
        };
      }

      // One clock per reply, nested under the session's. Disposed at the top
      // of the next iteration and in this function's `finally`, so exactly one
      // is ever armed. Without it a single wedged turn holds the session until
      // the SESSION budget expires — the whole remaining conversation spent on
      // a reply that was never coming.
      turnDeadline?.dispose();
      turnDeadline = withDeadline(sessionSignal, budgets.turnTimeoutMs, "turn");

      const next = await withAdmissionRetry(
        () => nextPersonaTurn(lastTranscript),
        admissionOptions,
      );

      if (next.endSession) {
        if (turn === 0) {
          throw Object.assign(
            new Error(
              "The simulated user ended the session before sending the first message. The assistant was not tested. Re-run this attempt."
            ),
            { details: { reason: "persona_ended_before_start" } }
          );
        }
        break;
      }
      if (!next.message.trim()) {
        throw Object.assign(
          new Error(
            "The simulated user returned an empty message. No assistant turn was started for that message. Re-run this attempt."
          ),
          { details: { reason: "persona_empty_message" } }
        );
      }

      messageHistory.push({
        role: "user",
        content: next.message,
      } as ModelMessage);
      lastTranscript.push({ role: "user", content: next.message });

      // Stamp artifacts with this persona turn and start it with a clean
      // widget surface — a widget kept mounted by the previous turn must not
      // be advertised/targeted before this turn's own MCP App tool runs
      // (same per-turn hygiene as the eval runners).
      lastPromptIndex = turn;
      browser.setActivePromptIndex(turn);
      await browser.dismissCarriedWidget();

      emit?.({
        type: "turn_start",
        turnIndex: turn,
        prompt: next.message,
      });

      let failedTurn: RecordedAssistantTurnError | undefined;
      const {
        history: updatedHistory,
        turnTrace,
        modelSource: turnModelSource,
        harnessSessionCommit,
      } = await withAdmissionRetry(
        () =>
          drainAssistantTurn({
            messages: messageHistory,
            modelId: String(modelDefinition.id),
            modelDefinition,
            chatSessionId,
            // Tag the engine-facing turn (usage rows) with THIS surface's source:
            // "scenario" for the session-simulation surface, "swarm" for the
            // journey-execution runner. The persist attribution already carries
            // this; forwarding it keeps hosted + local-BYOK usage rows correctly
            // sourced instead of hardcoding every journey turn as "scenario".
            sourceType: persist.sourceType,
            systemPrompt: prepared.enhancedSystemPrompt,
            temperature: prepared.resolvedTemperature,
            ...(maxSteps !== undefined ? { maxSteps } : {}),
            // `computer` / `finish_widget` merge into the advertised set; the
            // prepareAdvertisedTools hook hides them until a widget is mounted.
            tools: { ...prepared.allTools, ...browser!.computerWidgetTools },
            hooks: {
              onToolCall: (event) => {
                browser!.noteToolCallInput(event);
                const args =
                  event.input &&
                  typeof event.input === "object" &&
                  !Array.isArray(event.input)
                    ? (event.input as Record<string, unknown>)
                    : { value: event.input };
                emit?.({
                  type: "tool_call",
                  toolName: event.toolName,
                  toolCallId: event.toolCallId,
                  args,
                });
              },
              onToolResult: (event) => {
                void browser!.handleEngineToolResult(event);
                emit?.({
                  type: "tool_result",
                  toolCallId: event.toolCallId,
                  result: event.output,
                });
              },
              ...(browser!.prepareAdvertisedTools
                ? { prepareAdvertisedTools: browser!.prepareAdvertisedTools }
                : {}),
              onToolResultChunk: async (chunk) => {
                await browser!.handleDirectToolResultChunk(chunk);
                emit?.({
                  type: "tool_result",
                  toolCallId: chunk.toolCallId,
                  result: chunk.output,
                });
              },
              onToolCallChunk: (chunk) => {
                emit?.({
                  type: "tool_call",
                  toolName: chunk.toolName,
                  toolCallId: chunk.toolCallId,
                  args: chunk.input,
                });
              },
              ...(emit
                ? {
                    onLiveTextDelta: (content: string) => {
                      emit({ type: "text_delta", content });
                    },
                    onStepFinish: (event: {
                      stepIndex: number;
                      turnUsage?: {
                        inputTokens?: number;
                        outputTokens?: number;
                      };
                    }) => {
                      emit({
                        type: "step_finish",
                        stepNumber: event.stepIndex,
                        ...(event.turnUsage
                          ? {
                              usage: {
                                inputTokens: event.turnUsage.inputTokens ?? 0,
                                outputTokens: event.turnUsage.outputTokens ?? 0,
                              },
                            }
                          : {}),
                      });
                    },
                  }
                : {}),
            },
            progressivePlan: prepared.progressivePlan,
            discoveryState: prepared.discoveryState,
            mcpClientManager: manager!,
            selectedServers: selectedServerIds,
            requireToolApproval,
            ...(harness ? { harness } : {}),
            // Harness MCP-proxy plane (harness hosts with MCP servers) + swarm
            // continuity identity (`swarm-chat` owner lane). `harnessMcpProxy` is
            // resolved once above; `journeyRunId`/`hostId` are the swarm run + pinned
            // host. All three are inert for the emulated engine / non-swarm surfaces.
            ...(harnessMcpProxy ? { harnessMcpProxy } : {}),
            // Pinned harness skills (env-based swarm target running a real
            // harness): the harness turn skips the live skills fetch and delivers
            // exactly these artifacts (skillsHash derives from their fingerprints).
            // Passed even when EMPTY — an empty authoritative set means the
            // harness must run skill-less, not fall back to the live pool.
            ...(harness && pinnedSkills !== undefined
              ? { pinnedHarnessSkills: pinnedSkills }
              : {}),
            // The attempt's own disposable box for the HARNESS turn. Only meaningful
            // when a harness is selected — the emulated engine's shell binds through
            // `resolveHostTools` above instead.
            ...(harness && harnessSandboxBinding
              ? { harnessSandboxBinding }
              : {}),
            // The target's Project Environment — the GRANT BOUNDARY the harness
            // turn checks a BROKERED external-account credential against. Harness
            // only: the emulated engine resolves no such credential, and this
            // runner delivers no materialized secrets on either path (see the
            // `runtimeSecrets` contract on `MCPJamHandlerOptions`), so brokered
            // delivery is the only one a swarm attempt can use.
            ...(harness && environmentId ? { environmentId } : {}),
            // Server-executed built-ins (`web_search`, …) for the HARNESS turn.
            // The emulated engine already receives them merged into `tools` via
            // prepareChatV2's `allTools`; the harness reads them off this separate
            // option instead, because it hands them to the runtime as specs and
            // executes them here, while MCP-server tools go via `.mcp.json`. Only
            // for a harness target — passing them on the emulated path would
            // duplicate what `allTools` already carries.
            ...(harness && builtInTools && Object.keys(builtInTools).length > 0
              ? { builtInTools }
              : {}),
            ...(persist.hostId ? { hostId: persist.hostId } : {}),
            // Scenario surface only. The scenario runtime-config redeem returns an
            // accessVersion that /stream/org/resolve uses to authorize the actor
            // against the versioned scenario; threading it (instead of undefined)
            // matches what real-visitor synthetic-equivalent chats send. The swarm
            // surface authorizes via project membership and leaves both undefined.
            ...(scenarioId ? { scenarioId } : {}),
            accessVersion,
            projectId,
            authHeader,
            abortSignal: turnDeadline!.signal,
            // Threaded into the per-step /stream (or /stream/org) body and the
            // /stream/org/local-usage writeback so the backend BYOK and JAM-paid
            // writers can stamp the run id onto llmUsageRecord for per-run spend
            // attribution.
            ...(persist.journeyRunId
              ? { journeyRunId: persist.journeyRunId }
              : {}),
            ...(modelSelection ? { modelSelection } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
          }),
        admissionOptions,
      ).catch((error: unknown) => {
        if (!(error instanceof RecordedAssistantTurnError)) throw error;
        // Like evals, save the failed turn's evidence before terminating the
        // session. Do not ask the persona to react to an absent reply.
        failedTurn = error;
        return error.turn;
      });

      if (turnDeadline.firedClock() === "turn") {
        // Ends the SESSION, not just the turn — and that asymmetry with the
        // eval runner is deliberate. Eval prompt turns are independently
        // authored and independently graded, so the next one still means
        // something. A swarm session is one conversation: turn N+1 is the
        // persona reacting to turn N's reply, and there is no reply to react
        // to. Carrying on would feed the persona a hole in the transcript.
        const errorMessage = turnTimeoutMessage(budgets.turnTimeoutMs, turn);
        emit?.({
          type: "session_complete",
          status: "failed",
          errorMessage,
        });
        return {
          outcome: "failed",
          errorMessage,
          errorReason: "turn_timeout",
        };
      }

      emit?.({ type: "turn_finish", turnIndex: turn });
      // Track the first turn's modelSource for the per-session persist
      // calls. modelSource is stable across turns within a session because
      // scenario modelId is pinned by `fetchScenarioRuntimeConfig` at start.
      if (sessionModelSource === undefined) {
        sessionModelSource = turnModelSource;
      }

      messageHistory = updatedHistory;
      const assistantText = extractAssistantText(updatedHistory);
      lastTranscript.push({ role: "assistant", content: assistantText });

      if (!turnTrace) {
        if (failedTurn) throw failedTurn;
        // No-trace turns skip transcript persistence (today only the aborted
        // local-BYOK path reaches here — failed turns throw above). Their
        // browser artifacts must still leave the context's "new" window now: a
        // later turn's drain would otherwise sweep them up (CodeRabbit,
        // PR 2610). With an outbox they are KEPT — it buckets by each
        // artifact's own promptIndex, so they land under the turn that produced
        // them rather than a later one, and a turn that clicked but produced no
        // trace still has evidence. Without one, discard as before.
        if (browserArtifacts) {
          try {
            browserArtifacts.take(browser, turn);
          } catch {
            browser.drainNewArtifacts();
          }
        } else {
          browser.drainNewArtifacts();
        }
        continue;
      }

      // Mirror chat-v2's per-turn persistence so the Trace tab and the
      // tool-snapshot/serverInspections fan-out work identically for
      // synthetic sessions and Playground sessions. Snapshot failures
      // must never block the persist.
      let toolSnapshot: unknown;
      try {
        const liveManager = built.manager;
        const knownIds =
          typeof liveManager.hasServer === "function"
            ? selectedServerIds.filter((id) => liveManager.hasServer(id))
            : selectedServerIds;
        if (knownIds.length > 0) {
          toolSnapshot =
            await exportConnectedServerToolSnapshotForEvalAuthoring(
              liveManager,
              knownIds,
              { logPrefix: "sessionSimulation.persist" },
            );
        }
      } catch {
        toolSnapshot = undefined;
      }

      const turnPersist = await persistChatSessionToConvex({
        chatSessionId,
        modelId: String(modelDefinition.id),
        modelSource: sessionModelSource ?? "mcpjam",
        authHeader,
        projectId,
        sourceType: persist.sourceType,
        // Synthetic session — distinguished from real traffic by the
        // `synthetic: true` flag already on the row, not by origin. Training
        // filters should combine `origin` with `synthetic !== true`.
        origin: persist.origin,
        ...(persist.surface ? { surface: persist.surface } : {}),
        ...(persist.scenarioId ? { scenarioId: persist.scenarioId } : {}),
        sessionMessages: messageHistory,
        startedAt: sessionStartedAt,
        lastActivityAt: Date.now(),
        synthetic: true,
        ...(persist.personaId ? { personaId: persist.personaId } : {}),
        ...(persist.personaLabel ? { personaLabel: persist.personaLabel } : {}),
        ...(persist.personaRefId ? { personaRefId: persist.personaRefId } : {}),
        ...(persist.journeyRunId ? { journeyRunId: persist.journeyRunId } : {}),
        ...(persist.hostId ? { hostId: persist.hostId } : {}),
        ...(persist.targetId ? { targetId: persist.targetId } : {}),
        // An EMPTY array is meaningful and is written: "this turn advertised no
        // page tools" is a different fact from "we do not know", and only the
        // second is what an absent field means.
        turnTrace: pageToolsSnapshot
          ? {
              ...turnTrace,
              pageToolsAtTurn: toMintedPageToolRecords(
                advertisedPageTools,
                pageToolsSnapshot,
              ),
            }
          : turnTrace,
        resumeConfig,
        ...(toolSnapshot ? { toolSnapshot } : {}),
        // §3: ride this turn's harness resume-state commit into /ingest-chat
        // atomically with the transcript (the caller-persist path — the harness
        // turn ran with persistMode "caller", so nothing else commits it). For a
        // swarm harness turn this carries `ownerType: "swarm-chat"`; the backend
        // derives the lane's journeyRunId/hostId from the top-level swarm
        // attribution above. Undefined for the emulated engine.
        ...(harnessSessionCommit ? { harnessSessionCommit } : {}),
      });
      warnIfSimulationPersistNotSaved(turnPersist, "turn", chatSessionId);
      anyTurnPersisted = true;

      // MCP App widget snapshots so the Sessions viewer renders the actual
      // widget instead of a collapsed tool pill. Best-effort — a failure here
      // never aborts the run.
      if (onTurnPersisted) {
        await onTurnPersisted({
          messages: messageHistory,
          browser,
          manager,
          connectedServerIds: selectedServerIds,
          promptIndex: turn,
        });
      }

      // Hand this turn's browser artifacts to the outbox and try to land them
      // now. Anything the write can't take yet — most often turn 0, which races
      // `/ingest-chat` — stays held and is retried on the next turn's flush and
      // again at the terminal, instead of being dropped as it used to be.
      //
      // Contained: the outbox already swallows write failures, but a session
      // must never FAIL because recording it did. That would be observability
      // breaking the thing it observes.
      if (browserArtifacts) {
        try {
          browserArtifacts.take(browser, turn);
          await browserArtifacts.flush();
        } catch (err) {
          logger.warn(
            "[sessionSimulation.runner] per-turn artifact flush failed",
            {
              runId,
              chatSessionId,
              promptIndex: turn,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
      if (failedTurn) throw failedTurn;
    }

    // The success path must have exercised the assistant. In particular, an
    // invalid zero-turn budget must not turn an empty simulation into success.
    if (messageHistory.length === 0) {
      throw Object.assign(
        new Error(
          "The simulation ended without starting a conversation. The assistant was not tested."
        ),
        { details: { reason: "simulation_no_conversation" } }
      );
    }
    await ensureSessionPersisted();

    emit?.({ type: "session_complete", status: "succeeded" });
    return { outcome: "succeeded" };
  } catch (error) {
    // A deadline abort reaches here as an `AbortError` whose message is the
    // runtime's ("This operation was aborted"), which tells a reader nothing.
    // `deadlineClockOf` recovers WHICH bound tripped and says so.
    const firedClock = deadlineClockOf(error);
    if (firedClock === "session" || firedClock === "turn") {
      const errorMessage =
        firedClock === "session"
          ? sessionTimeoutMessage(budgets.unitTimeoutMs)
          : turnTimeoutMessage(budgets.turnTimeoutMs);
      emit?.({
        type: "session_complete",
        status: "failed",
        errorMessage,
      });
      return {
        outcome: "failed",
        errorMessage,
        errorReason:
          firedClock === "session" ? "session_timeout" : "turn_timeout",
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    const errorRefusal =
      error instanceof RecordedAssistantTurnError
        ? error.errorRefusal
        : spendRefusalOf(error);
    // Single source of truth for the spend-cap / rate-limit fold — shared with
    // the per-runtime `classifyFailure` so the regex can't drift. Return the
    // message on the rate-limited branch too: the swarm fan-out runner inspects
    // it to distinguish a provider 429 (stop THIS host) from an org spend-cap
    // breach (stop the WHOLE run). The scenario runner ignores it for
    // rate-limited outcomes, so this is a safe additive change.
    if (classifyTurnFailure(message) === "rate_limited") {
      emit?.({
        type: "session_complete",
        status: "rate_limited",
        errorMessage: message,
      });
      return { outcome: "rate_limited", errorMessage: message, errorRefusal };
    }
    logger.warn("[sessionSimulation.runner] session failed", {
      runId,
      chatSessionId,
      personaId: persist.personaId,
      error: message,
    });
    emit?.({
      type: "session_complete",
      status: "failed",
      errorMessage: message,
    });
    const errorReason = readErrorReason(error);
    return {
      outcome: "failed",
      errorMessage: message,
      ...(errorReason ? { errorReason } : {}),
      errorRefusal,
    };
  } finally {
    turnDeadline?.dispose();
    sessionDeadline.dispose();
    // Tear down the browser harness (and its headless Chromium, if launched)
    // before the manager: the harness's widget bridge dispatches tools/call
    // through the manager, so it must die first.
    let runtimeDisposed = false;
    const disposeRuntime = async (): Promise<void> => {
      if (runtimeDisposed) return;
      runtimeDisposed = true;
      if (browser) {
        try {
          await browser.dispose();
        } catch (err) {
          logger.warn("[sessionSimulation.runner] browser dispose failed", {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (dispose) {
        try {
          await dispose();
        } catch (err) {
          logger.warn("[sessionSimulation.runner] manager dispose failed", {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    if (!browser || !browserArtifacts) {
      // No harness, or this surface didn't opt into durable capture — nothing to
      // collect. But a surface that DID opt in still wants its row: a failure
      // during `prepareChatV2` or browser construction gets here, and without a
      // `chatSessions` row that attempt can't be opened alongside the run at all.
      if (browserArtifacts) {
        try {
          await ensureSessionPersisted();
        } catch (err) {
          logger.warn(
            "[sessionSimulation.runner] terminal session persist failed",
            {
              runId,
              chatSessionId,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
      await disposeRuntime();
    } else {
      const activeBrowser = browser;
      const outbox = browserArtifacts;
      // Capture → teardown → persist. Only `collectVideo()` and the drain need
      // Chromium alive; the uploads and the mutation do not, and running them
      // first would let a stalled upload pin the browser AND the MCP manager
      // open behind it. The shared helper owns that ordering for every surface.
      //
      // Wrapped whole: this runs in a `finally`, where a throw would REPLACE the
      // session's already-decided result — turning a session that succeeded into
      // a reported failure because a screenshot upload went wrong. Observability
      // work must never do that.
      try {
        await finalizeWithBrowserArtifacts({
          browser: activeBrowser,
          logScope: "sessionSimulation.runner",
          // Memory-only drain of the last turn's artifacts (a failed turn never
          // reached its per-turn take, so this is where a first-turn failure's
          // screenshots come from).
          captureBeforeTeardown: async () => {
            outbox.take(activeBrowser, lastPromptIndex);
          },
          teardown: disposeRuntime,
          sink: {
            kind: "session",
            persist: async (videoBytes) => {
              // The row has to exist before the artifacts can attach to it —
              // and on the failure paths nothing has written one yet.
              try {
                await ensureSessionPersisted();
              } catch (err) {
                logger.warn(
                  "[sessionSimulation.runner] terminal session persist failed",
                  {
                    runId,
                    chatSessionId,
                    error: err instanceof Error ? err.message : String(err),
                  },
                );
              }
              if (videoBytes) await outbox.stageVideo(videoBytes);
              // Bounded: `ConvexHttpClient.mutation` carries no timeout of its
              // own, and this runs on the way out of the session. Nothing is
              // pinned by then (the browser and the manager are already gone),
              // but a hung mutation would still hold a swarm worker slot while
              // contributing nothing. Whatever doesn't land stays unpersisted and
              // is reported by the `pending` warning below.
              const result = await settleWithin(
                outbox.flush(),
                TERMINAL_ARTIFACT_FLUSH_TIMEOUT_MS,
                {
                  written: 0,
                  pending: outbox.pendingBatchCount,
                  videoAttached: false,
                },
              );
              if (result.pending > 0) {
                logger.warn(
                  "[sessionSimulation.runner] browser artifacts left unpersisted",
                  {
                    runId,
                    chatSessionId,
                    pending: result.pending,
                    videoAttached: result.videoAttached,
                  },
                );
              }
            },
          },
        });
      } catch (err) {
        logger.warn("[sessionSimulation.runner] terminal capture failed", {
          runId,
          chatSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Idempotent — a no-op when the helper already tore down. Guarantees
        // teardown even if the helper failed before reaching it.
        await disposeRuntime();
      }
    }
  }
}

/**
 * Walk the synthetic session's message history for MCP App tool calls,
 * fetch each widget's HTML via `MCPClientManager.readResource()`, upload it
 * to Convex storage, and persist a `sharedChatWidgetSnapshots` row through
 * `chatSessions:createWidgetSnapshot`. Without this, the Scenario Sessions
 * viewer's `getWidgetSnapshots` query returns empty for synthetic threads
 * and MCP App tool calls collapse to a plain pill instead of rendering the
 * actual widget (e.g. Excalidraw `create_view`).
 *
 * Best-effort end-to-end: any failure (missing accessVersion, mutation
 * error, transient network) is logged and swallowed — never aborts the
 * synthetic run. The Convex mutation patches existing rows on
 * `(sessionId, toolCallId)` so re-running this per turn is idempotent.
 *
 * `scenarioId`/`accessVersion` select the mutation's hosted-scenario auth
 * branch; callers without a scenario (the swarm surface) omit both and the
 * mutation authorizes via its direct-session path instead (session owner +
 * per-snapshot `serverId`, which `captureMcpAppWidgetSnapshots` always
 * stamps from the tool call's originating server).
 */
export async function captureAndPersistWidgetSnapshotsForSession(args: {
  messages: ModelMessage[];
  mcpClientManager: MCPClientManager;
  convexAuthToken: string;
  chatSessionId: string;
  scenarioId?: string;
  accessVersion?: number;
  /**
   * Session-scoped set of tool-call ids whose snapshot row is already
   * persisted. Callers invoking this per turn over a growing transcript
   * pass one set per session: already-persisted calls are skipped before
   * `readResource`/upload (the walk is otherwise quadratic in turns), and
   * an id is added only after its mutation succeeds — a transient failure
   * (including the mutation's null return while `/ingest-chat` hasn't
   * written the session row yet) retries naturally on the next turn.
   */
  capturedToolCallIds?: Set<string>;
}): Promise<void> {
  const {
    messages,
    mcpClientManager,
    convexAuthToken,
    chatSessionId,
    scenarioId,
    accessVersion,
    capturedToolCallIds,
  } = args;

  // `convexHttpUrl` is the `.convex.site` HTTP-actions endpoint (the runner
  // uses it for `/session-simulation/*` fetches). `ConvexHttpClient` wants
  // the deployment URL (`.convex.cloud`) so it can call queries/mutations.
  // The evals runner pulls the same env via `createConvexClient` in
  // `server/services/evals/route-helpers.ts`; we read it directly here to
  // avoid cross-importing an eval-flavored helper.
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    logger.warn(
      "[sessionSimulation.runner] CONVEX_URL not set; skipping widget snapshot capture",
      { chatSessionId, scenarioId },
    );
    return;
  }

  let convexClient: ConvexHttpClient;
  try {
    convexClient = new ConvexHttpClient(convexUrl);
    convexClient.setAuth(convexAuthToken);
  } catch (err) {
    logger.warn("[sessionSimulation.runner] convex client setup failed", {
      chatSessionId,
      convexUrl,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return;
  }

  let snapshots: EvalTraceWidgetSnapshot[] | undefined;
  try {
    snapshots = await captureMcpAppWidgetSnapshots({
      messages,
      mcpClientManager,
      uploadTarget: {
        convexAuthToken,
        chatSessionId,
        ...(scenarioId !== undefined ? { scenarioId } : {}),
        ...(accessVersion !== undefined ? { accessVersion } : {}),
      },
      ...(capturedToolCallIds ? { skipToolCallIds: capturedToolCallIds } : {}),
    });
  } catch (err) {
    logger.warn("[sessionSimulation.runner] widget snapshot capture failed", {
      chatSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!snapshots || snapshots.length === 0) {
    return;
  }

  await Promise.allSettled(
    snapshots.map(async (snap) => {
      // The capture helper short-circuits when readResource fails or the
      // resource is missing HTML, but it still emits a snapshot stub.
      // `evalTraceSnapshotToPayload` returns null in that case so we
      // drop the stub instead of sending an invalid call.
      const widgetPayload = evalTraceSnapshotToPayload(snap);
      if (!widgetPayload) return;
      // Sanitize for Convex transport — `widgetPermissions` is free-form
      // and JSON Schema fragments use $-prefixed keys (`$ref`, `$schema`)
      // which Convex rejects at the argument-validator boundary.
      const sanitized = sanitizeWidgetForBackend(widgetPayload);
      try {
        const result = await convexClient.mutation(
          "chatSessions:createWidgetSnapshot" as any,
          {
            ...(scenarioId !== undefined ? { scenarioId } : {}),
            ...(accessVersion !== undefined ? { accessVersion } : {}),
            chatSessionId,
            ...sanitized,
          },
        );
        // Null = the ingest race (session row not written yet) — leave the
        // id unmarked so the next turn retries. Anything else is the row id.
        if (result != null) {
          capturedToolCallIds?.add(snap.toolCallId);
        }
      } catch (err) {
        logger.warn("[sessionSimulation.runner] createWidgetSnapshot failed", {
          chatSessionId,
          toolCallId: snap.toolCallId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}

// `SyntheticModelSource` is imported from `org-model-config.ts` so the
// runner and the shared resolver stay in lockstep.

/**
 * Hooks a caller can attach to the assistant turn (the browser session
 * context wires these so MCP App tool results render in the headless
 * harness and Computer Use tools gate on a live widget mount).
 */
export interface DrainAssistantTurnHooks {
  /** Engine branches (`/stream`, `/stream/org`): MCPJamHandlerOptions pass-throughs. */
  onToolCall?: MCPJamHandlerOptions["onToolCall"];
  onToolResult?: MCPJamHandlerOptions["onToolResult"];
  /** Live text deltas (hosted + direct). Swarm SSE / eval sinks use this. */
  onLiveTextDelta?: MCPJamHandlerOptions["onLiveTextDelta"];
  /** Per-step settle (hosted + direct). Swarm SSE / eval sinks use this. */
  onStepFinish?: MCPJamHandlerOptions["onStepFinish"];
  /** All branches: per-step advertised-tool narrowing. */
  prepareAdvertisedTools?: MCPJamHandlerOptions["prepareAdvertisedTools"];
  /** Local AI-SDK branch: awaited per-tool-result render hook. */
  onToolResultChunk?: DirectChatTurnTraceEvents["onToolResultChunk"];
  /**
   * Local AI-SDK branch: tool-call chunk (via `traceEvents.onToolCallChunk`).
   * Hosted engines use {@link onToolCall} instead.
   */
  onToolCallChunk?: DirectChatTurnTraceEvents["onToolCallChunk"];
}

/** A failed hosted turn still owns transcript and trace evidence to persist. */
class RecordedAssistantTurnError extends Error {
  refusal?: SpendRefusal;
  errorRefusal?: SpendRefusal;
  constructor(
    message: string,
    readonly turn: {
      history: ModelMessage[];
      turnTrace: PersistedTurnTrace | undefined;
      modelSource: SyntheticModelSource;
      harnessSessionCommit?: HarnessSessionCommitPayload;
    },
  ) {
    super(message);
    this.name = "RecordedAssistantTurnError";
  }
}

/**
 * TEMPORARY COMPATIBILITY ADAPTER (PR 3a). `drainAssistantTurn` is now a thin
 * wrapper over {@link resolveTurnRuntime} + {@link runUnifiedAssistantTurn}: it
 * resolves the concrete {@link TurnRuntime} (MCPJam `/stream`, cloud-BYOK
 * `/stream/org`, or the direct in-process engine for local BYOK), drives ONE
 * turn through the shared facade, applies the synthetic error contract, and
 * fires the local-BYOK usage writeback.
 *
 * No SSE Response is built or drained: the facade runs `streamSink: "none"` /
 * `persistMode: "caller"` (the hosted agent loop and transcript capture
 * complete before it returns; the direct engine consumes headlessly). Synthetic
 * runs own persistence themselves (per-turn `persistChatSessionToConvex` with
 * `synthetic: true`, `personaId`, `journeyRunId`).
 *
 * Error contract (byte-preserved from the pre-facade dispatch): turn failures
 * THROW. Hosted engines use the same failure inspection as evals: missing
 * traces, empty replies, and failed model-step spans terminate the session.
 * Tool-error evidence remains distinct. The direct engine always produces a
 * trace, so it signals failure via
 * `onEngineError`. Surfacing the failure lets `runOneSession`'s classifier see
 * real spend-cap / rate-limit errors (→ `"rate_limited"`) and genuine provider
 * failures (→ `"failed"`).
 *
 * Returns the post-turn message history, the per-turn trace, and the resolved
 * `modelSource` so the caller can stamp `persistChatSessionToConvex` correctly.
 */
export async function drainAssistantTurn(
  args: Omit<
    MCPJamHandlerOptions,
    "onConversationComplete" | "onStreamComplete"
  > & {
    chatSessionId: string;
    /** Resolved provider info for org-BYOK dispatch. Falls back to lookup. */
    modelDefinition: ModelDefinition;
    /**
     * Swarm (journey-execution) run id. Forwarded into the hosted `/stream`
     * body and the local-BYOK usage writeback so per-journey-run spend rolls
     * up in one query.
     */
    journeyRunId?: string;
    /**
     * The saved selection behind `modelDefinition` (see
     * `SyntheticHostRuntime.modelSelection`), forwarded by `resolveTurnRuntime`
     * on the rail it names.
     */
    modelSelection?: ModelSelection;
    /**
     * The effective reasoning effort (see `SyntheticHostRuntime`), applied by
     * `resolveTurnRuntime` on the rail it resolves.
     */
    reasoningEffort?: ModelReasoningEffort;
    /** Optional turn hooks (browser session context attachment points). */
    hooks?: DrainAssistantTurnHooks;
  },
): Promise<{
  history: ModelMessage[];
  turnTrace: PersistedTurnTrace | undefined;
  modelSource: SyntheticModelSource;
  /**
   * §3 harness resume-state commit from a successful harness turn. The caller
   * (a synthetic/swarm session) forwards it into its own
   * `persistChatSessionToConvex` so it rides `/ingest-chat` atomically with the
   * transcript. Undefined for the emulated engine and non-continuity turns.
   */
  harnessSessionCommit?: HarnessSessionCommitPayload;
}> {
  const {
    modelDefinition,
    journeyRunId,
    hostId,
    harnessMcpProxy,
    pinnedHarnessSkills,
    harnessSandboxBinding,
    environmentId,
    builtInTools: harnessBuiltInTools,
    extraBodyFields,
    hooks,
    modelSelection,
    reasoningEffort,
  } = args;

  // FAIL CLOSED on partial swarm identity: `journeyRunId` and `hostId` are one
  // continuity/attribution identity — the harness `swarm-chat` lane keys on
  // BOTH (+ chatSessionId), and the ingest attributes on both. Forwarding them
  // as independently-optional fields let a wiring bug silently emit incomplete
  // attribution (cubic P2); a swarm turn with only one of them is a runner bug,
  // not a degraded mode.
  if (args.sourceType === "swarm" && !!journeyRunId !== !!hostId) {
    throw new Error(
      "Swarm turn has partial continuity identity: journeyRunId and hostId " +
        "must be provided together",
    );
  }

  // Run attribution that `resolveTurnRuntime` stamps onto the local-BYOK
  // usage writeback.
  const attribution: TurnRunAttribution = journeyRunId
    ? { journeyRunId }
    : undefined;

  // Forward the swarm `journeyRunId` into the hosted `/stream` (or `/stream/org`)
  // body as an extra field. The backend spend writer ignores unknown fields
  // until the swarm wiring lands (`feedback_bridge_preserves_unknown_fields`),
  // so this is forward-compatible and inert for the scenario path.
  const mergedExtraBodyFields =
    journeyRunId !== undefined
      ? { ...(extraBodyFields ?? {}), journeyRunId }
      : extraBodyFields;

  // Narrow MCPJamHandlerOptions' open `sourceType` string to the engine union.
  // The session-simulation surface passes "scenario"; the swarm runner passes
  // "swarm" (both flow through here). Anything else falls back to "scenario".
  const sourceType =
    args.sourceType === "direct" ||
    args.sourceType === "eval" ||
    args.sourceType === "swarm"
      ? args.sourceType
      : ("scenario" as const);

  // Provider/runtime resolution + local usage writeback + approval guard, in
  // one shared adapter. Uses the same resolver the empty-session fallback
  // persist uses, so the two attribution paths can't drift.
  const rt = await resolveTurnRuntime({
    modelDefinition,
    messages: args.messages,
    projectId: args.projectId ?? "",
    authHeader: args.authHeader,
    scenarioId: args.scenarioId,
    accessVersion: args.accessVersion,
    serverIds: args.selectedServers,
    sourceType,
    chatSessionId: args.chatSessionId,
    requireToolApproval: args.requireToolApproval,
    tools: args.tools as ToolSet,
    ...(args.harness ? { harness: args.harness } : {}),
    ...(mergedExtraBodyFields
      ? { extraBodyFields: mergedExtraBodyFields }
      : {}),
    ...(attribution ? { attribution } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    // What the engine is handed below, so the rail applies the effort and
    // the local execution record states the settings actually sent.
    ...(args.temperature !== undefined || reasoningEffort !== undefined
      ? {
          settings: {
            ...(args.temperature !== undefined
              ? { temperature: args.temperature }
              : {}),
            ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
          },
        }
      : {}),
  });

  // Engine-error signal. Structural type covers both the hosted
  // `MCPJamEngineErrorEvent` and the direct `DirectChatTurnEngineErrorEvent`.
  let lastEngineError: ({ message: string } & SpendRefusal) | undefined;
  const captureEngineError = (event: { message: string } & SpendRefusal) => {
    lastEngineError = event;
  };

  if (rt.runtime.kind === "direct") {
    // Local-runtime org BYOK → the in-process AI-SDK engine. `maxSteps` mirrors
    // the local handler's 30-step default (the direct engine's own default is
    // 20). Browser hooks flow through the facade's inert callback extensions.
    const result = await runUnifiedAssistantTurn({
      runtime: rt.runtime,
      streamSink: "none",
      messages: args.messages,
      systemPrompt: args.systemPrompt,
      ...(args.temperature !== undefined
        ? { temperature: args.temperature }
        : {}),
      tools: args.tools as ToolSet,
      maxSteps: resolveLocalOrgMaxSteps(args.maxSteps),
      ...(args.progressivePlan
        ? { progressivePlan: args.progressivePlan }
        : {}),
      ...(args.discoveryState ? { discoveryState: args.discoveryState } : {}),
      ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
      ...(hooks?.prepareAdvertisedTools
        ? { prepareAdvertisedTools: hooks.prepareAdvertisedTools }
        : {}),
      ...(hooks?.onToolResultChunk
        ? { onToolResultChunk: hooks.onToolResultChunk }
        : {}),
      ...(hooks?.onToolCallChunk
        ? { onToolCallChunk: hooks.onToolCallChunk }
        : {}),
      ...(hooks?.onLiveTextDelta
        ? { onLiveTextDelta: hooks.onLiveTextDelta }
        : {}),
      ...(hooks?.onStepFinish ? { onStepFinish: hooks.onStepFinish } : {}),
      onEngineError: captureEngineError,
    });

    // Aborted mid-turn: drop it (no writeback, no persist). Return the INPUT
    // history unchanged, matching the old `runLocalOrgChatTurnHeadless` abort
    // contract (`{ messages, aborted: true }`).
    if (result.aborted) {
      return {
        history: args.messages,
        turnTrace: undefined,
        modelSource: rt.modelSource,
      };
    }

    // Bill on ANY non-aborted completion — INCLUDING a mid-stream engine error
    // after token consumption. This matches the old `buildLocalOrgOnPersist`,
    // where `postLocalUsage` fired unconditionally at the top of `onPersist`
    // (which runs on non-aborted completion, error included) and ONLY transcript
    // persistence was gated on the error. The engine's `onFinish` populates
    // `traceTurn.turnUsage` even on error, so `result.usage` carries the
    // consumed tokens. Finalize BEFORE throwing so a failed local-BYOK turn's
    // real spend is still recorded (cubic P1: post-consumption undercount).
    await rt.finalizeUsage(
      result,
      lastEngineError
        ? { engineError: { message: lastEngineError.message } }
        : undefined,
    );

    // The direct engine always produces a trace, so a turn-terminating failure
    // is signalled by `onEngineError` (its `onError` fires only for fatal
    // errors; recovered per-step tool errors never reach here). Throw — AFTER
    // billing — with the same message shape the old headless path did.
    if (lastEngineError) {
      throw new Error(
        lastEngineError.message || "Local org-BYOK turn failed mid-stream.",
      );
    }

    // Rebuild history with the SAME deduped append the old local path used
    // (`buildLocalOrgOnPersist` / `runLocalOrgChatTurnHeadless`:
    // `capturedHistory = [...messages]; appendDedupedModelMessages(...)`).
    // `result.messages` is a plain `[...opts.messages, ...newMessages]` spread,
    // so an engine response message that overlaps the input-history prefix (by
    // id or JSON identity) would double-write into the transcript. Dedup the
    // turn's new messages against the input prefix to match legacy semantics.
    // `result.newMessages` are already mcp-tool-origin stamped, so the origin
    // metadata is preserved.
    const history: ModelMessage[] = [...args.messages];
    appendDedupedModelMessages(history, result.newMessages);

    return {
      history,
      turnTrace: result.turnTrace,
      modelSource: rt.modelSource,
    };
  }

  // Hosted engines (JAM-paid `/stream`, cloud org-BYOK `/stream/org`). The
  // endpoint + extra body fields + harness selector ride `rt.runtime`.
  const result = await runUnifiedAssistantTurn({
    runtime: rt.runtime,
    streamSink: "none",
    persistMode: "caller",
    ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
    messages: args.messages,
    modelDefinition,
    systemPrompt: args.systemPrompt,
    ...(args.temperature !== undefined
      ? { temperature: args.temperature }
      : {}),
    tools: args.tools as ToolSet,
    mcpClientManager: args.mcpClientManager,
    authContext: { kind: "user_bearer", token: args.authHeader ?? "" },
    sourceType,
    origin: "scenario",
    // Synthetic runs have no human-in-the-loop. Auto-deny approval-required
    // tool calls inside the loop so the run makes forward progress.
    approvalMode: "auto-deny",
    chatSessionId: args.chatSessionId,
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.scenarioId ? { scenarioId: args.scenarioId } : {}),
    ...(args.accessVersion !== undefined
      ? { accessVersion: args.accessVersion }
      : {}),
    ...(args.selectedServers
      ? { selectedServerIds: args.selectedServers }
      : {}),
    // Harness MCP-proxy plane — REQUIRED by runHarnessTurn when a harness host
    // has MCP servers selected (it throws otherwise). Threaded here so a swarm/
    // scenario-sim harness turn reaches its MCP servers just like live chat.
    ...(harnessMcpProxy ? { harnessMcpProxy } : {}),
    // Swarm continuity identity → the harness `swarm-chat` owner lane. Both are
    // set only on the swarm surface; the harness owner mapping needs them to
    // key on (journeyRunId, hostId, chatSessionId) instead of direct-chat.
    ...(journeyRunId ? { journeyRunId } : {}),
    ...(hostId ? { hostId } : {}),
    // Pinned harness skills (env-based swarm target): presence — even an
    // EMPTY array — makes the harness turn skip the live skills fetch.
    ...(pinnedHarnessSkills !== undefined ? { pinnedHarnessSkills } : {}),
    // Ephemeral harness box (B-isolation phase 6) — present ⇒ the harness turn
    // runs on it instead of reserving the acting member's personal computer.
    ...(harnessSandboxBinding ? { harnessSandboxBinding } : {}),
    // The turn's Project Environment — the grant boundary the harness path
    // checks a BROKERED external-account credential against. Inert for the
    // emulated engine, which resolves no such credential.
    ...(environmentId ? { environmentId } : {}),
    // Server-executed built-ins for the harness path (see the drain's option).
    ...(harnessBuiltInTools ? { builtInTools: harnessBuiltInTools } : {}),
    ...(args.requireToolApproval !== undefined
      ? { requireToolApproval: args.requireToolApproval }
      : {}),
    ...(args.modelVisibleMcpToolResults !== undefined
      ? { modelVisibleMcpToolResults: args.modelVisibleMcpToolResults }
      : {}),
    ...(args.progressivePlan ? { progressivePlan: args.progressivePlan } : {}),
    ...(args.discoveryState ? { discoveryState: args.discoveryState } : {}),
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
    ...(hooks?.onToolCall ? { onToolCall: hooks.onToolCall } : {}),
    ...(hooks?.onToolResult ? { onToolResult: hooks.onToolResult } : {}),
    ...(hooks?.onLiveTextDelta
      ? { onLiveTextDelta: hooks.onLiveTextDelta }
      : {}),
    ...(hooks?.onStepFinish ? { onStepFinish: hooks.onStepFinish } : {}),
    ...(hooks?.prepareAdvertisedTools
      ? { prepareAdvertisedTools: hooks.prepareAdvertisedTools }
      : {}),
    onEngineError: captureEngineError,
  });

  // Share evals' failure policy: a hosted engine can return a trace after
  // a rejected request, or after a later model step failed. Neither is a
  // successful reply for the persona to react to.
  const turnFailure = getHostedTurnFailure({
    turnTrace: result.turnTrace,
    newMessageCount: result.newMessages.length,
  });
  if (turnFailure && !args.abortSignal?.aborted) {
    const failed = (message: string) => {
      const error = new RecordedAssistantTurnError(message, {
        history: result.messages,
        turnTrace: result.turnTrace,
        modelSource: rt.modelSource,
        ...(result.harnessSessionCommit
          ? { harnessSessionCommit: result.harnessSessionCommit }
          : {}),
      });
      // Keep classification even mid-turn, but retry only when no evidence was produced.
      error.errorRefusal = lastEngineError
        ? {
            code: lastEngineError.code,
            refusalReason: lastEngineError.refusalReason,
            retryAfterMs: lastEngineError.retryAfterMs,
            httpStatus: lastEngineError.httpStatus,
            stepIndex: lastEngineError.stepIndex,
            outstandingHolds: lastEngineError.outstandingHolds,
          }
        : undefined;
      if (result.newMessages.length === 0) error.refusal = error.errorRefusal;
      return error;
    };
    if (lastEngineError) {
      const detail = [
        lastEngineError.code,
        lastEngineError.httpStatus !== undefined
          ? `HTTP ${lastEngineError.httpStatus}`
          : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      throw failed(
        detail
          ? `${lastEngineError.message} (${detail})`
          : lastEngineError.message,
      );
    }
    throw failed(turnFailure);
  }

  await rt.finalizeUsage(result); // no-op for hosted engines
  return {
    history: result.messages,
    turnTrace: result.turnTrace,
    modelSource: rt.modelSource,
    // Surfaced from the harness turn (undefined for the emulated engine) so the
    // caller can ride it into its transcript persist.
    ...(result.harnessSessionCommit
      ? { harnessSessionCommit: result.harnessSessionCommit }
      : {}),
  };
}

function extractAssistantText(history: ModelMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (!msg || msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const text = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: string }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("");
    return text;
  }
  return "";
}
