import { type ModelMessage } from "ai";
import {
  extractToolCallsExcludingPolicyBlocks,
  extractToolCallsFromConversation,
  mergeToolCalls,
} from "../../shared/eval-tool-call-projection";
import {
  evaluateMultiTurnResults,
  type EvaluationResult,
  type MultiTurnEvaluationResult,
  type UsageTotals,
} from "./evals/types";
import { buildEvalIterationVerdict } from "./evals/iteration-verdict";
import { browserApprovalDeliveryFor } from "./evals/browser-tool-policy.js";
import { needsEphemeralEvalSandbox } from "./evals/needs-ephemeral-sandbox";
import { createStepExecutionState, executeSteps } from "./evals/step-executor";
import {
  buildLocalStepHandlers,
  buildHostedStepHandlers,
} from "./evals/step-handlers";
import { buildHostedEvalSinks } from "./evals/hosted-eval-sinks";
import {
  buildStepResultRecords,
  buildStepScriptedCheckFailures,
  resolveTurnCheckResultsFromStepExecution,
} from "./evals/step-verdict-adapters";

import {
  applyVisibilityPolicyAndCountSignals,
  type HostExecutionPolicy,
  type ModelVisibleMcpToolResults,
  type ToolExposureSignals,
} from "@mcpjam/sdk/host-config/internal";
import { harnessOfHostConfig } from "./evals/harness-admission.js";
import {
  readTasksPolicy,
  type MCPClientManager,
  type ToolTaskSeamOptions,
} from "@mcpjam/sdk";
import { resolveToolTaskSeam } from "../utils/task-seam.js";
import { mcpToolOptionsFor } from "../utils/mcp-tool-options.js";
import {
  createLlmModel,
  type BaseUrls,
  type CustomProviderConfig,
} from "../utils/chat-helpers";
import { resolveExecutionContext } from "../utils/host-execution-context";
import { resolveHostTools } from "../utils/built-in-tools/registry.js";
import { resolveWebAuthorizedHarnessStrategy } from "../utils/harness/harness-proxy-strategy.js";
import {
  buildEvalBashTool,
  EVAL_BASH_TOOL_NAME,
} from "../utils/built-in-tools/sandbox-bash.js";
import {
  isComputersDataPlaneConfigured,
  provisionEvalSandbox,
  releaseEvalSandbox,
} from "../utils/computers/control-plane-client.js";
import { seedEvalCaseAttachments } from "../utils/computers/eval-attachments-seed.js";
import { logger } from "../utils/logger";
import { captureMcpAppWidgetSnapshots } from "../utils/mcp-app-widget-capture";
import {
  buildLlmRuntimeConfigFromOrgConfig,
  deriveOrgProviderKey,
  isLocalRuntimeEligible,
  resolveOrgProviderRuntimeForTarget,
  type ResolveOrgModelConfigTarget,
  type ResolvedOrgModelConfig,
} from "../utils/org-model-config";
import {
  getCanonicalModelId,
  getModelById,
  type ModelDefinition,
  type ModelProvider,
} from "@/shared/types";
import { isHostedCatalogModel } from "./hosted-model-catalog.js";
import {
  hasSkillTools,
  mergeToolCallsByPromptIndex,
  summarizeRenderObservations,
  widgetToolCallsByPromptIndex,
  SKILL_TOOL_NAMES,
  resolveMatchOptions,
  type PredicateResult,
  type ToolErrorRecord,
} from "@/shared/eval-matching";
import {
  META_TOOL_NAMES,
  resolveActiveToolNames,
  type ProgressiveToolPlan,
  type ToolDiscoveryState,
} from "@/shared/progressive-tool-discovery";
import type { PinnableSkill, PinnedSkillArtifact } from "@/shared/skill-types";
import type { ConvexHttpClient } from "convex/browser";
import { ErrorCode, WebRouteError } from "../routes/web/errors";
import {
  createSuiteRunRecorder,
  type SuiteRunRecorder,
} from "./evals/recorder";
import { finalizeAiSdkTraceOnFailure } from "./evals/eval-trace-capture";
import type {
  EvalTraceBlobV1,
  EvalTraceSpan,
  PromptTraceSummary,
  RunnerWidgetRenderObservation,
} from "@/shared/eval-trace";
import {
  deriveLegacyPromptFields,
  isPinnedOnly,
  isPinnedTurn,
  turnsNeedModel,
  resolvePromptTurns,
  resolvePromptTurnsWithLegacyProbe,
  stripPromptTurnsFromAdvancedConfig,
  type PinnedToolCall,
  type PromptTurn,
} from "@/shared/steps";
import {
  normalizeSteps,
  promptTurnsToSteps,
  stepsToPromptTurns,
  type TestStep,
} from "@/shared/steps";
import { withHostContextSystemPrompt } from "@/shared/host-context-prompt";
import { normalizeToolChoice, type EvalToolChoice } from "@/shared/tool-choice";
import {
  prepareChatV2,
  type PrepareChatV2Result,
} from "../utils/chat-v2-orchestration.js";
import type {
  LocalEvalTurnAcc,
  LocalEvalTurnSinks,
} from "./evals/drive-local-eval-turn.js";
import { sanitizeForConvexTransport } from "./evals/convex-sanitize.js";
import { emitPinnedTurnSse } from "./evals/pinned-turn-sse.js";
import { type PinnedTurnSsePayload } from "./evals/pinned-turn-sse.js";
import {
  buildIterationFinishParams,
  buildStageMetadata,
} from "./evals/finalize-iteration.js";
import type { GradingEngineMode } from "./evals/grading-mode.js";
import type {
  StageAuthoredCase,
  StageSetupSignals,
  EvalSuiteFileToolPolicy,
} from "@mcpjam/sdk/contract";
import {
  buildHarnessToolPolicySnapshots,
  benchmarkEnforcementPolicy,
  createToolPolicyGate,
  toolAnnotationsKey,
  UnmatchedToolPolicyNameError,
  validateToolPolicyNames,
  type ToolAnnotationsLookup,
  type ToolPolicyGate,
  type SideEffectGate,
} from "./evals/tool-policy-gate.js";
import type { BenchmarkWriteGuard } from "./evals/artifact-ledger.js";
import { buildStageAuthoredCase } from "./evals/stage-inputs.js";
import { resolveEvalCaseModelDefinition } from "./evals/harness-admission.js";
import {
  createRunSetupObserver,
  type RunSetupObserver,
  type SetupPhase,
} from "./evals/run-setup-signals.js";
import {
  dispatchEvalIterationFinalize,
  finalizeWithBrowserArtifacts,
  type EvalIterationFinishParams,
} from "./browser-artifact-finalize.js";
import {
  createBrowserSessionContext,
  type BrowserSessionContext,
} from "./browser-session-context.js";
import type {
  EvalStreamEvent,
  EvalStreamToolCall,
} from "@/shared/eval-stream-events";

/**
 * Max render-check (`widget_probe`) cases that may execute at once. Each one
 * launches a headless Chromium (~hundreds of MB), so a monitoring suite full
 * of render checks would otherwise spawn one browser PER case in parallel and
 * exhaust the worker's memory. LLM-only cases are network-bound and run
 * unbounded. Override with MCPJAM_MAX_CONCURRENT_RENDER_CHECKS.
 */
const MAX_CONCURRENT_RENDER_CHECKS = (() => {
  const raw = Number(process.env.MCPJAM_MAX_CONCURRENT_RENDER_CHECKS);
  return Number.isInteger(raw) && raw >= 1 ? raw : 4;
})();

/**
 * Narrow the run-level benchmark write guard to ONE case's iteration.
 *
 * The prefix an artifact must carry is per-ITERATION, so a list-style case
 * cannot observe its own sibling iterations' artifacts and grade a leak that is
 * ours. The ledger is deliberately NOT narrowed: it belongs to the run, because
 * the cleanup that reads it does.
 *
 * A case with no id cannot be matched to a manifest at all, which under
 * `requireManifest` is refused rather than run — an unidentifiable write case
 * is exactly the one whose blast radius nobody can state.
 */
function resolveSideEffectGate(
  guard: BenchmarkWriteGuard,
  caseId: string | undefined,
  iteration: number,
): SideEffectGate {
  return {
    sideEffects: caseId ? guard.sideEffectsByCaseId[caseId] : undefined,
    benchmarkRunId: guard.benchmarkRunId,
    ...(caseId ? { caseId } : {}),
    iteration,
    ledger: guard.ledger,
    requireManifest: guard.requireManifest === true,
  };
}

/**
 * The execution-layer gate for one iteration, or `null` when nothing restrains
 * it.
 *
 * ── A WRITE GUARD FORCES A GATE ON ITS OWN ────────────────────────────────
 *
 * `toolPolicy` is SUITE-authored; `benchmarkWriteGuard` comes from the
 * benchmark claim. They are unrelated fields, and a benchmark write cell
 * normally arrives with the second and not the first — nothing in the claim
 * supplies a `toolPolicy`. Building the gate as `toolPolicy ? … : null`
 * therefore left benchmark write cells with NO gate: no allowed-tool check, no
 * argument or prefix validation, no mutation-target check, and no id
 * harvesting, which also meant nothing to clean up afterwards. The entire
 * write-safety story was switched off by the absence of an unrelated optional
 * field.
 *
 * Extracted and exported so that stays true: this is the one decision that
 * says whether anything at all bounds what a benchmark case writes to somebody
 * else's server, and it is worth being able to assert on directly.
 */
export function resolveEnforcementGate(args: {
  toolPolicy?: EvalSuiteFileToolPolicy;
  benchmarkWriteGuard?: BenchmarkWriteGuard;
  testCaseId?: string;
  runIndex: number;
  annotations: ToolAnnotationsLookup;
  warnings?: ReadonlyArray<string>;
}): ToolPolicyGate | null {
  const sideEffectGate = args.benchmarkWriteGuard
    ? resolveSideEffectGate(
        args.benchmarkWriteGuard,
        args.testCaseId,
        args.runIndex,
      )
    : undefined;
  // The suite's own policy wins when it has one — an author who wrote
  // `readOnly` meant it, and the manifest is an additional bound rather than a
  // replacement. With no suite policy, the guard supplies the baseline.
  const policy =
    args.toolPolicy ??
    (sideEffectGate ? benchmarkEnforcementPolicy(sideEffectGate) : undefined);
  if (!policy) return null;
  return createToolPolicyGate({
    policy,
    annotations: args.annotations,
    ...(args.warnings ? { warnings: args.warnings } : {}),
    ...(sideEffectGate ? { sideEffectGate } : {}),
  });
}

/**
 * Minimal async concurrency limiter: returns a function that runs at most
 * `max` thunks concurrently and queues the rest. A slot is released when its
 * thunk SETTLES (resolve or reject), so a slot can never leak even if the work
 * throws — unlike tying the cap to a browser's dispose() call.
 */
export function createConcurrencyLimiter(max: number) {
  const limit = Math.max(1, max);
  let active = 0;
  const queue: Array<() => void> = [];
  const pump = () => {
    while (active < limit && queue.length > 0) {
      active++;
      queue.shift()!();
    }
  };
  return <T>(thunk: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = async () => {
        try {
          resolve(await thunk());
        } catch (err) {
          reject(err);
        } finally {
          active--;
          pump();
        }
      };
      queue.push(run);
      pump();
    });
}

export type EvalTestCase = {
  title: string;
  query: string;
  runs: number;
  /** V2 case override; absent means the suite default. */
  repetitions?: number;
  /** V2 case threshold fraction; absent means the suite default. */
  passThreshold?: number;
  model: string;
  provider: string;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>;
  isNegativeTest?: boolean; // When true, test passes if NO tools are called
  expectedOutput?: string;
  /** Authored analytics grouping label, frozen into each iteration snapshot. */
  intent?: string;
  promptTurns?: PromptTurn[];
  /**
   * Unified `TestStep[]` model (Phase 3). When present this is the source of
   * truth for execution and the single sequential step executor runs it
   * directly. `promptTurns`/`caseType`/`probeConfig` are the legacy fallback
   * the runner converts via `resolveSteps` until the backend emits `steps`.
   */
  steps?: TestStep[];
  advancedConfig?: {
    system?: string;
    temperature?: number;
    toolChoice?: EvalToolChoice | string;
  } & Record<string, unknown>;
  /**
   * Effective per-iteration match options. Suite-level runs receive this
   * pre-resolved from Convex `precreateIterationsForRun`; single-case
   * runs resolve it in the route handler.
   */
  matchOptions?: import("@/shared/eval-matching").MatchOptionsDTO;
  /**
   * Optional state-based predicate gate evaluated over the iteration
   * transcript after tool-call matching. Definitions are runtime/corpus data
   * in V1 (carried on the case object through the runner, like `matchOptions`);
   * verdicts are persisted to `testIteration.metadata.predicates`. A case
   * passes the predicate gate iff every predicate passes; an absent/empty list
   * is no gate. See `shared/predicates`.
   */
  successPredicates?: import("@/shared/eval-matching").Predicate[];
  /**
   * Per-Run override layered on top of the suite's hostConfig. Carries
   * the editor's in-place tweaks (locale, timezone, hostContext,
   * hostCapabilitiesOverride, hostStyle, etc.) for this iteration only.
   * NOT a property of the test case — present on this type only because
   * it rides alongside the case through the runner, the same way
   * `matchOptions` does. Stamped onto `testCaseSnapshot.hostConfigOverride`
   * for the iteration row. Single-case runs populate it from the
   * request; suite runs leave it undefined.
   */
  hostConfigOverride?: Record<string, unknown>;
  testCaseId?: string;
  /**
   * Case kind. Absent ⇒ prompt case. `widget_probe` carries `probeConfig`
   * and skips the LLM path entirely (`runTestCase` forks before any model
   * resolution); `model`/`provider` hold display-only sentinels on probe
   * entries and are never resolved.
   */
  caseType?: import("@/shared/probe-config").TestCaseType;
  /** Pinned tool call for `widget_probe` cases. */
  probeConfig?: import("@/shared/probe-config").ProbeConfig;
};

/**
 * How a run delivers its PINNED skills to the model (INS-5).
 *
 * Both variants are frozen snapshot content and both bypass approval — an eval
 * run is auto-deny, and these are pure reads of content that cannot change
 * mid-run. They differ only in the tool SURFACE, and which one a run needs is a
 * property of what it pinned:
 *
 *  - `pinned` — bare-name tools over SKILL.md bodies. Every eval run that
 *    predates plugins, unchanged: same tool names, same prompt stanza, and no
 *    supporting-file tools advertised for files that cannot exist.
 *  - `pinned-effective` — INS-3's ref-addressed surface, for a run whose pins
 *    carry a plugin `modelRef` (two plugins may declare the same skill name, so
 *    a bare name cannot identify one) or supporting FILES (the bare-name
 *    surface has no tool to read them with).
 *
 * Decided ONCE, at the boundary that read the run's pins, so no iteration can
 * disagree with another about the surface the suite was measured on.
 */
export type EvalPinnedSkillSource =
  | { kind: "pinned"; skills: PinnableSkill[] }
  | {
      kind: "pinned-effective";
      capabilities: import("./environments/effective-capabilities.js").EffectiveCapabilitySet;
    };

/**
 * How a run's FROZEN skills reach one case — both channels, together.
 *
 * There are two, and they are not interchangeable:
 *   - `pinnedSkillSource` feeds the EMULATED path, where skills become
 *     in-memory tool definitions.
 *   - `pinnedHarnessSkills` feeds the HARNESS path, where they are materialized
 *     as SKILL.md files on the box.
 *
 * They are bundled here because forwarding one without the other is a silent
 * failure rather than a loud one: a case that receives no `pinnedHarnessSkills`
 * does not error, it falls through to the harness's LIVE project-wide fetch —
 * so a frozen run quietly stops being frozen, and the
 * `skillsOverride: "exclude"` arm quietly runs with the whole project pool.
 * That is exactly the bug this helper exists to make structurally impossible:
 * one place decides, and both channels leave together or not at all.
 *
 * `pinnedHarnessSkills` is included when DEFINED rather than truthy — `[]` is
 * the "this run delivers no skills" answer and must survive.
 */
export function runFrozenSkillOptions(run: {
  pinnedSkillSource?: EvalPinnedSkillSource;
  pinnedHarnessSkills?: PinnedSkillArtifact[];
}): {
  pinnedSkillSource?: EvalPinnedSkillSource;
  pinnedHarnessSkills?: PinnedSkillArtifact[];
} {
  // Presence selects the pinned source at every hop below, so a non-array that
  // is not `undefined` would sail through all of them and only fail inside
  // `pinnedArtifactsToRuntimeSkills`'s `.map` — deep in the harness turn, after
  // a sandbox has been provisioned and paid for. The type forbids it, but the
  // value crosses a route boundary and a persisted-data conversion on the way
  // here, so it is worth one loud check at the seam rather than a confusing
  // crash later. `undefined` stays legal: it means "this run pinned nothing".
  if (
    run.pinnedHarnessSkills !== undefined &&
    !Array.isArray(run.pinnedHarnessSkills)
  ) {
    throw new Error(
      `runFrozenSkillOptions: pinnedHarnessSkills must be an array or undefined (got ${
        run.pinnedHarnessSkills === null
          ? "null"
          : typeof run.pinnedHarnessSkills
      })`,
    );
  }
  return {
    ...(run.pinnedSkillSource
      ? { pinnedSkillSource: run.pinnedSkillSource }
      : {}),
    ...(run.pinnedHarnessSkills !== undefined
      ? { pinnedHarnessSkills: run.pinnedHarnessSkills }
      : {}),
  };
}

/**
 * Which skills source an ITERATION hands `prepareChatV2` — the second half of
 * the two-channel decision `runFrozenSkillOptions` bundles.
 *
 * Eval runs never use local-FS skills (decision 10), so the answer is always
 * explicit. The part that is not obvious: a HARNESS iteration takes
 * `{ kind: "none" }` EVEN WHEN THE RUN HAS PINS. Its pins are already travelling
 * on the other channel (`pinnedHarnessSkills` → SKILL.md on the box), and
 * `prepareChatV2` THROWS on harness+pinned because delivering both would hand
 * the model the same skill twice by two mechanisms — an in-memory `loadSkill`
 * tool AND an on-box copy.
 *
 * This is a seam guard, in the same spirit as `runFrozenSkillOptions` and for a
 * bug of the same family. #4146 wired a run's pins into `pinnedSkillSource`
 * without teaching the two iteration paths that a harness must not receive
 * them, so every harness run whose environment carried a skill died at
 * `prepareChatV2` with `tokensUsed: 0` — while runs with no skills stayed green,
 * which is why it shipped. Both call sites now ask this one function, so the
 * two paths cannot drift apart again.
 */
export function resolveIterationSkillsSource(args: {
  harness?: string | undefined;
  pinnedSkillSource?: EvalPinnedSkillSource;
}): EvalPinnedSkillSource | { kind: "none" } {
  if (args.harness) return { kind: "none" };
  return args.pinnedSkillSource ?? { kind: "none" };
}

/**
 * The match options the `toolCalls:match` score definition hashes over.
 *
 * RESOLVED, not authored. The matcher applies `MATCH_OPTIONS_DEFAULTS` to
 * whatever the case declared, so hashing the sparse authored object would give
 * two cases that grade identically two different `implementationHash`es — and
 * would leave a case that declares nothing hashing `{}` while actually being
 * graded order-agnostic with partial argument matching. The digest is supposed
 * to answer "would this scorer decide differently?", and only the resolved
 * options can answer that.
 */
/**
 * The resolved match options to hash into the `toolCalls:match` definition.
 *
 * MUST STAY IN LOCKSTEP with what the matcher is actually handed. Today both
 * this and `evaluateMultiTurnResults` resolve as
 * `resolveMatchOptions(undefined, test.matchOptions)` at the same call sites,
 * so the digest honestly describes the options the verdict was produced under.
 *
 * If a future path starts threading suite-level `defaultMatchOptions` into the
 * matcher without threading them here, the two silently diverge: the scorer's
 * `implementationHash` would describe options the matcher never applied, and
 * the second pass would rebuild the definition under a hash the first pass
 * never wrote. Change both, or neither.
 */
function scoreMatchOptionsFor(
  test: Pick<EvalTestCase, "matchOptions">,
): Record<string, unknown> {
  return resolveMatchOptions(undefined, test.matchOptions) as unknown as Record<
    string,
    unknown
  >;
}

export type RunEvalSuiteOptions = {
  suiteId: string;
  runId: string | null; // null for quick runs
  /**
   * The run's FROZEN grading-engine position, read from
   * `configSnapshot.gradingEngine` at run start and threaded to every
   * iteration's finalization.
   *
   * ABSENT ⇒ each finalization falls back to the env kill switch alone, which
   * is `off` unless an operator set it — the pre-B3b behaviour. Threading it
   * is what makes a per-suite `off` real on the FIRST pass (it was previously
   * honoured only by the judge second pass, which reads the run row) and what
   * lets a run reach `enforce` at all.
   */
  gradingMode?: GradingEngineMode;
  config: {
    tests: EvalTestCase[];
    environment: {
      /**
       * Legacy display/compat refs. These may be friendly names, not
       * connected server identities; preserve serverBindings with any
       * snapshotted environment before resolving tools for execution.
       */
      servers: string[];
      serverBindings?: Array<{
        serverName: string;
        projectServerId?: string;
      }>;
    };
  };
  /**
   * The PROJECT ENVIRONMENT this run launched from — a `projectEnvironments`
   * doc id. Deliberately NOT inside `config.environment`, which is the servers
   * snapshot, and deliberately not `computerEnvironmentId`, which is a sandbox
   * IMAGE; the three are unrelated despite the shared word.
   *
   * The GRANT BOUNDARY for the run's project secrets, and therefore what a
   * HARNESS iteration's BROKERED external-account credential check must be
   * scoped to. Absent for a legacy (non-environment) run, which grants none.
   */
  projectEnvironmentId?: string;
  /**
   * Why {@link projectEnvironmentId} is absent on a run that HAS an
   * environment. Set ONLY by the replay path: a replay run inherits the source
   * run's `configSnapshot.environmentRef` on the backend, so its boxes really
   * may carry a brokered transform, but no public read projects that ref back
   * out. Copy only — the harness refuses either way, and this just keeps the
   * refusal from blaming an environment selection the reader never made.
   */
  projectEnvironmentUnresolvedReason?: string;
  modelApiKeys?: Record<string, string>;
  orgModelConfig?: ResolvedOrgModelConfig;
  orgModelConfigTarget?: ResolveOrgModelConfigTarget;
  convexClient: ConvexHttpClient;
  convexHttpUrl: string;
  convexAuthToken: string;
  mcpClientManager: MCPClientManager;
  recorder?: SuiteRunRecorder | null;
  testCaseId?: string; // For quick runs, associate iterations with a specific test case
  compareRunId?: string; // For quick compare runs, group related iterations in metadata
  /**
   * The REWRITE-arm marker from `configSnapshot.toolDescriptionOverride`.
   * Applied to every tool-prep path; stamped onto iteration metadata after
   * prep so eligibility can read `metadata.descriptionExperiment.applied`.
   */
  toolDescriptionOverride?:
    ToolDescriptionOverrideMarker | Record<string, unknown>;
  /**
   * Resolved compat-runtime flag for the suite's host config. When
   * true, widget snapshots captured during this run will have the
   * OpenAI Apps SDK `window.openai` shim injected before they're
   * persisted. Default `false` — caller (route handler) resolves
   * from the suite's `mcpProfile.apps.compatRuntime` + `hostStyle`
   * preset. Absent/undefined preserves SEP-1865 honest behavior.
   */
  suiteInjectOpenAiCompat?: boolean;
  /**
   * Host execution policy extracted from the run's hostConfig snapshot.
   * When present, the runner applies visibility filtering, computes tool
   * exposure signals, and stamps scalar metadata on each iteration for the
   * cross-host dashboard.
   */
  hostExecutionPolicy?: HostExecutionPolicy;
  /**
   * Raw suite hostConfig record. PR 4d threads this through so per-iteration
   * runners can resolve CONFIG fields (`systemPrompt` / `temperature` /
   * `selectedServerIds`) via `resolveExecutionContext` — the runner used
   * to read `advancedConfig.system` only and ignore the suite default.
   */
  suiteHostConfig?: Record<string, unknown> | null;
  /**
   * The skill delivery this run's PINS resolved to, decided once at the
   * boundary (`prepareEvalRun`) and forwarded verbatim by every iteration
   * runner. Absent ⇒ the runners pass `skillsSource: none` (eval runs never use
   * local-FS skills — decision 10); quick-run stays absent (no run row = no
   * pinning carrier).
   *
   * A SOURCE rather than a skill list because INS-5 gave the pin store two
   * possible shapes, and which one a run needs is a property of what it pinned,
   * not a per-iteration choice — see {@link EvalPinnedSkillSource}.
   */
  pinnedSkillSource?: EvalPinnedSkillSource;
  /**
   * The run's frozen skills in HARNESS shape, materialized ON BOX.
   *
   * A separate channel from {@link RunEvalSuiteOptions.pinnedSkillSource}, and
   * deliberately so: `pinnedSkillSource` feeds the EMULATED path, where skills
   * become in-memory tool definitions; a harness turn writes SKILL.md files
   * into the runtime's skills root instead, so it needs complete artifacts
   * (identity, complete-envelope hash, preserved frontmatter, inline file
   * bodies) rather than the body-only projection that path takes.
   *
   * Presence, not length, is what selects the pinned source in the harness. An
   * empty list says "this run delivers no skills"; ABSENT falls through to a
   * live project-wide fetch, which would unfreeze the run. So the boundary sets
   * this for every runId-bearing run, empty included.
   */
  pinnedHarnessSkills?: PinnedSkillArtifact[];
  toolPolicy?: EvalSuiteFileToolPolicy;
  /**
   * Extra headers stamped on every per-step Convex request of this run.
   *
   * The bench worker's carrier for `x-mcpjam-benchmark-grant`. Forwarded to
   * BOTH backend iteration paths even though a benchmark cell only ever runs an
   * MCPJam-paid model (`/stream`): one option on one type is what keeps the two
   * paths from drifting into "the header is attached on one of them".
   *
   * Never copied on the way down — the caller may rotate a credential inside
   * the object between steps.
   */
  extraHeaders?: Record<string, string>;
  /**
   * The benchmark's write-manifest enforcement, when this run is a hosted
   * benchmark cell.
   *
   * Threaded rather than resolved here for the same reason the grant is: the
   * manifests are pinned in the definition and verified against the claim
   * before a cell launches, so the runner receives a decision it must not
   * re-make. The ledger inside travels by REFERENCE — every iteration writes
   * into the one the run's cleanup will read.
   */
  benchmarkWriteGuard?: BenchmarkWriteGuard;
};

/** One executed iteration inside a suite/quick run (evaluation + optional persisted iteration id). */
export type EvalIterationOutcome = {
  evaluation: EvaluationResult;
  iterationId?: string;
  policyBlockCount?: number;
};

/**
 * D7: narrow a turn's full tool registry down to the subset the model was
 * actually shown, when progressive discovery gated what it could see.
 *
 * `prepared.allTools` (and `selectionToolsForFinish`, captured from it) is
 * always the COMPLETE registry — prepareChatV2 builds it before any step
 * runs. When progressive discovery is enabled, `prepareStep` narrows each
 * step's advertised set to `resolveActiveToolNames(plan, discoveryState)`
 * and only ever adds to `discoveryState.loadedToolIds` (never removes), so
 * by the time a turn finishes, `resolveActiveToolNames` recomputed against
 * that SAME (mutated-in-place) state object gives the full set of names the
 * model was shown across every step of the turn. Passing the unnarrowed
 * registry to D7's selection-tool-catalog would let it see — and blame —
 * metadata for a tool the model never had a chance to read.
 *
 * A no-op (returns `allTools` unchanged) when progressive discovery wasn't
 * enabled for this turn, matching `resolveActiveToolNames`'s own non-plan
 * behavior of exposing everything.
 */
export function narrowToolsToAdvertised(
  allTools: PrepareChatV2Result["allTools"],
  progressivePlan: ProgressiveToolPlan,
  discoveryState: ToolDiscoveryState,
): PrepareChatV2Result["allTools"] {
  if (!progressivePlan.enabled) {
    return allTools;
  }
  const advertisedNames = new Set(
    resolveActiveToolNames(progressivePlan, discoveryState),
  );
  const narrowed: PrepareChatV2Result["allTools"] = {};
  for (const [name, tool] of Object.entries(allTools)) {
    if (advertisedNames.has(name)) {
      narrowed[name] = tool;
    }
  }
  return narrowed;
}

/**
 * True when the provider/backend actually reported token usage. `accumulatedUsage`
 * is initialized to a zero object, so a zero total is indistinguishable from
 * "unmetered" — passing that into the transcript would let `tokenBudgetUnder`
 * pass on runs with no usage data. Only forward usage when something was
 * reported so the predicate can fail closed otherwise.
 */
function hasReportedUsage(usage: UsageTotals): boolean {
  return (
    (usage.totalTokens ?? 0) > 0 ||
    (usage.inputTokens ?? 0) > 0 ||
    (usage.outputTokens ?? 0) > 0
  );
}

export type RunEvalSuiteWithAiSdkResult = {
  /** Only set when `runId === null` (quick run); one entry per (test × run index) in suite order. */
  quickRunIterationOutcomes?: EvalIterationOutcome[];
};

const MAX_STEPS = 20;

// ── Run-lifecycle guards ────────────────────────────────────────────────────
// A suite run must always terminate: a hung LLM call or browser render can
// otherwise leave the run "running" forever (and hold a headless Chromium).
// These bound it — a 20-min whole-run cap, a 10-min per-iteration cap, periodic
// liveness heartbeats, and a cancellation poll — all surfacing through one
// `EvalRunStoppedError` that aborts in-flight work and finalizes the run.
const EVAL_RUN_TIMEOUT_MS = 20 * 60 * 1000;
export const EVAL_ITERATION_TIMEOUT_MS = 10 * 60 * 1000;
const EVAL_CANCEL_POLL_MS = 10 * 1000;
const EVAL_ABORT_GRACE_MS = 30 * 1000;
const EVAL_HEARTBEAT_MS = 15 * 1000;

type EvalRunStopReason = "user_cancelled" | "run_timeout" | "iteration_timeout";

class EvalRunStoppedError extends Error {
  readonly stopReason: EvalRunStopReason;
  readonly terminalStatus: "cancelled" | "timed_out";
  readonly notes: string;

  constructor(args: {
    stopReason: EvalRunStopReason;
    terminalStatus: "cancelled" | "timed_out";
    notes: string;
  }) {
    super(args.notes);
    this.name = "EvalRunStoppedError";
    this.stopReason = args.stopReason;
    this.terminalStatus = args.terminalStatus;
    this.notes = args.notes;
  }
}

const RUN_CANCELLED_ERROR = new EvalRunStoppedError({
  stopReason: "user_cancelled",
  terminalStatus: "cancelled",
  notes: "Run cancelled by user",
});

const RUN_TIMEOUT_ERROR = new EvalRunStoppedError({
  stopReason: "run_timeout",
  terminalStatus: "timed_out",
  notes: "Run timed out after 20 minutes",
});

const ITERATION_TIMEOUT_ERROR = new EvalRunStoppedError({
  stopReason: "iteration_timeout",
  terminalStatus: "timed_out",
  notes: "Run timed out because an iteration exceeded 10 minutes",
});

function isEvalRunStoppedError(error: unknown): error is EvalRunStoppedError {
  return error instanceof EvalRunStoppedError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ToolSet = Record<string, any>;

/**
 * The REWRITE-arm marker copied from `configSnapshot.toolDescriptionOverride`.
 * Presence means this run is the rewrite arm; the ORIGINAL arm has none.
 */
type ToolDescriptionOverrideMarker = {
  experimentId: string;
  toolName: string;
  description: string;
  proposalHash: string;
};

type DescriptionExperimentIterationStamp = {
  experimentId: string;
  arm: "rewrite" | "original";
  toolName: string;
  proposalHash: string;
  applied: boolean;
};

/**
 * Iteration metadata is `v.any()` on the backend. Widen past scalars so a
 * nested `descriptionExperiment` object can persist — E2 eligibility reads
 * `metadata.descriptionExperiment.applied === true` and a JSON-stringified
 * value would fail that check.
 */
type IterationMetadataValue =
  string | number | boolean | DescriptionExperimentIterationStamp;

type IterationMetadataBase = Record<string, IterationMetadataValue>;

function readToolDescriptionOverrideMarker(
  raw: unknown,
): ToolDescriptionOverrideMarker | undefined {
  if (raw === undefined || raw === null) return undefined;
  // A marker that is present but unreadable is refused, not ignored: an
  // ignored marker would run the whole rewrite arm on the ORIGINAL catalog,
  // spend its trial budget, and report every trial as `overrideNotApplied`.
  // That is fail-safe for the statistics and a silent full-arm spend for
  // the customer.
  if (typeof raw !== "object") {
    throw new Error(
      "configSnapshot.toolDescriptionOverride is present but not an object",
    );
  }
  const o = raw as Record<string, unknown>;
  if (
    typeof o.toolName !== "string" ||
    typeof o.description !== "string" ||
    typeof o.experimentId !== "string" ||
    typeof o.proposalHash !== "string"
  ) {
    throw new Error(
      "configSnapshot.toolDescriptionOverride is missing toolName, description, experimentId or proposalHash",
    );
  }
  return {
    toolName: o.toolName,
    description: o.description,
    experimentId: o.experimentId,
    proposalHash: o.proposalHash,
  };
}

function descriptionOverridesFromMarker(
  marker: ToolDescriptionOverrideMarker | undefined,
): Record<string, string> | undefined {
  if (!marker) return undefined;
  return { [marker.toolName]: marker.description };
}

function applyDescriptionOverridesToToolSet(
  tools: ToolSet,
  overrides: Record<string, string> | undefined,
): number {
  if (!overrides) return 0;
  let applied = 0;
  for (const [name, description] of Object.entries(overrides)) {
    const tool = tools[name];
    if (tool && typeof tool === "object") {
      (tool as { description?: string }).description = description;
      applied += 1;
    }
  }
  return applied;
}

function descriptionExperimentStamp(
  override: ToolDescriptionOverrideMarker,
  applied: boolean,
): DescriptionExperimentIterationStamp {
  return {
    experimentId: override.experimentId,
    arm: "rewrite",
    toolName: override.toolName,
    proposalHash: override.proposalHash,
    applied,
  };
}

/**
 * Stamp the rewrite-arm facts on an iteration's metadata base: the structured
 * stamp the report reads, and `tools_description_overridden`, the exposure
 * count `buildHostIterationMetadata` would emit if a host policy were present.
 * Written here so it exists whether or not the run has a host policy — the
 * verify recipe reads it beside `applied`.
 */
function stampDescriptionExperiment(
  base: IterationMetadataBase,
  override: ToolDescriptionOverrideMarker,
  applied: boolean,
): void {
  base.descriptionExperiment = descriptionExperimentStamp(override, applied);
  if (applied) {
    base.tools_description_overridden = 1;
  }
}

function descriptionAppliedOnPreparedTools(
  allTools: PrepareChatV2Result["allTools"] | undefined,
  override: ToolDescriptionOverrideMarker,
): boolean {
  const prepared = allTools?.[override.toolName];
  return (
    prepared != null &&
    typeof prepared === "object" &&
    "description" in prepared &&
    (prepared as { description?: unknown }).description === override.description
  );
}

function throwIfDescriptionOverrideOnHarness(
  override: ToolDescriptionOverrideMarker | undefined,
  harness: string | undefined,
): void {
  if (!override || !harness) return;
  throw new WebRouteError(
    400,
    ErrorCode.VALIDATION_ERROR,
    "Description overrides are only supported on the emulated engine.",
    { reason: "DESCRIPTION_OVERRIDE_ENGINE_UNSUPPORTED" },
  );
}

type ToolCall = {
  toolName: string;
  arguments: Record<string, any>;
  /**
   * The provider's id for this call, when the source part carried one.
   *
   * Declared here rather than smuggled in behind a cast: this value is BOTH
   * read locally (`extractToolCallsExcludingPolicyBlocks` matches blocked
   * calls by it) and persisted (`updateTestIteration.actualToolCalls`), and
   * the casts that used to hide it are how it reached a Convex validator that
   * had never been told about it — an unknown field there is a hard
   * ArgumentValidationError, so every tool-calling iteration failed to
   * finalize. Keeping it on the type is what makes the persistence boundary
   * type-checked again.
   */
  toolCallId?: string;
};
type TraceSnapshotKind = "step_finish" | "turn_finish" | "failure";

function getServerLabelForEvalError(
  serverId: string,
  environment: RunEvalSuiteOptions["config"]["environment"] | undefined,
): string {
  const binding = environment?.serverBindings?.find(
    (entry) =>
      entry.projectServerId === serverId ||
      entry.projectServerId?.toLowerCase() === serverId.toLowerCase(),
  );
  return binding?.serverName || serverId;
}

function isMissingRuntimeServerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /unknown mcp server/i.test(message) ||
    /not connected/i.test(message) ||
    /server .* is not connected/i.test(message)
  );
}

class EvalSetupPhaseError extends WebRouteError {
  readonly serverId: string;
  readonly phase: SetupPhase;

  constructor(args: {
    status: number;
    code: ErrorCode;
    message: string;
    serverId: string;
    phase: SetupPhase;
    details?: Record<string, unknown>;
  }) {
    super(args.status, args.code, args.message, {
      ...args.details,
      serverId: args.serverId,
      phase: args.phase,
    });
    this.name = "EvalSetupPhaseError";
    this.serverId = args.serverId;
    this.phase = args.phase;
  }
}

function throwSetupPhaseError(args: {
  serverId: string;
  phase: SetupPhase;
  error: unknown;
  environment: RunEvalSuiteOptions["config"]["environment"] | undefined;
}): never {
  const serverLabel = getServerLabelForEvalError(
    args.serverId,
    args.environment,
  );
  if (isMissingRuntimeServerError(args.error) || args.phase === "connection") {
    throw new EvalSetupPhaseError({
      status: 409,
      code: ErrorCode.SERVER_UNREACHABLE,
      message: `Could not start eval because "${serverLabel}" is not connected. Reconnect the server and try again.`,
      serverId: args.serverId,
      phase: args.phase,
      details: { serverId: args.serverId, serverName: serverLabel },
    });
  }
  const cause =
    args.error instanceof Error ? args.error.message : String(args.error);
  throw new EvalSetupPhaseError({
    status: 502,
    code: ErrorCode.SERVER_UNREACHABLE,
    message: `Could not start eval because "${serverLabel}" failed to list tools. Reconnect the server and try again.`,
    serverId: args.serverId,
    phase: args.phase,
    details: { serverId: args.serverId, serverName: serverLabel, cause },
  });
}

async function getEvalToolsForAiSdkOrThrow(args: {
  mcpClientManager: MCPClientManager;
  serverIds: string[];
  includeAppOnly: boolean;
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  /**
   * Resolved task seam, or absent for tasks-off. Eval is the one surface the
   * matrix resolves to `await`: nobody is watching a tab during a run, so a
   * handle for someone to follow later is the same as returning nothing.
   */
  tasks?: ToolTaskSeamOptions;
  environment: RunEvalSuiteOptions["config"]["environment"] | undefined;
  setupObserver?: RunSetupObserver;
  toolDescriptionOverrides?: Record<string, string>;
}): Promise<ToolSet> {
  // `undefined` ⇒ the no-options overload, keeping a default run byte-identical.
  // `needsApproval` is deliberately not an input here: an eval run is auto-deny
  // by construction, so the AI SDK approval flag has nothing to gate.
  const toolOptions = mcpToolOptionsFor({
    includeAppOnly: args.includeAppOnly,
    modelVisibleMcpToolResults: args.modelVisibleMcpToolResults,
    tasks: args.tasks,
    toolDescriptionOverrides: args.toolDescriptionOverrides,
  });

  const now = () => Date.now();
  const observer = args.setupObserver;
  const firstError: { error: unknown; serverId: string; phase: SetupPhase }[] =
    [];

  // ONE round trip per server. `getToolsForAiSdk` already ensures the
  // session before it lists, so probing connect separately would make every
  // lazily-connected run hit the customer's server twice for no new
  // information. `Promise.allSettled` does not abort in-flight siblings, so
  // this single barrier is what keeps folding race-free: every expected
  // target has settled before `buildSignals` runs, and a discovery failure
  // can never be folded while another server's connect is still open.
  const perServerTools = await Promise.allSettled(
    args.serverIds.map(async (serverId) => {
      const startedAt = now();
      const alreadyConnected =
        args.mcpClientManager.getConnectionStatus(serverId) === "connected";
      // One call cannot time the two phases apart. An already-connected
      // server spent the whole call listing; a lazily-connected one is
      // credited to connect, with the list window closing at the same
      // instant. Neither phase ever claims more than the call took.
      const splitAt = (endedAt: number) =>
        alreadyConnected ? startedAt : endedAt;
      try {
        const tools = toolOptions
          ? await args.mcpClientManager.getToolsForAiSdk(
              [serverId],
              toolOptions,
            )
          : await args.mcpClientManager.getToolsForAiSdk([serverId]);
        const endedAt = now();
        observer?.recordConnect(serverId, {
          outcome: "ok",
          startedAt,
          endedAt: splitAt(endedAt),
        });
        observer?.recordToolsList(serverId, {
          outcome: "ok",
          startedAt: splitAt(endedAt),
          endedAt,
        });
        return tools;
      } catch (error) {
        const endedAt = now();
        const connected =
          args.mcpClientManager.getConnectionStatus(serverId) === "connected";
        if (!connected || isMissingRuntimeServerError(error)) {
          // A connect miss: tools/list never ran for this server, so it
          // gets NO discovery observation. `foldPhase` reads that absence
          // as "the phase never executed" rather than as a failed list.
          observer?.recordConnect(serverId, {
            outcome: "failed",
            error,
            startedAt,
            endedAt,
          });
          firstError.push({ error, serverId, phase: "connection" });
          return null;
        }
        observer?.recordConnect(serverId, {
          outcome: "ok",
          startedAt,
          endedAt: splitAt(endedAt),
        });
        observer?.recordToolsList(serverId, {
          outcome: "failed",
          error,
          startedAt: splitAt(endedAt),
          endedAt,
        });
        firstError.push({ error, serverId, phase: "discovery" });
        return null;
      }
    }),
  );

  if (observer) {
    const signals = observer.buildSignals();
    if (signals?.connection?.attribution === "theirs") {
      await observer.ensureEgressCanary();
    }
  }

  if (firstError.length > 0) {
    // Connection failures dominate: a mixed bag must never earn
    // `connection: failed` from a later discovery throw.
    const connectFail = firstError.find((row) => row.phase === "connection");
    const chosen = connectFail ?? firstError[0]!;
    throwSetupPhaseError({
      serverId: chosen.serverId,
      phase: chosen.phase,
      error: chosen.error,
      environment: args.environment,
    });
  }

  const flattened: ToolSet = {};
  for (const result of perServerTools) {
    if (result.status === "fulfilled" && result.value) {
      Object.assign(flattened, result.value);
    }
  }
  return flattened;
}

export function resolveConfiguredServerIds(args: {
  environment: RunEvalSuiteOptions["config"]["environment"] | undefined;
  mcpClientManager: MCPClientManager;
}): string[] {
  const configuredServerRefs = args.environment?.servers ?? [];
  if (configuredServerRefs.length === 0) {
    return [];
  }

  const availableServerIds = args.mcpClientManager.listServers();
  if (availableServerIds.length === 0) {
    return configuredServerRefs;
  }

  const availableServerIdsSet = new Set(availableServerIds);
  const availableServerIdByLowercase = new Map(
    availableServerIds.map((serverId) => [serverId.toLowerCase(), serverId]),
  );
  const projectServerIdByName = new Map<string, string>();
  const serverNameByProjectServerId = new Map<string, string>();

  for (const binding of args.environment?.serverBindings ?? []) {
    if (typeof binding.serverName !== "string") {
      continue;
    }
    const serverName = binding.serverName.trim();
    const projectServerId =
      typeof binding.projectServerId === "string"
        ? binding.projectServerId.trim()
        : "";
    if (!serverName || !projectServerId) {
      continue;
    }
    projectServerIdByName.set(serverName.toLowerCase(), projectServerId);
    serverNameByProjectServerId.set(projectServerId.toLowerCase(), serverName);
  }

  const resolvedServerIds: string[] = [];
  const seen = new Set<string>();

  for (const serverRef of configuredServerRefs) {
    if (typeof serverRef !== "string") {
      continue;
    }
    const trimmedServerRef = serverRef.trim();
    if (!trimmedServerRef) {
      continue;
    }

    const normalizedServerId = availableServerIdsSet.has(trimmedServerRef)
      ? trimmedServerRef
      : (availableServerIdByLowercase.get(trimmedServerRef.toLowerCase()) ??
        (() => {
          const projectServerId = projectServerIdByName.get(
            trimmedServerRef.toLowerCase(),
          );
          if (projectServerId) {
            return (
              (availableServerIdsSet.has(projectServerId)
                ? projectServerId
                : undefined) ??
              availableServerIdByLowercase.get(projectServerId.toLowerCase())
            );
          }

          const serverName = serverNameByProjectServerId.get(
            trimmedServerRef.toLowerCase(),
          );
          if (serverName) {
            return (
              (availableServerIdsSet.has(serverName)
                ? serverName
                : undefined) ??
              availableServerIdByLowercase.get(serverName.toLowerCase())
            );
          }

          return undefined;
        })() ??
        trimmedServerRef);

    if (seen.has(normalizedServerId)) {
      continue;
    }
    seen.add(normalizedServerId);
    resolvedServerIds.push(normalizedServerId);
  }

  return resolvedServerIds;
}

type ResolvedEvalTestCase = {
  promptTurns: PromptTurn[];
  query: string;
  expectedToolCalls: ToolCall[];
  expectedOutput?: string;
  advancedConfig?: Record<string, unknown>;
};

function resolveEvalTestCase(test: EvalTestCase): ResolvedEvalTestCase {
  // Backend + route now emit `steps` (no promptTurns). The legacy per-turn
  // execution loops still consume `PromptTurn[]`, so bridge steps → turns here
  // (the single resolver every loop reads). Falls back to the legacy
  // promptTurns/probe path when a case carries no steps.
  const promptTurns =
    Array.isArray(test.steps) && test.steps.length > 0
      ? stepsToPromptTurns(normalizeSteps(test.steps))
      : resolvePromptTurns(test);
  const legacy = deriveLegacyPromptFields(promptTurns);
  return {
    promptTurns,
    query: legacy.query,
    expectedToolCalls: legacy.expectedToolCalls,
    expectedOutput: legacy.expectedOutput,
    advancedConfig: stripPromptTurnsFromAdvancedConfig(test.advancedConfig),
  };
}

/**
 * Resolve a test case into the unified `TestStep[]` the sequential step
 * executor consumes. Prefers an explicit `test.steps` (the forward contract,
 * once the backend emits it); otherwise converts the legacy `promptTurns`
 * (including a legacy `widget_probe`'s top-level `probeConfig`, surfaced as a
 * pinned turn) via `promptTurnsToSteps`. This is the single bridge from the
 * legacy per-turn model to `Step[]` on the server.
 */
export function resolveSteps(test: EvalTestCase): TestStep[] {
  if (Array.isArray(test.steps) && test.steps.length > 0) {
    return normalizeSteps(test.steps);
  }
  const turns = resolvePromptTurnsWithLegacyProbe(test);
  return promptTurnsToSteps(turns);
}

/**
 * Represent a legacy `widget_probe` row as a single model-free pinned turn so
 * the unified engine sees ONE shape (routing, server resolution, the iteration
 * loop). Post-migration rows already carry the pinned turn, so this is a no-op
 * for them. Idempotent.
 */
function normalizeTestForPinnedTurns(test: EvalTestCase): EvalTestCase {
  if (test.caseType !== "widget_probe" || !test.probeConfig) {
    return test;
  }
  // Shared with the editor's editForm seeding so the legacy-detection rule
  // lives in one place.
  const turns = resolvePromptTurnsWithLegacyProbe(test);
  return turns.some(isPinnedTurn) ? { ...test, promptTurns: turns } : test;
}

/**
 * Resolve a pinned turn's server reference (stable id first, display-name
 * fallback) to a connected manager key, through the same binding maps the LLM
 * path uses. `undefined` ⇒ not connected in this run (the iteration records a
 * not-connected failure instead of throwing the whole run away). Lifted from
 * the former `widget_probe` fork.
 */
function resolvePinnedServerKey(
  pinned: PinnedToolCall,
  environment: RunEvalSuiteOptions["config"]["environment"] | undefined,
  selectedServers: string[],
  mcpClientManager: MCPClientManager,
): string | undefined {
  const connected = new Set(selectedServers);
  const candidates = [pinned.serverId, pinned.serverName].filter(
    (ref): ref is string => !!ref,
  );
  for (const candidate of candidates) {
    const [resolved] = resolveConfiguredServerIds({
      environment: {
        servers: [candidate],
        serverBindings: environment?.serverBindings,
      },
      mcpClientManager,
    });
    if (resolved && connected.has(resolved)) {
      return resolved;
    }
  }
  return undefined;
}

function buildPromptTraceSummaries(
  evaluation: MultiTurnEvaluationResult,
  turnCheckResults: PredicateResult[] = [],
): PromptTraceSummary[] {
  return evaluation.promptSummaries.map((summary) => {
    const perTurn = turnCheckResults.filter(
      (r) =>
        r.scope?.kind === "turn" && r.scope.promptIndex === summary.promptIndex,
    );
    return {
      promptIndex: summary.promptIndex,
      prompt: summary.prompt,
      expectedToolCalls: summary.expectedToolCalls,
      actualToolCalls: summary.actualToolCalls,
      expectedOutput: summary.expectedOutput,
      passed: summary.passed,
      ...(perTurn.length ? { predicateResults: perTurn } : {}),
      missing: summary.missing,
      unexpected: summary.unexpected,
      argumentMismatches: summary.argumentMismatches.map((mismatch) => {
        const mismatchedArguments = new Set<string>([
          ...Object.keys(mismatch.expectedArgs ?? {}),
          ...Object.keys(mismatch.actualArgs ?? {}),
        ]);

        return {
          expected: {
            toolName: mismatch.toolName,
            arguments: mismatch.expectedArgs,
          },
          actual: {
            toolName: mismatch.toolName,
            arguments: mismatch.actualArgs,
          },
          mismatchedArguments: Array.from(mismatchedArguments).filter(
            (key) =>
              JSON.stringify(mismatch.expectedArgs?.[key]) !==
              JSON.stringify(mismatch.actualArgs?.[key]),
          ),
        };
      }),
    };
  });
}

function appendPartialToolCallsToPrompt(params: {
  toolsCalledByPrompt: ToolCall[][];
  promptIndex: number;
  partialResponseMessages: ModelMessage[];
}) {
  if (params.promptIndex < 0 || params.partialResponseMessages.length === 0) {
    return;
  }

  const partialToolCalls = extractToolCallsFromConversation({
    messages: params.partialResponseMessages,
  });
  if (partialToolCalls.length === 0) {
    return;
  }

  const existingToolCalls = Array.isArray(
    params.toolsCalledByPrompt[params.promptIndex],
  )
    ? params.toolsCalledByPrompt[params.promptIndex]!
    : [];

  params.toolsCalledByPrompt[params.promptIndex] = mergeToolCalls(
    existingToolCalls,
    partialToolCalls,
  );
}

function toStreamToolCalls(toolCalls: ToolCall[]): EvalStreamToolCall[] {
  return toolCalls.map((toolCall) => ({
    toolName: toolCall.toolName,
    arguments: toolCall.arguments,
  }));
}

function buildTraceSnapshotEvent(params: {
  turnIndex: number;
  stepIndex?: number;
  snapshotKind: TraceSnapshotKind;
  messages: ModelMessage[];
  spans: EvalTraceSpan[];
  usage: UsageTotals;
  actualToolCalls: ToolCall[];
  prompts?: PromptTraceSummary[];
}): Extract<EvalStreamEvent, { type: "trace_snapshot" }> {
  const trace: EvalTraceBlobV1 = {
    traceVersion: 1,
    messages: params.messages,
    ...(params.spans.length > 0 ? { spans: params.spans } : {}),
    ...(params.prompts && params.prompts.length > 0
      ? { prompts: params.prompts }
      : {}),
  };

  return {
    type: "trace_snapshot",
    turnIndex: params.turnIndex,
    ...(typeof params.stepIndex === "number"
      ? { stepIndex: params.stepIndex }
      : {}),
    snapshotKind: params.snapshotKind,
    trace: sanitizeForConvexTransport(trace),
    actualToolCalls: sanitizeForConvexTransport(
      toStreamToolCalls(params.actualToolCalls),
    ),
    usage: {
      inputTokens: params.usage.inputTokens ?? 0,
      outputTokens: params.usage.outputTokens ?? 0,
      totalTokens: params.usage.totalTokens ?? 0,
    },
  };
}

/**
 * The Convex `testCaseSnapshot` validator moved to the unified `steps` model and
 * REJECTS the legacy `promptTurns` field — `ArgumentValidationError: Object
 * contains extra field 'promptTurns'`. That error is swallowed by the
 * iteration-create try/catch, so the run streams a result but NOTHING lands in
 * Runs. Convert `promptTurns → steps` (the canonical adapter) and drop the
 * legacy field so the write validates. No-op when there's no `promptTurns`
 * (already steps-shaped) — and prefers an existing `steps` array if present.
 */
function snapshotWithStepsForConvex(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !("promptTurns" in snapshot)
  ) {
    return snapshot;
  }
  const { promptTurns, steps, ...rest } = snapshot as Record<string, unknown>;
  const resolvedSteps =
    Array.isArray(steps) && steps.length > 0
      ? steps
      : Array.isArray(promptTurns)
        ? promptTurnsToSteps(promptTurns as PromptTurn[])
        : undefined;
  return resolvedSteps ? { ...rest, steps: resolvedSteps } : rest;
}

// Helper to create iteration directly (for quick runs without a recorder)
async function createIterationDirectly(
  convexClient: ConvexHttpClient,
  params: {
    testCaseId?: string;
    testCaseSnapshot: {
      title: string;
      query: string;
      provider: string;
      model: string;
      runs?: number;
      repetitions?: number;
      passThreshold?: number;
      expectedToolCalls: any[];
      isNegativeTest?: boolean;
      expectedOutput?: string;
      intent?: string;
      steps?: TestStep[];
      promptTurns?: PromptTurn[];
      advancedConfig?: Record<string, unknown>;
      matchOptions?: import("@/shared/eval-matching").MatchOptionsDTO;
      hostConfigOverride?: Record<string, unknown>;
    };
    iterationNumber: number;
    startedAt: number;
  },
): Promise<string | undefined> {
  try {
    const result = await convexClient.mutation(
      "testSuites:recordIterationStartWithoutRun" as any,
      {
        testCaseId: params.testCaseId,
        testCaseSnapshot: sanitizeForConvexTransport(
          snapshotWithStepsForConvex(params.testCaseSnapshot),
        ),
        iterationNumber: params.iterationNumber,
        startedAt: params.startedAt,
      },
    );

    return result?.iterationId as string | undefined;
  } catch (error) {
    logger.error("[evals] Failed to create iteration:", error);
    return undefined;
  }
}

/**
 * Persist a failed iteration row when iteration setup throws BEFORE the
 * per-prompt loop can start (e.g. `prepareChatV2` rejects on Anthropic
 * tool-name validation or meta-tool collisions). Used by the backend
 * runners, which lack the outer try/catch the AI-SDK runners have.
 */
async function persistSetupFailedIteration(args: {
  iterationId: string | undefined;
  runStartedAt: number;
  errorMessage: string;
  iterationMetadataBase: IterationMetadataBase;
  /**
   * The authored case's stage inputs (`buildStageAuthoredCase`).
   *
   * A setup abort is the one iteration shape that finalizes without ever
   * entering the prompt loop, and the chain has a dedicated verdict for it:
   * every applicable stage `notMeasured` for `setupAborted`, with
   * `failureCategory: "setup"`. Omitted ⇒ no stage keys, which is how a caller
   * that cannot say what the case authored stays honest.
   */
  stageCase?: StageAuthoredCase;
  setupSignals?: StageSetupSignals;
  setupSpans?: EvalTraceSpan[];
  setupAudit?: Record<string, unknown>;
  recorder: SuiteRunRecorder | null;
  convexClient: ConvexHttpClient;
}): Promise<void> {
  const failParams = {
    ...(args.iterationId ? { iterationId: args.iterationId } : {}),
    passed: false,
    toolsCalled: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    messages: [] as ModelMessage[],
    // The environment never came up, so nothing was asked of the server under
    // test. `failed` would report this as the server's problem; `setup_failed`
    // says the harness never got to the question, which is what validity
    // aggregation needs in order to withhold a verdict instead of inventing one.
    status: "setup_failed" as const,
    startedAt: args.runStartedAt,
    error: args.errorMessage,
    resultSource: "reported" as const,
    metadata: {
      ...args.iterationMetadataBase,
      ...buildStageMetadata({
        ...(args.stageCase ? { stageCase: args.stageCase } : {}),
        // No real spans/prompts/messages: the analyzer reads that as
        // `traceAbsent`. When setupSignals are present it measures the top
        // two stages instead of blanking the whole chain.
        ...(args.setupSignals ? { setupSignals: args.setupSignals } : {}),
        status: "setup_failed",
        error: args.errorMessage,
      }),
      ...(args.setupAudit ?? {}),
    },
    ...(args.setupSpans?.length ? { spans: args.setupSpans } : {}),
  };
  await dispatchEvalIterationFinalize({
    recorder: args.recorder,
    convexClient: args.convexClient,
    finishParams: failParams,
  });
}

/**
 * Un-strand a run that died at run-level connect / tools-list.
 *
 * Pre-created iterations sit `pending` and `blockTerminal` would otherwise
 * soft-block the terminal transition. Each evidence-carrying write is
 * acknowledged: we re-read the run details after the batch and retry any
 * residual still-pending rows once before the `markSetupPendingIterationsFailed`
 * sweep, so the sweep can never silently strip stage metadata from a row
 * whose write failed.
 */
async function persistRunSetupFailure(args: {
  runId: string;
  convexClient: ConvexHttpClient;
  recorder: SuiteRunRecorder | null;
  observer: RunSetupObserver;
  errorMessage: string;
  tests: EvalTestCase[];
  runStartedAt: number;
}): Promise<void> {
  const setupSignals = args.observer.buildSignals();
  const setupSpans = args.observer.buildSyntheticSpans(args.runStartedAt);
  const setupAudit = args.observer.buildAuditMetadata();

  const listPending = async (): Promise<Array<
    Record<string, unknown>
  > | null> => {
    try {
      const details = (await args.convexClient.query(
        "testSuites:getTestSuiteRunDetails" as any,
        { runId: args.runId },
      )) as { iterations?: Array<Record<string, unknown>> } | null;
      return (details?.iterations ?? []).filter(
        (row) => row.status === "pending",
      );
    } catch (readError) {
      logger.warn("[evals] Failed to read pending setup iterations", {
        runId: args.runId,
        error:
          readError instanceof Error ? readError.message : String(readError),
      });
      return null;
    }
  };

  const persistPending = async (pending: Array<Record<string, unknown>>) => {
    await Promise.allSettled(
      pending.map(async (row) => {
        const iterationId =
          typeof row._id === "string"
            ? row._id
            : typeof row.iterationId === "string"
              ? row.iterationId
              : undefined;
        const test = args.tests.find(
          (candidate) =>
            candidate.testCaseId && candidate.testCaseId === row.testCaseId,
        );
        const snapshot = row.testCaseSnapshot as
          { query?: string; expectedToolCalls?: unknown[] } | undefined;
        await persistSetupFailedIteration({
          iterationId,
          runStartedAt: args.runStartedAt,
          errorMessage: args.errorMessage,
          iterationMetadataBase: {},
          ...(test
            ? {
                stageCase: buildStageAuthoredCase({
                  test,
                  turns: test.promptTurns,
                  caseNeedsModel: true,
                }),
              }
            : snapshot
              ? {
                  stageCase: buildStageAuthoredCase({
                    test: {
                      query: snapshot.query,
                      expectedToolCalls: snapshot.expectedToolCalls,
                    } as EvalTestCase,
                    caseNeedsModel: true,
                  }),
                }
              : {}),
          ...(setupSignals ? { setupSignals } : {}),
          ...(setupSpans.length ? { setupSpans } : {}),
          ...(setupAudit ? { setupAudit } : {}),
          recorder: args.recorder,
          convexClient: args.convexClient,
        });
      }),
    );
  };

  const first = await listPending();
  if (first) {
    await persistPending(first);
  }
  const afterFirst = await listPending();
  if (afterFirst && afterFirst.length > 0) {
    await persistPending(afterFirst);
  }
  const residual = await listPending();
  if (residual === null || residual.length > 0) {
    try {
      await args.convexClient.mutation(
        "testSuites:markSetupPendingIterationsFailed" as any,
        { runId: args.runId, error: args.errorMessage },
      );
    } catch (cleanupError) {
      logger.warn("[evals] Failed to mark residual setup iterations failed", {
        runId: args.runId,
        error:
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
      });
    }
  }
}

/**
 * Eval-side adapter over the shared terminal finalize step
 * (`browser-artifact-finalize.ts`), which owns the capture-before-teardown
 * ordering for every surface that drives the headless-Chromium harness. Eval
 * runners keep disposing the browser in their own `finally`, so no `teardown`
 * is passed and the behavior here is unchanged.
 */
async function finalizeIterationWithBrowserArtifacts(args: {
  browser: BrowserSessionContext;
  recorder: SuiteRunRecorder | null;
  convexClient: ConvexHttpClient;
  finishParams: Omit<EvalIterationFinishParams, "videoBytes">;
}): Promise<void> {
  await finalizeWithBrowserArtifacts({
    browser: args.browser,
    logScope: "evals",
    sink: {
      kind: "eval",
      recorder: args.recorder,
      convexClient: args.convexClient,
      finishParams: args.finishParams,
    },
  });
}

type RunIterationBaseParams = {
  test: EvalTestCase;
  runIndex: number;
  /**
   * Suite-level raw tool set, kept for `toolSignals` telemetry only.
   * Iteration runners route the actual tool prep through `prepareChatV2`
   * (per PR 1 of the engine consolidation) so eval gets skill tools,
   * progressive-discovery meta-tools, Anthropic name validation, and the
   * system-prompt assembly chat already applies. Removed in a later PR.
   */
  tools: ToolSet;
  /** Server ids the iteration runner hands to `prepareChatV2`. */
  selectedServers: string[];
  mcpClientManager: MCPClientManager;
  recorder: SuiteRunRecorder | null;
  testCaseId?: string;
  suiteId?: string;
  modelApiKeys?: Record<string, string>;
  orgModelConfig?: ResolvedOrgModelConfig;
  orgModelConfigTarget?: ResolveOrgModelConfigTarget;
  convexClient: ConvexHttpClient;
  runId: string | null; // For cancellation checks
  abortSignal?: AbortSignal; // For aborting in-flight requests
  compareRunId?: string;
  /** Rewrite-arm marker — see {@link RunEvalSuiteOptions.toolDescriptionOverride}. */
  toolDescriptionOverride?: ToolDescriptionOverrideMarker;
  /**
   * If supplied, the runner skips the upfront `recordIterationStartWithoutRun`
   * call and reuses this id. Used by `streamTestCase` when `runs > 1` so all N
   * pending rows appear in the iteration history immediately, before iteration
   * #1 finishes.
   */
  precreatedIterationId?: string;
  /**
   * Suite-level resolved compat-runtime flag — propagated from
   * `RunEvalSuiteOptions.suiteInjectOpenAiCompat`. When true, widget
   * snapshots captured during this iteration get the OpenAI Apps SDK
   * `window.openai` shim injected before persistence. Default behavior
   * (absent/undefined or false) leaves snapshots un-shimmed.
   */
  injectOpenAiCompat?: boolean;
  /** Resolved host execution policy from the run's hostConfig snapshot. */
  hostPolicy?: HostExecutionPolicy;
  /** The run's frozen grading-engine position (see RunEvalSuiteOptions). */
  gradingMode?: GradingEngineMode;
  /** Pre-computed tool exposure signals for this run (set by runEvalSuiteWithAiSdk). */
  toolSignals?: ToolExposureSignals;
  toolPolicy?: EvalSuiteFileToolPolicy;
  toolAnnotations?: ToolAnnotationsLookup;
  toolPolicyWarnings?: string[];
  /** See {@link RunEvalSuiteOptions.benchmarkWriteGuard}. */
  benchmarkWriteGuard?: BenchmarkWriteGuard;
  /** Folded run-level connect / tools-list evidence (D6). */
  setupSignals?: StageSetupSignals;
  /** Synthetic connection/discovery spans (timeline only). */
  setupSpans?: EvalTraceSpan[];
  /** Bounded producer-owned setup audit record. */
  setupAudit?: Record<string, unknown>;
  /**
   * Raw suite hostConfig record — the same one the route layer feeds
   * to `extractHostExecutionPolicy` for the `hostPolicy` field above.
   * PR 4d of the engine consolidation (`~/mcpjam-docs/unification.md`)
   * threads this through so per-iteration runners can resolve CONFIG
   * fields (`systemPrompt` / `temperature` / `selectedServerIds`) off
   * it via `resolveExecutionContext` — the runner used to read
   * `advancedConfig.system` only, leaving the suite-default systemPrompt
   * unused at runtime even though the eval client deliberately omits
   * it from per-case `advancedConfig` (see comment at
   * `client/src/components/evals/use-eval-handlers.ts:302`).
   *
   * Optional so quick-run paths that don't load a suite hostConfig keep
   * working — the resolver treats `null`/`undefined` as "no host opinion;
   * use overrides as-is."
   */
  suiteHostConfig?: Record<string, unknown> | null;
  /**
   * Run environment snapshot (servers + serverBindings). Consulted to resolve
   * a pinned-tool-call turn's server reference (id first, display-name
   * fallback) to a manager key — the same binding maps the LLM path uses for
   * its environment. Absent on quick-run paths that pre-resolve servers.
   */
  environment?: RunEvalSuiteOptions["config"]["environment"];
  /**
   * The PROJECT ENVIRONMENT this run launched from — a `projectEnvironments`
   * doc id, and NOT to be confused with either neighbour: `environment` above
   * is the servers snapshot, and `computerEnvironmentId` is a sandbox IMAGE.
   *
   * Carried for the HARNESS path only, where it is the grant boundary for the
   * run's project secrets: an external-account credential delivered by a
   * BROKERED secret is only composed onto this iteration's box when THIS
   * environment selects it, so the check has to be scoped to it.
   *
   * Absent on a legacy (non-environment) suite run, which grants no secrets.
   */
  projectEnvironmentId?: string;
  /**
   * Why {@link projectEnvironmentId} is absent on a run that HAS an
   * environment. Set ONLY by the replay path: a replay run inherits the source
   * run's `configSnapshot.environmentRef` on the backend, so its boxes really
   * may carry a brokered transform, but no public read projects that ref back
   * out. Copy only — the harness refuses either way, and this just keeps the
   * refusal from blaming an environment selection the reader never made.
   */
  projectEnvironmentUnresolvedReason?: string;
  /** Run caller's Convex bearer — used to provision/release the reproducible
   * eval sandbox when the suite pins a computerEnvironment. */
  convexAuthToken: string;
  /**
   * The skill delivery this run's PINS resolved to (see
   * {@link RunEvalSuiteOptions.pinnedSkillSource}). Eval runs NEVER use local-FS
   * skills (decision 10) — the runner passes this or `skillsSource: none`.
   */
  pinnedSkillSource?: EvalPinnedSkillSource;
  /** The run's frozen skills in harness shape (see
   *  {@link RunEvalSuiteOptions.pinnedHarnessSkills}). */
  pinnedHarnessSkills?: PinnedSkillArtifact[];
  /**
   * The run's resolved MCP Tasks seam (`resolveToolTaskSeam`, surface
   * `"eval"`), or absent for tasks-off.
   *
   * Resolved ONCE per run, at the run boundary, because the `await` driver it
   * carries is bound to the run's own abort signal — a per-iteration
   * re-derivation would either lose that binding or build a second driver. The
   * emulated path consumes it indirectly (the tool set is already built under
   * it); the HARNESS path needs the seam itself, because `runHarnessTurn`
   * rebuilds its MCP tools and reads `tasks` off the handler options.
   */
  tasks?: ToolTaskSeamOptions;
};

type RunIterationAiSdkParams = RunIterationBaseParams & {
  modelDefinition: ModelDefinition;
};

type RunIterationBackendParams = RunIterationBaseParams & {
  convexHttpUrl: string;
  convexAuthToken: string;
  modelId: string;
  /** Resolved model definition — fed to `prepareChatV2` for Anthropic name validation. */
  modelDefinition: ModelDefinition;
  endpointPath?: "/stream" | "/stream/org";
  extraBodyFields?: Record<string, unknown>;
  /** See {@link RunEvalSuiteOptions.extraHeaders}. */
  extraHeaders?: Record<string, string>;
};

function parseCustomProviderName(modelId: string): string | undefined {
  if (!modelId.startsWith("custom:")) return undefined;

  const [, providerName] = modelId.split(":");
  return providerName || undefined;
}

const buildModelDefinition = (test: EvalTestCase): ModelDefinition => {
  const supportedModel = getModelById(test.model);
  if (
    supportedModel &&
    supportedModel.provider.toLowerCase() === test.provider.toLowerCase()
  ) {
    return supportedModel;
  }

  const provider = test.provider as ModelProvider;
  return {
    id: test.model,
    name: test.title || String(test.model),
    provider,
    ...(provider === "custom"
      ? { customProviderName: parseCustomProviderName(test.model) }
      : {}),
  };
};

function lookupProviderApiKey(
  modelApiKeys: Record<string, string> | undefined,
  provider: string,
): string | undefined {
  return modelApiKeys?.[provider] ?? modelApiKeys?.[provider.toLowerCase()];
}

function hasBaseUrls(baseUrls: BaseUrls): boolean {
  return Boolean(baseUrls.ollama || baseUrls.azure || baseUrls.bedrock);
}

function resolveEvalModelRuntime(args: {
  test: EvalTestCase;
  modelDefinition: ModelDefinition;
  modelApiKeys?: Record<string, string>;
  orgModelConfig?: ResolvedOrgModelConfig;
}): {
  apiKey: string;
  baseUrls?: BaseUrls;
  customProviders?: CustomProviderConfig[];
} {
  const orgRuntime = args.orgModelConfig
    ? buildLlmRuntimeConfigFromOrgConfig(args.orgModelConfig)
    : undefined;
  const apiKey =
    lookupProviderApiKey(args.modelApiKeys, args.test.provider) ??
    lookupProviderApiKey(orgRuntime?.modelApiKeys, args.test.provider) ??
    "";

  const provider = args.modelDefinition.provider;
  if (!apiKey && provider !== "ollama" && provider !== "custom") {
    throw new Error(
      `Missing API key for provider ${args.test.provider} (test: ${args.test.title})`,
    );
  }

  return {
    apiKey,
    ...(orgRuntime?.baseUrls && hasBaseUrls(orgRuntime.baseUrls)
      ? { baseUrls: orgRuntime.baseUrls }
      : {}),
    ...(orgRuntime?.customProviders.length
      ? { customProviders: orgRuntime.customProviders }
      : {}),
  };
}

function hasExplicitModelApiKeys(
  modelApiKeys: Record<string, string> | undefined,
): boolean {
  return Boolean(modelApiKeys && Object.keys(modelApiKeys).length > 0);
}

function resolveOrgTargetForEval(
  test: EvalTestCase,
  explicitTarget?: ResolveOrgModelConfigTarget,
): ResolveOrgModelConfigTarget | undefined {
  if (explicitTarget) return explicitTarget;
  const maybeProjectId = (test as { projectId?: unknown }).projectId;
  if (typeof maybeProjectId === "string" && maybeProjectId.trim()) {
    return { projectId: maybeProjectId.trim() };
  }
  return undefined;
}

async function resolveOrgByokEvalRuntime(args: {
  test: EvalTestCase;
  modelDefinition: ModelDefinition;
  modelApiKeys?: Record<string, string>;
  orgModelConfig?: ResolvedOrgModelConfig;
  orgModelConfigTarget?: ResolveOrgModelConfigTarget;
  convexAuthToken: string;
}): Promise<
  | {
      kind: "cloud";
      providerKey: string;
      target: ResolveOrgModelConfigTarget;
    }
  | {
      kind: "local";
      orgModelConfig: ResolvedOrgModelConfig;
    }
  | undefined
> {
  if (hasExplicitModelApiKeys(args.modelApiKeys)) return undefined;

  const providerKeyResult = deriveOrgProviderKey(args.modelDefinition);
  if (!providerKeyResult.ok) return undefined;

  const target = resolveOrgTargetForEval(args.test, args.orgModelConfigTarget);
  if (!target) return undefined;

  const providerKey = providerKeyResult.key;
  if (!isLocalRuntimeEligible(providerKey)) {
    return { kind: "cloud", providerKey, target };
  }

  if ("organizationId" in target) {
    return { kind: "cloud", providerKey, target };
  }

  const runtime = await resolveOrgProviderRuntimeForTarget(
    target,
    providerKey,
    String(args.modelDefinition.id),
    { bearerToken: args.convexAuthToken },
  );
  if (runtime.runtimeLocation === "cloud") {
    return { kind: "cloud", providerKey: runtime.providerKey, target };
  }

  return {
    kind: "local",
    orgModelConfig: { providers: [runtime.provider] },
  };
}

// PR6: single hosted wrapper for both modes (emit optional). Owns the browser
// harness lifecycle (try/finally guarantees Chromium teardown on every exit).
const runHostedIteration = async (
  params: RunIterationBackendParams & { emit?: StreamEmit },
): Promise<EvalIterationOutcome> => {
  // First pinned turn's per-call render-budget override (mirrors the local
  // runner's harness creation).
  const pinnedRenderTimeoutMs = resolveEvalTestCase(
    params.test,
  ).promptTurns.find(
    (t) =>
      isPinnedTurn(t) && typeof t.pinnedToolCall?.renderTimeoutMs === "number",
  )?.pinnedToolCall?.renderTimeoutMs;
  const browser = await createBrowserSessionContext({
    model: params.test.model,
    mcpClientManager: params.mcpClientManager,
    injectOpenAiCompat: params.injectOpenAiCompat,
    ...(pinnedRenderTimeoutMs
      ? { renderTimeoutMs: pinnedRenderTimeoutMs }
      : {}),
  });
  try {
    return await runHostedIterationWithBrowser(params, browser);
  } finally {
    await browser.dispose();
  }
};

// PR4: one dispatcher for both quick-run modes. `emit` present ⇒ streaming
// (SSE iteration runners); absent ⇒ batch (suite/quick-run, recorder terminal).
// The model resolution, precreate-iterations, and run loop are identical; only
// the guard-vs-model-free-fork at the top and the per-branch runner family
// differ. `runTestCase` / `streamTestCase` are thin wrappers below.
// Locate the pending/running iteration row for a (test, runIndex) so a timeout
// can mark it `timed_out`. Prefers the precreated id; otherwise matches on
// testCaseId (model-free) or snapshot identity + iteration number.
async function findIterationIdForTimeout(args: {
  convexClient: ConvexHttpClient;
  runId: string | null;
  precreatedIterationId?: string;
  test: EvalTestCase;
  runIndex: number;
}): Promise<string | undefined> {
  if (args.precreatedIterationId) {
    return args.precreatedIterationId;
  }
  if (args.runId === null) {
    return undefined;
  }

  const resolvedTest = resolveEvalTestCase(args.test);
  const shouldMatchByTestCaseOnly =
    !turnsNeedModel({
      caseType: args.test.caseType,
      promptTurns: resolvedTest.promptTurns,
    }) && Boolean(args.test.testCaseId);
  try {
    const response = await args.convexClient.query(
      "testSuites:getTestSuiteRunDetails" as any,
      { runId: args.runId },
    );
    const iterations = response?.iterations ?? [];
    const matching = iterations.find((iteration: any) => {
      if (
        shouldMatchByTestCaseOnly &&
        iteration.testCaseId === args.test.testCaseId &&
        iteration.iterationNumber === args.runIndex + 1 &&
        (iteration.status === "pending" || iteration.status === "running")
      ) {
        return true;
      }

      const snapshot = iteration.testCaseSnapshot ?? {};
      return (
        snapshot.title === args.test.title &&
        snapshot.query === resolvedTest.query &&
        snapshot.model === args.test.model &&
        snapshot.provider === args.test.provider &&
        iteration.iterationNumber === args.runIndex + 1 &&
        (iteration.status === "pending" || iteration.status === "running")
      );
    });
    return matching?._id as string | undefined;
  } catch (error) {
    logger.warn("[evals] Failed to locate iteration for timeout", {
      runId: args.runId,
      runIndex: args.runIndex,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function markIterationTimedOut(args: {
  convexClient: ConvexHttpClient;
  runId: string | null;
  precreatedIterationId?: string;
  test: EvalTestCase;
  runIndex: number;
}): Promise<void> {
  const iterationId = await findIterationIdForTimeout(args);
  if (!iterationId) {
    return;
  }

  const message = "Iteration timed out after 10 minutes";
  try {
    await args.convexClient.action("testSuites:updateTestIteration" as any, {
      iterationId,
      status: "timed_out",
      result: "timed_out",
      actualToolCalls: [],
      tokensUsed: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      messages: [{ role: "assistant", content: message }],
      error: message,
      resultSource: "derived",
      metadata: { stopReason: "iteration_timeout" },
    });
  } catch (error) {
    logger.warn("[evals] Failed to mark timed-out iteration", {
      iterationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Race a single iteration against the 10-minute per-iteration cap. On timeout
// the loser (`onTimeout`) aborts the run and marks the row; a finished or
// already-aborted iteration skips the timeout cleanly.
export async function runIterationWithTimeout<T>(args: {
  run: () => Promise<T>;
  onTimeout: () => Promise<void>;
  shouldSkipTimeout: () => boolean;
}): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      args.run(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          if (args.shouldSkipTimeout()) {
            return;
          }
          reject(ITERATION_TIMEOUT_ERROR);
          void args.onTimeout().catch((error) => {
            logger.warn("[evals] Iteration timeout cleanup failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, EVAL_ITERATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

const executeTestCase = async (params: {
  test: EvalTestCase;
  tools: ToolSet;
  selectedServers: string[];
  mcpClientManager: MCPClientManager;
  recorder: SuiteRunRecorder | null;
  modelApiKeys?: Record<string, string>;
  orgModelConfig?: ResolvedOrgModelConfig;
  orgModelConfigTarget?: ResolveOrgModelConfigTarget;
  convexHttpUrl: string;
  convexAuthToken: string;
  convexClient: ConvexHttpClient;
  testCaseId?: string;
  suiteId?: string;
  runId: string | null;
  abortSignal?: AbortSignal;
  /** Lifecycle abort hook: an iteration timeout aborts the whole run through it. */
  abortRun?: (error: EvalRunStoppedError) => void;
  compareRunId?: string;
  /** Rewrite-arm marker — see {@link RunEvalSuiteOptions.toolDescriptionOverride}. */
  toolDescriptionOverride?: ToolDescriptionOverrideMarker;
  /** Present ⇒ streaming mode: SSE events flow here and iterations run on the
   *  stream* runners. Absent ⇒ batch mode. */
  emit?: StreamEmit;
  /** Suite-level compat-runtime flag; forwarded to each iteration. */
  injectOpenAiCompat?: boolean;
  /** Host execution policy for metadata stamping. */
  hostPolicy?: HostExecutionPolicy;
  /** The run's frozen grading-engine position (see RunEvalSuiteOptions). */
  gradingMode?: GradingEngineMode;
  /** Pre-computed tool exposure signals for metadata stamping. */
  toolSignals?: ToolExposureSignals;
  setupSignals?: StageSetupSignals;
  setupSpans?: EvalTraceSpan[];
  setupAudit?: Record<string, unknown>;
  /** Raw suite hostConfig record. PR 4d — see RunIterationBaseParams. */
  suiteHostConfig?: Record<string, unknown> | null;
  /**
   * Run environment snapshot (servers + serverBindings). Consulted to resolve
   * pinned (`toolCall`) server references to a manager key — by the model-free
   * fork below and by both iteration paths' step handlers; the LLM path
   * receives its servers pre-resolved via `selectedServers`.
   */
  environment?: RunEvalSuiteOptions["config"]["environment"];
  /** The run's PROJECT ENVIRONMENT id (see RunEvalSuiteOptions) — the grant
   *  boundary a harness iteration's brokered credential check is scoped to. */
  projectEnvironmentId?: string;
  /** See {@link RunEvalSuiteOptions.projectEnvironmentUnresolvedReason}. */
  projectEnvironmentUnresolvedReason?: string;
  /** Pinned skill delivery for this run (see RunEvalSuiteOptions.pinnedSkillSource). */
  pinnedSkillSource?: EvalPinnedSkillSource;
  /** The run's frozen skills in harness shape (see
   *  RunEvalSuiteOptions.pinnedHarnessSkills). */
  pinnedHarnessSkills?: PinnedSkillArtifact[];
  /** The run's resolved Tasks seam — see RunIterationBaseParams.tasks. */
  tasks?: ToolTaskSeamOptions;
  toolPolicy?: EvalSuiteFileToolPolicy;
  toolAnnotations?: ToolAnnotationsLookup;
  toolPolicyWarnings?: string[];
  /** See {@link RunEvalSuiteOptions.benchmarkWriteGuard}. */
  benchmarkWriteGuard?: BenchmarkWriteGuard;
  /** See {@link RunEvalSuiteOptions.extraHeaders}. */
  extraHeaders?: Record<string, string>;
}) => {
  const {
    test,
    tools,
    selectedServers,
    mcpClientManager,
    recorder,
    modelApiKeys,
    orgModelConfig,
    orgModelConfigTarget,
    convexHttpUrl,
    convexAuthToken,
    convexClient,
    testCaseId: parentTestCaseId,
    suiteId,
    runId,
    abortSignal,
    abortRun,
    compareRunId,
    toolDescriptionOverride,
    emit,
    injectOpenAiCompat,
    hostPolicy,
    gradingMode,
    toolSignals,
    setupSignals,
    setupSpans,
    setupAudit,
    suiteHostConfig,
    environment,
    projectEnvironmentId,
    projectEnvironmentUnresolvedReason,
    pinnedSkillSource,
    pinnedHarnessSkills,
    tasks,
    toolPolicy,
    toolAnnotations,
    toolPolicyWarnings,
    benchmarkWriteGuard,
    extraHeaders,
  } = params;
  const testCaseId = test.testCaseId || parentTestCaseId;
  const streaming = emit != null;

  // Normalize legacy `widget_probe` rows into a single model-free pinned turn
  // so the unified engine sees one shape. No-op for already-pinned / prompt
  // cases.
  const normalizedTest = normalizeTestForPinnedTurns(test);

  // Run a single iteration under the per-iteration timeout + run-abort guards.
  // Bails immediately if the run was already stopped; on timeout it aborts the
  // whole run (via `abortRun`) and marks the row `timed_out`.
  const runSingleIteration = async <T extends EvalIterationOutcome>(
    runner: () => Promise<T>,
    precreatedIterationId: string | undefined,
    runIndex: number,
    timeoutTest: EvalTestCase = normalizedTest,
  ): Promise<T> => {
    if (abortSignal?.aborted) {
      const reason = abortSignal.reason;
      throw reason instanceof Error ? reason : RUN_CANCELLED_ERROR;
    }
    return await runIterationWithTimeout({
      run: runner,
      shouldSkipTimeout: () => abortSignal?.aborted === true,
      onTimeout: async () => {
        abortRun?.(ITERATION_TIMEOUT_ERROR);
        await markIterationTimedOut({
          convexClient,
          runId,
          precreatedIterationId,
          test: timeoutTest,
          runIndex,
        });
      },
    });
  };

  // Pinned-only case (today's render check): no model turns at all. Run it
  // through the local AI-SDK engine, model-free — it skips all model/BYOK setup
  // and executes each pinned turn via runPinnedTurn. Never routes to a hosted
  // backend (there is no model to bill / drive). PR5: streams too — the local
  // driver's pinned branch synthesizes the SSE sequence via `onPinnedTurn`.
  if (
    !turnsNeedModel({
      caseType: normalizedTest.caseType,
      promptTurns: resolveEvalTestCase(normalizedTest).promptTurns,
    })
  ) {
    const outcomes: EvalIterationOutcome[] = [];
    const pinnedRuns = Math.max(1, Math.floor(normalizedTest.runs || 1));
    for (let runIndex = 0; runIndex < pinnedRuns; runIndex++) {
      if (abortSignal?.aborted) break;
      const modelFreeParams = {
        test: normalizedTest,
        runIndex,
        tools,
        selectedServers,
        mcpClientManager,
        recorder,
        testCaseId,
        suiteId,
        // Unused when the case is model-free (caseNeedsModel === false), but
        // the param is required. A real id is never resolved.
        modelDefinition: {
          id: "pinned-only",
          provider: "none",
        } as unknown as ModelDefinition,
        modelApiKeys,
        orgModelConfig,
        orgModelConfigTarget,
        convexClient,
        runId,
        abortSignal,
        convexAuthToken,
        ...(compareRunId ? { compareRunId } : {}),
        ...(toolDescriptionOverride ? { toolDescriptionOverride } : {}),
        injectOpenAiCompat,
        hostPolicy,
        gradingMode,
        toolSignals,
        setupSignals,
        setupSpans,
        setupAudit,
        suiteHostConfig,
        environment,
        pinnedSkillSource,
        pinnedHarnessSkills,
        ...(toolPolicy
          ? { toolPolicy, toolAnnotations, toolPolicyWarnings }
          : {}),
        ...(benchmarkWriteGuard ? { benchmarkWriteGuard } : {}),
      };
      outcomes.push(
        await runSingleIteration(
          () =>
            runLocalIteration({
              ...modelFreeParams,
              ...(streaming ? { emit: emit! } : {}),
            }),
          undefined,
          runIndex,
          normalizedTest,
        ),
      );
    }
    return outcomes;
  }

  // THE HOST'S MODEL WINS on an external-account harness, exactly as it does on
  // the chat rails. Resolved here rather than at either iteration runner so
  // everything downstream of this line agrees on one model: the canonical id
  // below, the MCPJam-vs-BYOK split, the org-BYOK runtime lookup, the engine's
  // wire payload and what the iteration reports as the model it ran.
  //
  // Without it, admission and execution disagreed. Admission reads the host's
  // id and accepts a case whose own model is an ordinary one; execution then
  // carried that case model to `runAssistantTurn`, whose eligibility check saw
  // a non-sentinel on an external-account harness and refused a run it had
  // already admitted. A per-case model is normal in evals, so that refusal hit
  // legitimate Cursor suites.
  const modelDefinition = resolveEvalCaseModelDefinition({
    hostConfig: suiteHostConfig,
    caseModel: buildModelDefinition(test),
  });
  const resolvedModelId = getCanonicalModelId(
    String(modelDefinition.id),
    modelDefinition.provider,
  );
  const isJamModel = isHostedCatalogModel(
    resolvedModelId,
    modelDefinition.provider,
  );
  const orgByokRuntime = isJamModel
    ? undefined
    : await resolveOrgByokEvalRuntime({
        test,
        modelDefinition,
        modelApiKeys,
        orgModelConfig,
        orgModelConfigTarget,
        convexAuthToken,
      });
  // MCPJam-paid models bill an org wallet; backend `/stream` rejects the
  // request without a projectId. Same target the org-BYOK path threads.
  const jamBillingTarget = isJamModel
    ? resolveOrgTargetForEval(test, orgModelConfigTarget)
    : undefined;

  const outcomes: EvalIterationOutcome[] = [];

  // Mirrors `streamTestCase`: pre-create all N pending iteration rows for
  // quick-run paths with runs > 1 so the iteration history shows every row
  // immediately, not one-at-a-time as the loop progresses.
  const shouldPrecreateIterations =
    recorder == null && runId == null && test.runs > 1;
  const precreatedIterationIds: (string | undefined)[] = [];
  if (shouldPrecreateIterations) {
    const resolvedTestForPrecreate = resolveEvalTestCase(test);
    const resolvedStepsForPrecreate = resolveSteps(test);
    const precreatedAt = Date.now();
    for (let runIndex = 0; runIndex < test.runs; runIndex++) {
      try {
        const iterationParams = {
          testCaseId: test.testCaseId ?? testCaseId,
          testCaseSnapshot: {
            title: test.title,
            query: resolvedTestForPrecreate.query,
            provider: test.provider,
            model: test.model,
            runs: test.runs,
            expectedToolCalls: resolvedTestForPrecreate.expectedToolCalls,
            isNegativeTest: test.isNegativeTest,
            expectedOutput: resolvedTestForPrecreate.expectedOutput,
            ...(test.intent !== undefined ? { intent: test.intent } : {}),
            steps: resolvedStepsForPrecreate,
            advancedConfig: resolvedTestForPrecreate.advancedConfig,
            matchOptions: test.matchOptions,
            hostConfigOverride: test.hostConfigOverride,
          },
          iterationNumber: runIndex + 1,
          startedAt: precreatedAt,
        };
        const id = await createIterationDirectly(convexClient, iterationParams);
        precreatedIterationIds.push(id);
      } catch (error) {
        logger.warn(
          "[evals] Failed to precreate iteration row; falling back to per-loop create",
          {
            runIndex,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        precreatedIterationIds.push(undefined);
      }
    }
  }

  for (let runIndex = 0; runIndex < test.runs; runIndex++) {
    const precreatedIterationId = shouldPrecreateIterations
      ? precreatedIterationIds[runIndex]
      : undefined;
    if (isJamModel) {
      const backendParams = {
        test,
        runIndex,
        tools,
        selectedServers,
        mcpClientManager,
        recorder,
        testCaseId,
        suiteId,
        convexHttpUrl,
        convexAuthToken,
        modelId: resolvedModelId,
        modelDefinition,
        extraBodyFields: jamBillingTarget ? { ...jamBillingTarget } : undefined,
        ...(extraHeaders ? { extraHeaders } : {}),
        convexClient,
        modelApiKeys,
        orgModelConfig,
        orgModelConfigTarget,
        runId,
        abortSignal,
        compareRunId,
        ...(toolDescriptionOverride ? { toolDescriptionOverride } : {}),
        precreatedIterationId,
        injectOpenAiCompat,
        hostPolicy,
        gradingMode,
        toolSignals,
        setupSignals,
        setupSpans,
        setupAudit,
        suiteHostConfig,
        environment,
        // A `projectEnvironments` doc id, not the servers snapshot above and
        // not a sandbox image — see `RunIterationBaseParams`.
        ...(projectEnvironmentId ? { projectEnvironmentId } : {}),
        ...(projectEnvironmentUnresolvedReason
          ? { projectEnvironmentUnresolvedReason }
          : {}),
        pinnedSkillSource,
        pinnedHarnessSkills,
        // The run's Tasks seam. Hosted-only: it exists so the HARNESS turn can
        // rebuild its MCP tools under the same seam the emulated tool set was
        // already built with (`getEvalToolsForAiSdkOrThrow`).
        ...(tasks ? { tasks } : {}),
        ...(toolPolicy
          ? { toolPolicy, toolAnnotations, toolPolicyWarnings }
          : {}),
        ...(benchmarkWriteGuard ? { benchmarkWriteGuard } : {}),
      };
      const iterationOutcome = await runSingleIteration(
        () =>
          runHostedIteration({
            ...backendParams,
            ...(streaming ? { emit: emit! } : {}),
          }),
        precreatedIterationId,
        runIndex,
        test,
      );
      outcomes.push(iterationOutcome);
      continue;
    }

    if (orgByokRuntime?.kind === "cloud") {
      const backendParams = {
        test,
        runIndex,
        tools,
        selectedServers,
        mcpClientManager,
        recorder,
        testCaseId,
        suiteId,
        convexHttpUrl,
        convexAuthToken,
        modelId: String(modelDefinition.id),
        modelDefinition,
        endpointPath: "/stream/org" as const,
        extraBodyFields: {
          providerKey: orgByokRuntime.providerKey,
          ...orgByokRuntime.target,
        },
        ...(extraHeaders ? { extraHeaders } : {}),
        convexClient,
        modelApiKeys,
        orgModelConfig,
        orgModelConfigTarget,
        runId,
        abortSignal,
        compareRunId,
        ...(toolDescriptionOverride ? { toolDescriptionOverride } : {}),
        precreatedIterationId,
        injectOpenAiCompat,
        hostPolicy,
        gradingMode,
        toolSignals,
        setupSignals,
        setupSpans,
        setupAudit,
        suiteHostConfig,
        environment,
        // A `projectEnvironments` doc id, not the servers snapshot above and
        // not a sandbox image — see `RunIterationBaseParams`.
        ...(projectEnvironmentId ? { projectEnvironmentId } : {}),
        ...(projectEnvironmentUnresolvedReason
          ? { projectEnvironmentUnresolvedReason }
          : {}),
        pinnedSkillSource,
        pinnedHarnessSkills,
        // The run's Tasks seam. Hosted-only: it exists so the HARNESS turn can
        // rebuild its MCP tools under the same seam the emulated tool set was
        // already built with (`getEvalToolsForAiSdkOrThrow`).
        ...(tasks ? { tasks } : {}),
        ...(toolPolicy
          ? { toolPolicy, toolAnnotations, toolPolicyWarnings }
          : {}),
        ...(benchmarkWriteGuard ? { benchmarkWriteGuard } : {}),
      };
      const iterationOutcome = await runSingleIteration(
        () =>
          runHostedIteration({
            ...backendParams,
            ...(streaming ? { emit: emit! } : {}),
          }),
        precreatedIterationId,
        runIndex,
        test,
      );
      outcomes.push(iterationOutcome);
      continue;
    }

    const localParams = {
      test,
      runIndex,
      tools,
      selectedServers,
      mcpClientManager,
      recorder,
      testCaseId,
      suiteId,
      modelDefinition,
      modelApiKeys,
      orgModelConfig:
        orgByokRuntime?.kind === "local"
          ? orgByokRuntime.orgModelConfig
          : orgModelConfig,
      orgModelConfigTarget,
      convexClient,
      runId,
      abortSignal,
      compareRunId,
      ...(toolDescriptionOverride ? { toolDescriptionOverride } : {}),
      precreatedIterationId,
      injectOpenAiCompat,
      hostPolicy,
      gradingMode,
      toolSignals,
      setupSignals,
      setupSpans,
      setupAudit,
      suiteHostConfig,
      // `environment` resolves a pinned turn's server (local hybrids); harmless
      // for prompt-only cases.
      environment,
      convexAuthToken,
      pinnedSkillSource,
      pinnedHarnessSkills,
      ...(toolPolicy
        ? { toolPolicy, toolAnnotations, toolPolicyWarnings }
        : {}),
      ...(benchmarkWriteGuard ? { benchmarkWriteGuard } : {}),
    };
    const iterationOutcome = await runSingleIteration(
      () =>
        runLocalIteration({
          ...localParams,
          ...(streaming ? { emit: emit! } : {}),
        }),
      precreatedIterationId,
      runIndex,
      test,
    );
    outcomes.push(iterationOutcome);
  }

  return outcomes;
};

// Thin batch wrapper (no `emit`) — preserves the call site in
// `runEvalSuiteWithAiSdk` and tests with zero churn.
const runTestCase = (
  params: Omit<Parameters<typeof executeTestCase>[0], "emit">,
) => executeTestCase(params);

export const runEvalSuiteWithAiSdk = async ({
  gradingMode,
  suiteId,
  runId,
  config,
  modelApiKeys,
  orgModelConfig,
  orgModelConfigTarget,
  convexClient,
  convexHttpUrl,
  convexAuthToken,
  mcpClientManager,
  recorder: providedRecorder,
  testCaseId,
  compareRunId,
  toolDescriptionOverride: toolDescriptionOverrideRaw,
  suiteInjectOpenAiCompat,
  hostExecutionPolicy,
  suiteHostConfig,
  projectEnvironmentId,
  projectEnvironmentUnresolvedReason,
  pinnedSkillSource,
  pinnedHarnessSkills,
  toolPolicy,
  benchmarkWriteGuard,
  extraHeaders,
}: RunEvalSuiteOptions): Promise<RunEvalSuiteWithAiSdkResult | undefined> => {
  const toolDescriptionOverride = readToolDescriptionOverrideMarker(
    toolDescriptionOverrideRaw,
  );
  const descriptionOverrides = descriptionOverridesFromMarker(
    toolDescriptionOverride,
  );
  throwIfDescriptionOverrideOnHarness(
    toolDescriptionOverride,
    harnessOfHostConfig(suiteHostConfig),
  );
  const injectOpenAiCompat = suiteInjectOpenAiCompat === true;
  const tests = config.tests ?? [];
  const serverIds = resolveConfiguredServerIds({
    environment: config.environment,
    mcpClientManager,
  });

  if (!tests.length) {
    throw new Error("No tests supplied for eval run");
  }

  if (
    toolPolicy?.mode === "readOnly" &&
    typeof (
      config.environment as { computerEnvironmentId?: unknown } | undefined
    )?.computerEnvironmentId === "string"
  ) {
    logger.warn(
      "[evals] readOnly tool policy does not restrict the sandbox bash tool",
      { suiteId },
    );
  }

  // For quick runs (runId === null), we don't need a recorder
  const recorder =
    runId === null
      ? null
      : (providedRecorder ??
        createSuiteRunRecorder({
          convexClient,
          suiteId,
          runId,
        }));

  const summary = {
    total: 0,
    passed: 0,
    failed: 0,
    policyBlockedIterations: 0,
  };

  // Create AbortController to cancel in-flight requests. Created BEFORE the
  // task seam below so an `await`-mode task drive shares the run's signal —
  // a cancelled or timed-out run must stop waiting on an in-flight task
  // instead of polling it until the driver's own timeout.
  const abortController = new AbortController();
  // Abort the whole run with a reason (cancel vs timeout). The reason rides on
  // the AbortSignal so iteration runners and the catch below can distinguish
  // user-cancel from a hard timeout.
  const abortRun = (error: EvalRunStoppedError) => {
    if (!abortController.signal.aborted) {
      abortController.abort(error);
    }
  };

  const evalTasksSeam = resolveToolTaskSeam({
    tasksPolicy: readTasksPolicy(
      (suiteHostConfig ?? undefined) as Parameters<typeof readTasksPolicy>[0],
    ),
    surface: "eval",
    // Driver `timeoutMs` stays at its default — the task drive nests under
    // the run timeout, which aborts through this same signal.
    await: { signal: abortController.signal },
  });

  const runSetupStartedAt = Date.now();
  const setupObserver = createRunSetupObserver({
    expectedServerIds: serverIds,
    convexHttpUrl,
  });
  let resolvedToolPolicyWarnings: string[] | undefined;

  try {
    // When a host policy is present we need the full tool set (including
    // app-only) so `applyVisibilityPolicyAndCountSignals` can:
    //   1. Count `toolsTotalBefore` honestly, and
    //   2. Keep app-only tools when the host opted out of visibility filtering.
    // Without this, getToolsForAiSdk pre-strips app-only tools and the policy
    // sees a partial set — drops are reported as 0 even when tools were hidden.
    const tools = await getEvalToolsForAiSdkOrThrow({
      mcpClientManager,
      serverIds,
      includeAppOnly: Boolean(hostExecutionPolicy),
      modelVisibleMcpToolResults:
        hostExecutionPolicy?.modelVisibleMcpToolResults,
      // Host-only, and deliberately NOT read through `pickField`: an eval's
      // per-case `advancedConfig` runs at `override-wins`, and a case must not
      // be able to switch tasks on for a suite whose host said off.
      ...(evalTasksSeam ? { tasks: evalTasksSeam } : {}),
      environment: config.environment,
      setupObserver,
      ...(descriptionOverrides
        ? { toolDescriptionOverrides: descriptionOverrides }
        : {}),
    });
    const toolAnnotations: ToolAnnotationsLookup = new Map();
    if (toolPolicy) {
      const uncachedServerIds = serverIds.filter(
        (serverId) => !mcpClientManager.hasCachedToolAnnotations(serverId),
      );
      if (uncachedServerIds.length > 0) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          `TOOL_POLICY_ANNOTATIONS_UNAVAILABLE: tool policy requires a populated annotation cache for every selected server; missing ${uncachedServerIds.join(
            ", ",
          )}.`,
          {
            reason: "TOOL_POLICY_ANNOTATIONS_UNAVAILABLE",
            serverIds: uncachedServerIds,
          },
        );
      }
      try {
        const availableToolNames = new Set([
          ...Object.keys(tools),
          "computer",
          "finish_widget",
          EVAL_BASH_TOOL_NAME,
        ]);
        resolvedToolPolicyWarnings = validateToolPolicyNames({
          policy: toolPolicy,
          availableToolNames,
          deferredToolNames: [...SKILL_TOOL_NAMES, ...META_TOOL_NAMES],
        });
      } catch (error) {
        if (error instanceof UnmatchedToolPolicyNameError) {
          throw new WebRouteError(
            400,
            ErrorCode.VALIDATION_ERROR,
            error.message,
            { reason: "TOOL_POLICY_INVALID" },
          );
        }
        throw error;
      }
      for (const serverId of serverIds) {
        for (const [toolName, annotations] of Object.entries(
          mcpClientManager.getAllToolAnnotations(serverId),
        )) {
          toolAnnotations.set(
            toolAnnotationsKey(serverId, toolName),
            annotations,
          );
        }
      }
    }

    // Apply visibility filtering when a host policy is present. The filter
    // mutates `tools` in place (same as prepareChatV2) so downstream iteration
    // runners see the post-filter set.
    const resolvedToolSignals = hostExecutionPolicy
      ? applyVisibilityPolicyAndCountSignals(
          tools as Record<string, unknown>,
          mcpClientManager,
          hostExecutionPolicy,
        )
      : undefined;
    if (descriptionOverrides) {
      const overridden = applyDescriptionOverridesToToolSet(
        tools,
        descriptionOverrides,
      );
      if (resolvedToolSignals && overridden > 0) {
        resolvedToolSignals.toolsDescriptionOverridden = overridden;
      }
    }
    const resolvedSetupSignals = setupObserver.buildSignals();
    const resolvedSetupSpans =
      setupObserver.buildSyntheticSpans(runSetupStartedAt);
    const resolvedSetupAudit = setupObserver.buildAuditMetadata();

    // Note: Iterations are now pre-created in startSuiteRunWithRecorder
    // This code is no longer needed as precreateIterationsForRun is called there

    // Check if run has been cancelled before starting (only for suite runs)
    if (runId !== null) {
      const currentRun = await convexClient.query(
        "testSuites:getTestSuiteRun" as any,
        {
          runId,
        },
      );

      if (currentRun?.status === "cancelled") {
        if (recorder) {
          await recorder.finalize({
            status: "cancelled",
            notes: "Run cancelled by user",
          });
        }
        return undefined;
      }
    }

    let stopControls = false;
    let runTimeoutId: ReturnType<typeof setTimeout> | undefined;

    // Run tests in parallel, but cap concurrent render checks: each
    // `widget_probe` case launches a headless Chromium, so an all-render-check
    // monitoring suite would otherwise spawn one browser per case at once and
    // exhaust the worker. LLM-only cases are network-bound and stay unbounded.
    // The limiter releases a slot when each case settles, so it can't leak.
    const renderCheckLimit = createConcurrencyLimiter(
      MAX_CONCURRENT_RENDER_CHECKS,
    );
    const runOne = (test: (typeof tests)[number]) =>
      runTestCase({
        test,
        tools,
        selectedServers: serverIds,
        mcpClientManager,
        recorder,
        modelApiKeys,
        orgModelConfig,
        orgModelConfigTarget,
        convexHttpUrl,
        convexAuthToken,
        convexClient,
        testCaseId,
        compareRunId,
        ...(toolDescriptionOverride ? { toolDescriptionOverride } : {}),
        suiteId,
        runId,
        abortSignal: abortController.signal,
        abortRun,
        injectOpenAiCompat,
        hostPolicy: hostExecutionPolicy,
        ...(gradingMode ? { gradingMode } : {}),
        toolSignals: resolvedToolSignals,
        ...(resolvedSetupSignals ? { setupSignals: resolvedSetupSignals } : {}),
        ...(resolvedSetupSpans.length
          ? { setupSpans: resolvedSetupSpans }
          : {}),
        ...(resolvedSetupAudit ? { setupAudit: resolvedSetupAudit } : {}),
        suiteHostConfig,
        environment: config.environment,
        // The run's PROJECT ENVIRONMENT id — unrelated to `config.environment`
        // above (a servers snapshot) despite the shared word.
        ...(projectEnvironmentId ? { projectEnvironmentId } : {}),
        ...(projectEnvironmentUnresolvedReason
          ? { projectEnvironmentUnresolvedReason }
          : {}),
        ...(toolPolicy
          ? {
              toolPolicy,
              toolAnnotations,
              toolPolicyWarnings: resolvedToolPolicyWarnings,
            }
          : {}),
        ...(benchmarkWriteGuard ? { benchmarkWriteGuard } : {}),
        // BOTH frozen-skill channels, from one place — see
        // `runFrozenSkillOptions`. Forwarding only the emulated one used to
        // leave the harness path falling through to a live project-wide fetch.
        ...runFrozenSkillOptions({ pinnedSkillSource, pinnedHarnessSkills }),
        // The run's ONE Tasks seam — the same object `getEvalToolsForAiSdkOrThrow`
        // built the emulated tool set with, so the harness (which rebuilds its
        // own MCP tools) cannot end up on a different row of the policy matrix.
        // Never re-resolved downstream: its `await` driver is bound to THIS
        // run's abort signal.
        ...(evalTasksSeam ? { tasks: evalTasksSeam } : {}),
        ...(extraHeaders ? { extraHeaders } : {}),
      });
    const testPromises = tests.map((test) =>
      // Cap concurrent headless browsers for every model-free render check
      // (legacy widget_probe OR a unified case whose turns are all pinned),
      // not just the legacy discriminator — otherwise a monitoring suite of
      // new pinned-only cases launches one Chromium per case at once.
      isPinnedOnly({
        caseType: test.caseType,
        promptTurns: resolveEvalTestCase(test).promptTurns,
      })
        ? renderCheckLimit(() => runOne(test))
        : runOne(test),
    );

    // Poll the run status: user cancellation, or a `timed_out` status set
    // elsewhere (e.g. a sibling worker), both abort the run with a reason.
    const createCancellationChecker = async () => {
      if (runId === null) return; // Quick runs can't be cancelled

      while (!stopControls) {
        await delay(EVAL_CANCEL_POLL_MS);
        if (stopControls) return;
        try {
          const currentRun = await convexClient.query(
            "testSuites:getTestSuiteRun" as any,
            { runId },
          );
          if (currentRun?.status === "cancelled") {
            abortRun(RUN_CANCELLED_ERROR);
            throw RUN_CANCELLED_ERROR;
          }
          if (currentRun?.status === "timed_out") {
            abortRun(RUN_TIMEOUT_ERROR);
            throw RUN_TIMEOUT_ERROR;
          }
        } catch (error) {
          if (isEvalRunStoppedError(error)) {
            throw error;
          }
          // If run not found, it was deleted - treat as cancelled
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          if (
            errorMessage.includes("not found") ||
            errorMessage.includes("unauthorized")
          ) {
            abortRun(RUN_CANCELLED_ERROR);
            throw RUN_CANCELLED_ERROR;
          }
        }
      }
    };

    // Periodic liveness ping so the run isn't reaped as stalled while working.
    const createHeartbeatLoop = async () => {
      if (runId === null) return;
      while (!stopControls) {
        try {
          await convexClient.mutation(
            "testSuites:heartbeatTestSuiteRun" as any,
            { runId },
          );
        } catch (error) {
          logger.warn("[evals] Failed to heartbeat eval run", {
            runId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await delay(EVAL_HEARTBEAT_MS);
      }
    };

    // Hard whole-run timeout: aborts in-flight work and rejects the race.
    // Returns Promise<never> (only ever rejects) so the race result type stays
    // PromiseSettledResult[].
    const createRunTimeout = (): Promise<never> =>
      new Promise<never>((_, reject) => {
        runTimeoutId = setTimeout(() => {
          abortRun(RUN_TIMEOUT_ERROR);
          reject(RUN_TIMEOUT_ERROR);
        }, EVAL_RUN_TIMEOUT_MS);
      });

    // Surface an `EvalRunStoppedError` thrown by ANY iteration immediately
    // (e.g. a per-iteration timeout). `Promise.allSettled` would otherwise
    // swallow it, so the run-level race would never see the stop.
    const never = () => new Promise<never>(() => {});
    const firstLifecycleStop = Promise.race(
      testPromises.map((promise) =>
        promise.then(never, (error) => {
          if (isEvalRunStoppedError(error)) {
            throw error;
          }
          return never();
        }),
      ),
    );
    const allTestsSettled = Promise.allSettled(testPromises);

    let results: PromiseSettledResult<EvalIterationOutcome[]>[];
    const heartbeatLoop = createHeartbeatLoop().catch((error) => {
      logger.warn("[evals] Eval heartbeat loop stopped unexpectedly", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    try {
      // Race tests completing, a lifecycle stop from an iteration, user
      // cancellation, and the hard run timeout.
      results = await Promise.race([
        Promise.race([allTestsSettled, firstLifecycleStop]),
        createCancellationChecker().then(() => {
          // This will never resolve, only reject if cancelled
          return new Promise<never>(() => {});
        }),
        createRunTimeout(),
      ]);
    } catch (error) {
      if (isEvalRunStoppedError(error)) {
        logger.debug("[evals] Run stopped by lifecycle guard", {
          reason: error.stopReason,
        });

        // Give in-flight iterations a brief grace to settle after the abort
        // before we finalize, so partial rows can flush.
        await Promise.race([
          Promise.allSettled(testPromises),
          delay(EVAL_ABORT_GRACE_MS),
        ]);
        if (recorder) {
          await recorder.finalize({
            status: error.terminalStatus,
            notes: error.notes,
            stopReason: error.stopReason,
          });
        }
        return undefined;
      }
      throw error;
    } finally {
      stopControls = true;
      if (runTimeoutId) {
        clearTimeout(runTimeoutId);
      }
      void heartbeatLoop;
    }

    const quickRunOutcomes: EvalIterationOutcome[] = [];

    // Aggregate results from all tests
    for (const result of results) {
      if (result.status === "fulfilled") {
        const outcomes = result.value;
        for (const { evaluation } of outcomes) {
          summary.total += 1;
          if (evaluation.passed) {
            summary.passed += 1;
          } else {
            summary.failed += 1;
          }
        }
        summary.policyBlockedIterations += outcomes.filter(
          (outcome) => (outcome.policyBlockCount ?? 0) > 0,
        ).length;
        if (runId === null) {
          quickRunOutcomes.push(...outcomes);
        }
      } else {
        // Test failed entirely - log error but continue
        logger.error("[evals] Test case failed:", result.reason);
        // Count as one failed test
        summary.total += 1;
        summary.failed += 1;
      }
    }

    const passRate = summary.total > 0 ? summary.passed / summary.total : 0;

    // Only finalize if we have a recorder (suite runs, not quick runs)
    if (recorder) {
      await recorder.finalize({
        status: "completed",
        summary: {
          total: summary.total,
          passed: summary.passed,
          failed: summary.failed,
          passRate,
          ...(summary.policyBlockedIterations > 0
            ? { policyBlockedIterations: summary.policyBlockedIterations }
            : {}),
        },
      });
    }

    if (runId === null) {
      return { quickRunIterationOutcomes: quickRunOutcomes };
    }
    return undefined;
  } catch (error) {
    const passRate = summary.total > 0 ? summary.passed / summary.total : 0;
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Persist evidence onto every still-pending row BEFORE finalize so
    // `blockTerminal` cannot strand the run, and so the sweep cannot strip
    // stage metadata from a row whose write failed.
    if (runId !== null) {
      try {
        await persistRunSetupFailure({
          runId,
          convexClient,
          recorder,
          observer: setupObserver,
          errorMessage,
          tests,
          runStartedAt: runSetupStartedAt,
        });
      } catch (setupPersistError) {
        logger.warn("[evals] Failed to persist run-setup failure evidence", {
          runId,
          error:
            setupPersistError instanceof Error
              ? setupPersistError.message
              : String(setupPersistError),
        });
      }
    }

    // Only finalize if we have a recorder (suite runs, not quick runs)
    if (recorder) {
      await recorder.finalize({
        status: "failed",
        summary:
          summary.total > 0
            ? {
                total: summary.total,
                passed: summary.passed,
                failed: summary.failed,
                passRate,
              }
            : undefined,
      });
    }

    throw error;
  }
};

export type StreamEmit = (event: EvalStreamEvent) => void;

/**
 * COMP-17: resolve + seed this iteration's case attachments into the fresh
 * sandbox, then splice the COMP-14 note into the case's first model turn.
 * Shared by both iteration runners (local-BYOK + hosted) so the
 * resolve→seed→note-injection sequence can't drift between them. Mutates
 * `promptTurns` in place (each caller builds its own copy per iteration, so
 * this stays iteration-local); fail-honest — a seed failure throws.
 */
async function seedAndAnnotateEvalAttachments(args: {
  bearer: string;
  runId: string;
  testCaseId: string | undefined;
  sandboxId: string;
  promptTurns: PromptTurn[];
  signal?: AbortSignal;
}): Promise<void> {
  const seeded = await seedEvalCaseAttachments({
    bearer: args.bearer,
    runId: args.runId,
    testCaseId: args.testCaseId,
    sandboxId: args.sandboxId,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!seeded.note) return;
  const firstModelTurnIndex = args.promptTurns.findIndex(
    (t) => !isPinnedTurn(t),
  );
  if (firstModelTurnIndex < 0) return;
  args.promptTurns[firstModelTurnIndex] = {
    ...args.promptTurns[firstModelTurnIndex],
    prompt: `${args.promptTurns[firstModelTurnIndex].prompt}\n\n${seeded.note}`,
  };
}

// PR6: the single local (BYOK) iteration runner for BOTH quick-run modes.
// `emit` present ⇒ streaming (SSE sinks built per turn); absent ⇒ batch (no
// sinks → driveLocalEvalTurn runs headless via a no-op terminal). Replaces the
// former runIterationWithAiSdk + streamIterationWithAiSdk pair, which differed
// only in SSE emission.
const runLocalIteration = async ({
  test,
  runIndex,
  // Suite-level raw set retained for `toolSignals`; per-iteration tool prep
  // is delegated to prepareChatV2 below.
  tools: _suiteTools,
  selectedServers,
  mcpClientManager,
  recorder,
  testCaseId,
  suiteId,
  modelDefinition,
  modelApiKeys,
  orgModelConfig,
  convexClient,
  runId,
  abortSignal,
  emit,
  compareRunId,
  toolDescriptionOverride,
  precreatedIterationId,
  injectOpenAiCompat,
  hostPolicy,
  gradingMode,
  toolSignals,
  setupSignals,
  setupSpans,
  setupAudit,
  suiteHostConfig,
  environment,
  convexAuthToken,
  pinnedSkillSource,
  toolPolicy,
  toolAnnotations,
  toolPolicyWarnings,
  benchmarkWriteGuard,
}: RunIterationAiSdkParams & {
  emit?: StreamEmit;
}): Promise<EvalIterationOutcome> => {
  const resolvedTest = resolveEvalTestCase(test);
  const toolPolicyGate = resolveEnforcementGate({
    ...(toolPolicy ? { toolPolicy } : {}),
    ...(benchmarkWriteGuard ? { benchmarkWriteGuard } : {}),
    ...((testCaseId ?? test.testCaseId)
      ? { testCaseId: testCaseId ?? test.testCaseId }
      : {}),
    runIndex,
    annotations: toolAnnotations ?? new Map(),
    ...(toolPolicyWarnings ? { warnings: toolPolicyWarnings } : {}),
  });

  // Check if run was cancelled before starting iteration
  if (runId !== null) {
    try {
      const currentRun = await convexClient.query(
        "testSuites:getTestSuiteRun" as any,
        { runId },
      );
      if (currentRun?.status === "cancelled") {
        return {
          // A cancelled / deleted-run iteration never executed — never score it
          // as passed. evaluateMultiTurnResults returns passed:true for an
          // all-pinned case with no calls, so override explicitly.
          evaluation: {
            ...evaluateMultiTurnResults(
              resolvedTest.promptTurns,
              [],
              test.isNegativeTest,
              test.matchOptions,
            ),
            passed: false,
          },
          iterationId: undefined,
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes("not found") ||
        errorMessage.includes("unauthorized")
      ) {
        return {
          // A cancelled / deleted-run iteration never executed — never score it
          // as passed. evaluateMultiTurnResults returns passed:true for an
          // all-pinned case with no calls, so override explicitly.
          evaluation: {
            ...evaluateMultiTurnResults(
              resolvedTest.promptTurns,
              [],
              test.isNegativeTest,
              test.matchOptions,
            ),
            passed: false,
          },
          iterationId: undefined,
        };
      }
    }
  }

  const {
    advancedConfig,
    query,
    expectedToolCalls,
    expectedOutput,
    promptTurns,
  } = resolvedTest;
  // PR 4d of the engine consolidation (`~/mcpjam-docs/unification.md`):
  // resolve `systemPrompt` and `temperature` via the shared
  // `resolveExecutionContext` so the suite-level hostConfig's
  // `systemPrompt` / `temperature` act as defaults under the per-case
  // `advancedConfig` overrides. Pre-4d the runner ignored
  // `suiteHostConfig.systemPrompt` / `.temperature` entirely — even
  // though the eval client deliberately omits suite defaults from per-case
  // advancedConfig (see comment at
  // `client/src/components/evals/use-eval-handlers.ts:302`) on the
  // understanding that the runtime applies them. `override-wins`
  // precedence keeps per-case overrides authoritative; the hostConfig
  // fills the gap when the per-case value is absent.
  //
  // `withHostContextSystemPrompt` runs AFTER the resolver because
  // `{{var}}` substitution context is per-RUN
  // (`test.hostConfigOverride.hostContext`), not part of the suite
  // hostConfig.
  const resolvedExecution = resolveExecutionContext({
    hostConfig: suiteHostConfig ?? null,
    overrides: {
      systemPrompt:
        typeof advancedConfig?.system === "string"
          ? advancedConfig.system
          : undefined,
      temperature:
        typeof advancedConfig?.temperature === "number"
          ? advancedConfig.temperature
          : undefined,
    },
    precedence: "override-wins",
  });
  const skillsSource = resolveIterationSkillsSource({
    harness: resolvedExecution.harness,
    pinnedSkillSource,
  });
  const system = withHostContextSystemPrompt(
    resolvedExecution.systemPrompt,
    test.hostConfigOverride?.hostContext as Record<string, unknown> | undefined,
  );
  const temperature = resolvedExecution.temperature;
  const toolChoice = normalizeToolChoice(advancedConfig?.toolChoice);

  // A case whose turns are ALL pinned tool calls is model-free: every
  // model/BYOK setup step below is skipped (a pinned-only case carries
  // display-only model sentinels that must never reach the runtime resolver,
  // which throws on a missing API key). Hybrid cases keep full model setup;
  // their pinned turns run via runPinnedTurn inside the loop.
  const caseNeedsModel = turnsNeedModel({
    caseType: test.caseType,
    promptTurns,
  });
  // First pinned turn's render-budget override; applied to the shared harness.
  const pinnedRenderTimeoutMs = promptTurns.find(
    (t) =>
      isPinnedTurn(t) && typeof t.pinnedToolCall?.renderTimeoutMs === "number",
  )?.pinnedToolCall?.renderTimeoutMs;

  const modelRuntime = caseNeedsModel
    ? resolveEvalModelRuntime({
        test,
        modelDefinition,
        modelApiKeys,
        orgModelConfig,
      })
    : null;

  const runStartedAt = Date.now();
  const iterationMetadataBase: IterationMetadataBase = {};
  if (promptTurns.length > 1) {
    iterationMetadataBase.multiTurn = true;
  }
  if (runId === null && compareRunId) {
    iterationMetadataBase.compareRunId = compareRunId;
  }
  const resolvedSteps = resolveSteps(test);
  const testCaseSnapshot = {
    title: test.title,
    query,
    provider: test.provider,
    model: test.model,
    runs: test.runs,
    repetitions: test.repetitions,
    passThreshold: test.passThreshold,
    expectedToolCalls,
    isNegativeTest: test.isNegativeTest,
    expectedOutput,
    ...(test.intent !== undefined ? { intent: test.intent } : {}),
    steps: resolvedSteps,
    advancedConfig,
    matchOptions: test.matchOptions,
    hostConfigOverride: test.hostConfigOverride,
  };
  const iterationParamsBase = {
    testCaseId: test.testCaseId ?? testCaseId,
    iterationNumber: runIndex + 1,
    startedAt: runStartedAt,
  };
  const shouldOmitSnapshotForPairing =
    !caseNeedsModel &&
    (precreatedIterationId !== undefined || recorder !== null);
  const iterationParams = {
    ...iterationParamsBase,
    // Model-free (pinned-only) iterations omit the testCaseSnapshot so the
    // recorder pairs the pre-created row by testCaseId + iterationNumber. The
    // snapshot's query is synthesized ("Pinned tool call: …") and would never
    // match the pre-created row's stored query, leaving the row unpaired and
    // perpetually pending. Mirrors the old probe path, which passed no snapshot.
    ...(shouldOmitSnapshotForPairing ? {} : { testCaseSnapshot }),
  };

  const iterationId = precreatedIterationId
    ? precreatedIterationId
    : recorder
      ? await recorder.startIteration(iterationParams)
      : await createIterationDirectly(convexClient, {
          ...iterationParamsBase,
          testCaseSnapshot,
        });

  // PR2: shared per-iteration accumulator (mirrors the batch runner). The
  // streaming runner threads it through `driveLocalEvalTurn` and reads it
  // post-loop / in the catch. `conversationMessages` starts empty; the system
  // is carried out-of-band via `withSystemPrefix` (SSE) + persistence. Pinned
  // fields stay empty/false here (streaming quick-run rejects pinned/model-free
  // up front in `streamTestCase` until PR5).
  const acc: LocalEvalTurnAcc = {
    conversationMessages: [],
    capturedSpans: [],
    accumulatedUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    toolsCalledByPrompt: [],
    assistantMessageByPrompt: [],
    toolErrorsByPrompt: [],
    pinnedToolErrors: [],
    activePromptIndex: -1,
    activePromptInputMessages: [],
    activePartialResponseMessages: [],
    activeCompletedStepCount: 0,
    activeTraceCtx: null,
    iterationError: undefined,
    iterationErrorDetails: undefined,
    stepErrorSource: undefined,
    pinnedSetupFailure: false,
  };
  // PR 4d review fix (CodeRabbit): hoisted so persistence sites in the
  // success + catch paths can prepend the resolved system prompt to
  // the messages array. Mirrors `enhancedSystemPromptForPersist` in
  // `runIterationWithAiSdk`. Empty when `prepareChatV2` throws before
  // returning.
  let streamEnhancedSystemPromptForPersist: string | undefined = undefined;
  // PR 4d review fix (Cursor Low "Stream snapshots drop system prompt"):
  // PR 4d dropped the `conversationMessages.push({role:"system"})` in
  // this runner, but `buildTraceSnapshotEvent` reads from those arrays
  // mid-run — live SSE traces during a streamed quick run no longer
  // include the resolved system until the final persistence prepend.
  // Wrap message slices with the system prefix everywhere the SSE
  // snapshot consumes them so trace UI viewers see the system as the
  // first message throughout the run.
  const withSystemPrefix = (msgs: ModelMessage[]): ModelMessage[] =>
    streamEnhancedSystemPromptForPersist
      ? [
          {
            role: "system",
            content: streamEnhancedSystemPromptForPersist,
          },
          ...msgs,
        ]
      : msgs;

  // Browser-rendered MCP App eval (PR 9): mirror runIterationWithAiSdk on the
  // streamed path — render MCP App tool results in the headless-Chromium harness
  // and (for models with vision + tool calling) drive them with Computer
  // Use. Declared BEFORE the
  // try so the finally can dispose even on a mid-stream abort.
  const browser = await createBrowserSessionContext({
    // Model-free (pinned-only) iterations pass no model: no Computer Use, but
    // the harness still renders pinned widgets and records observations.
    ...(caseNeedsModel ? { model: test.model } : {}),
    mcpClientManager,
    injectOpenAiCompat,
    ...(pinnedRenderTimeoutMs
      ? { renderTimeoutMs: pinnedRenderTimeoutMs }
      : {}),
  });

  // Reproducible-evals sandbox: provisioned per-iteration inside the try (so a
  // failure is a recorded failed iteration), released in the finally. Declared
  // here so the finally always sees it.
  let evalSandbox: Awaited<ReturnType<typeof provisionEvalSandbox>> | null =
    null;
  // D7: `prepared` (and its `allTools`) is declared inside the try below, so
  // it is out of scope in the catch's own `buildIterationFinishParams` call.
  // Captured here, set once `prepared` is assigned, so BOTH the success and
  // the failure path can attach the tool set the model actually chose
  // between when selection failed mid-run.
  let selectionToolsForFinish: PrepareChatV2Result["allTools"] | undefined;
  // Captured alongside `selectionToolsForFinish` at the same assignment
  // point, but read lazily at each usage site below (both are live
  // references into `prepared` — `discoveryState` mutates in place as the
  // turn's steps run) so the narrowing reflects state AFTER the turn
  // finishes, not the empty state at prepareChatV2 return time.
  let selectionDiscoveryForFinish:
    | {
        progressivePlan: PrepareChatV2Result["progressivePlan"];
        discoveryState: PrepareChatV2Result["discoveryState"];
      }
    | undefined;

  try {
    // See `runIterationWithAiSdk`: adopt the chat-side pipeline inside the try
    // so prep failures become a recorded failed iteration. Like that runner,
    // `builtInTools` stays absent on the local BYOK path (no Convex auth to
    // bill web_search against) — the null-ctx call just debug-logs requests.
    // Model-free (pinned-only) iterations skip tool/system/model prep — see
    // `runIterationWithAiSdk`. `prepared`/`llmModel` stay null and are only
    // read inside the model-turn branch, unreachable when caseNeedsModel false.
    let prepared: PrepareChatV2Result | null = null;
    let llmModel: ReturnType<typeof createLlmModel> | null = null;
    if (caseNeedsModel) {
      throwIfDescriptionOverrideOnHarness(
        toolDescriptionOverride,
        resolvedExecution.harness,
      );
      resolveHostTools(
        { builtInToolIds: resolvedExecution.builtInToolIds },
        null,
      );
      prepared = await prepareChatV2({
        mcpClientManager,
        selectedServers,
        modelDefinition,
        systemPrompt: system,
        temperature,
        respectToolVisibility: hostPolicy?.respectToolVisibility,
        modelVisibleMcpToolResults: hostPolicy?.modelVisibleMcpToolResults,
        ...(resolvedExecution.harness
          ? { harness: resolvedExecution.harness }
          : {}),
        ...(descriptionOverridesFromMarker(toolDescriptionOverride)
          ? {
              toolDescriptionOverrides: descriptionOverridesFromMarker(
                toolDescriptionOverride,
              ),
            }
          : {}),
        skillsSource,
        // Host progressive-discovery toggle, same conversion as the chat-v2
        // routes and the session-sim runner. Only an explicit host value is
        // forwarded — absent stays undefined so prepareChatV2 keeps its
        // "auto" threshold behavior.
        ...(resolvedExecution.progressiveToolDiscovery !== undefined
          ? {
              progressiveToolDiscovery: {
                enabled: resolvedExecution.progressiveToolDiscovery,
              },
            }
          : {}),
        customProviders: modelRuntime!.customProviders,
        priorMessages: [],
      });
      // PR 4d review fix (CodeRabbit "Use the dedicated system: field in
      // streamIterationWithAiSdk"): align the streaming local-BYOK runner
      // with the non-stream variant's chat-aligned shape. Pre-fix this
      // runner pushed the system into `conversationMessages` AND omitted
      // `system:` on the `streamText({...})` call below, so a streamed
      // eval and a non-stream eval of the same case produced different
      // transcript shapes. Now the system flows via the dedicated
      // `system:` field, the runner-side `conversationMessages` stays
      // system-free, and persistence prepends the resolved value at write
      // time (mirroring the non-stream runner's PR 4d Codex P2 fix).
      streamEnhancedSystemPromptForPersist = prepared.enhancedSystemPrompt;
      if (toolDescriptionOverride) {
        stampDescriptionExperiment(
          iterationMetadataBase,
          toolDescriptionOverride,
          descriptionAppliedOnPreparedTools(
            prepared.allTools,
            toolDescriptionOverride,
          ),
        );
      }
      selectionToolsForFinish = prepared.allTools;
      selectionDiscoveryForFinish = {
        progressivePlan: prepared.progressivePlan,
        discoveryState: prepared.discoveryState,
      };

      llmModel = createLlmModel(
        modelDefinition,
        modelRuntime!.apiKey,
        modelRuntime!.baseUrls,
        modelRuntime!.customProviders,
      );

      // Reproducible evals: boot a fresh ephemeral sandbox from the suite's
      // pinned image and expose it to the agent as a `bash` tool. The personal
      // computer stays banned; this is the per-iteration reproducible path. A
      // provision failure becomes a recorded failed iteration (we're in the
      // try); the finally releases the box. Runs BEFORE the toolChoice check
      // below so a forced `toolChoice: { toolName: "bash" }` on a pinned-env run
      // sees `bash` in `prepared.allTools` instead of failing "not available".
      //
      // This whole block is under `caseNeedsModel` BY DESIGN: a model-free
      // (pinned-only) iteration has no agent turn, so nothing would ever invoke
      // the bash tool — provisioning a paid sandbox for it would be pure waste.
      const pinnedEnvironmentId = (
        environment as { computerEnvironmentId?: string } | undefined
      )?.computerEnvironmentId;
      if (pinnedEnvironmentId && runId !== null) {
        // Don't provision unless this server is a fully-configured data plane.
        // Provisioning only needs the user bearer, but EXEC needs E2B_API_KEY
        // and RELEASE needs a server-to-server credential — without them
        // releaseEvalSandbox silently no-ops, so each iteration would boot a
        // paid box only the backend TTL GC could reap. Fail loudly instead.
        if (!isComputersDataPlaneConfigured()) {
          throw new Error(
            "This eval pins a reproducible computer environment, but this server isn't a computers data plane (deployed servers bootstrap credentials from INSPECTOR_SERVICE_TOKEN; see docs/project-computers.md) — it could provision a sandbox but not exec or release it.",
          );
        }
        evalSandbox = await provisionEvalSandbox({
          bearer: convexAuthToken,
          runId: String(runId),
          ...(iterationId ? { iterationId: String(iterationId) } : {}),
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        if (!evalSandbox.ok) {
          throw new Error(
            `Could not provision the eval's reproducible sandbox: ${evalSandbox.error}`,
          );
        }
        // COMP-17: seed the case's pinned attachments into the fresh box before
        // it's exposed as `bash`. Runs BEFORE buildEvalBashTool so the model's
        // first turn already sees the files. Fail-honest — a seed failure throws
        // (we're inside the try) and becomes a recorded failed iteration rather
        // than a silent run without the files.
        await seedAndAnnotateEvalAttachments({
          bearer: convexAuthToken,
          runId: String(runId),
          testCaseId: test.testCaseId,
          sandboxId: evalSandbox.value.sandboxId,
          promptTurns,
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        prepared.allTools[EVAL_BASH_TOOL_NAME] = buildEvalBashTool({
          sandboxId: evalSandbox.value.sandboxId,
        });
      }

      if (
        toolChoice &&
        typeof toolChoice === "object" &&
        !Object.hasOwn(prepared.allTools, toolChoice.toolName) &&
        // `computer` / `finish_widget` are merged into the tool map below, so a
        // forced tool choice naming one of them is valid on computer-capable drivers.
        !Object.hasOwn(browser.computerWidgetTools, toolChoice.toolName)
      ) {
        throw new Error(
          `Configured tool choice '${toolChoice.toolName}' is not available for this eval run.`,
        );
      }
    }

    // PR 5a abort helpers — mirror the non-stream runner's pattern so
    // a cancellation between consume and check drops the iteration
    // record without persisting cancelled state.
    const localIsAborted = () => abortSignal?.aborted === true;
    const returnLocalCancelled = () => ({
      // Aborted mid-iteration — never score as passed (a pinned-only case would
      // otherwise short-circuit to passed:true).
      evaluation: {
        ...evaluateMultiTurnResults(
          promptTurns,
          acc.toolsCalledByPrompt,
          test.isNegativeTest,
          test.matchOptions,
        ),
        passed: false,
      },
      iterationId: undefined,
    });

    // Streaming play-by-play, built once and consumed by the executeSteps handlers
    // (per turn). `undefined` in batch mode (no `emit`) → headless. The per-turn
    // `step_status` it emits coexists with executeSteps' per-step status (different
    // reducer keys; the editor prefers per-step).
    const makeSinks:
      ((turnIndex: number, prompt: string) => LocalEvalTurnSinks) | undefined =
      emit
        ? (turnIndex, prompt) => ({
            emit,
            getStepIndex: () => acc.activeCompletedStepCount,
            onTurnStart: () => {
              emit({ type: "turn_start", turnIndex, prompt });
              emit({
                type: "step_status",
                turnIndex,
                kind: "prompt",
                status: "running",
              });
            },
            onStepSnapshot: ({ stepIndex, messages, spans, usage }) => {
              emit(
                buildTraceSnapshotEvent({
                  turnIndex,
                  stepIndex,
                  snapshotKind: "step_finish",
                  messages: withSystemPrefix(messages),
                  spans,
                  actualToolCalls: extractToolCallsFromConversation({
                    messages,
                  }),
                  usage,
                }),
              );
            },
            onTurnFailure: ({
              messages,
              spans,
              usage,
              stepIndex,
              iterationError: turnError,
            }) => {
              emit(
                buildTraceSnapshotEvent({
                  turnIndex,
                  ...(stepIndex != null ? { stepIndex } : {}),
                  snapshotKind: "failure",
                  messages: withSystemPrefix(messages),
                  spans,
                  actualToolCalls: extractToolCallsFromConversation({
                    messages,
                  }),
                  usage,
                }),
              );
              emit({
                type: "step_status",
                turnIndex,
                kind: "prompt",
                status: "fail",
                detail: turnError,
              });
              emit({ type: "error", message: turnError });
            },
            onTurnSuccess: ({ messages, spans, usage }) => {
              emit(
                buildTraceSnapshotEvent({
                  turnIndex,
                  snapshotKind: "turn_finish",
                  messages: withSystemPrefix(messages),
                  spans,
                  actualToolCalls: extractToolCallsFromConversation({
                    messages,
                  }),
                  usage,
                }),
              );
              emit({ type: "turn_finish", turnIndex });
              emit({
                type: "step_status",
                turnIndex,
                kind: "prompt",
                status: "ok",
              });
            },
            onPinnedTurn: (ctx) =>
              emitPinnedTurnSse(
                { emit, withSystemPrefix, buildTraceSnapshotEvent },
                { turnIndex, ...ctx },
              ),
          })
        : undefined;

    // Fail-fast skipped steps (PR6) → persisted to metadata.skippedSteps.
    let stepSkippedSteps: unknown[] = [];
    // One verdict row per authored step → persisted to metadata.stepResults
    // (the clean per-step contract the public /steps API projects).
    let stepResults: unknown[] = [];
    // §2: failed interact / widget-DOM-assert steps recorded in StepExecutionState
    // (not in browser.scriptedCheckFailures) — folded into the verdict's
    // scripted-check gate so they actually fail the iteration.
    let stepScriptedFailures: { toolName: string; reason: string }[] = [];
    // Drive the iteration through the sequential executeSteps engine: the handlers
    // wrap driveLocalEvalTurn (which mutates `acc`), so the post-loop verdict +
    // finishParams below consume `acc` + the executor's StepExecutionState.
    const steps = resolveSteps(test);
    const stepHandlers = buildLocalStepHandlers({
      acc,
      browser,
      mcpClientManager,
      selectedServers,
      resolvePinnedServerKey: (pinned) =>
        resolvePinnedServerKey(
          pinned,
          environment,
          selectedServers,
          mcpClientManager,
        ),
      prepared,
      llmModel,
      test,
      runStartedAt,
      runIndex,
      iterationId,
      suiteId,
      runId,
      testCaseId,
      abortSignal,
      toolChoice,
      toolPolicyGate,
      extractToolCalls: (params) =>
        extractToolCallsExcludingPolicyBlocks(
          params,
          toolPolicyGate?.blockedToolCallIds() ?? new Set(),
        ),
      // Per-turn streaming play-by-play (headless in batch).
      buildSinks: makeSinks,
    });
    const stepState = createStepExecutionState();
    await executeSteps({
      steps,
      state: stepState,
      browser,
      handlers: stepHandlers,
      isAborted: localIsAborted,
      // PR5: per-step status → SSE (keyed by stepId for per-card ticking).
      ...(emit
        ? {
            onStepStatus: (e) =>
              emit({
                type: "step_status",
                turnIndex: e.turnOrdinal,
                stepId: e.stepId,
                kind: e.kind,
                status: e.status,
              }),
          }
        : {}),
    });
    // Fail-fast skipped steps (PR6) → persisted to metadata.skippedSteps.
    stepSkippedSteps = stepState.skippedSteps;
    // One verdict row per authored step → metadata.stepResults.
    stepResults = buildStepResultRecords(stepState, steps);
    // §2: interact / widget-assert failures → the scripted-check gate below.
    stepScriptedFailures = buildStepScriptedCheckFailures(stepState);
    if (localIsAborted()) return returnLocalCancelled();

    // Widget→host tool calls (a tool a widget invoked, e.g. from an authored
    // click) live outside the model transcript. Fold them into each turn's
    // actual-call set ONCE here, so a single "tool was called" check sees them
    // whether it's authored as an expected tool call (matcher, below) OR as a
    // predicate (per-turn `checks` + case-level, which read `evaluation`'s
    // flattened calls). Widget calls are real tool calls, so they participate in
    // matching uniformly — including counting as actuals for extras/negative
    // accounting (a click that fires a tool the case forbade SHOULD fail it).
    const toolsCalledByPromptWithWidgets = mergeToolCallsByPromptIndex(
      acc.toolsCalledByPrompt,
      widgetToolCallsByPromptIndex(browser.browserInteractionSteps),
    );
    // Per-turn predicate results from step assert execution facts (not a
    // re-evaluation of promptTurns.checks — avoids duplicates vs executeSteps).
    const turnCheckResults = resolveTurnCheckResultsFromStepExecution(
      stepState,
      steps,
    );
    const failOnToolError =
      (advancedConfig as { failOnToolError?: boolean } | undefined)
        ?.failOnToolError !== false;
    const traceForGate =
      acc.capturedSpans.length > 0 || acc.conversationMessages.length > 0
        ? {
            ...(acc.capturedSpans.length > 0
              ? { spans: acc.capturedSpans }
              : {}),
            messages: acc.conversationMessages as ModelMessage[] as Array<{
              role: string;
              content: unknown;
            }>,
          }
        : undefined;
    // A pinned-only case (render check) with no authored predicates defaults to
    // "the widget rendered" — the model-free equivalent of the legacy probe
    // verdict. Mirrors the former runIterationWithAiSdk post-loop.
    const effectivePredicates = test.successPredicates?.length
      ? test.successPredicates
      : isPinnedOnly({ caseType: test.caseType, promptTurns })
        ? ([{ type: "widgetRendered" }] as NonNullable<
            typeof test.successPredicates
          >)
        : undefined;
    // Flush the last turn's groups so a trailing turn's unrun checks still fail
    // closed, before the shared verdict reads scripted-check failures. (Flush
    // only mutates `scriptedCheckFailures`, which no earlier gate reads, so
    // doing it here is equivalent to the former post-finalize position.)
    browser.flushActiveWidgetChecks();
    // Single verdict boundary — matcher + case predicates + ordering + all gates.
    const { evaluation, passed, predicateResults } = buildEvalIterationVerdict({
      promptTurns,
      toolsCalledByPrompt: toolsCalledByPromptWithWidgets,
      isNegativeTest: test.isNegativeTest,
      matchOptions: test.matchOptions,
      // Skill-tool calls are exempt from tool-call expectations (a skill load is
      // agent housekeeping); active only when skill tools were advertised.
      skillToolsActive: hasSkillTools(Object.keys(prepared?.allTools ?? {})),
      turnCheckResults,
      effectivePredicates,
      trace: traceForGate,
      usage: hasReportedUsage(acc.accumulatedUsage)
        ? acc.accumulatedUsage
        : undefined,
      renderObservations: summarizeRenderObservations(
        browser.widgetRenderObservations,
      ),
      toolErrors: acc.pinnedToolErrors,
      iterationError: acc.iterationError,
      failOnToolError,
      pinnedToolErrors: acc.pinnedToolErrors,
      // §2: legacy push-model failures + executeSteps interact/widget-assert failures.
      scriptedCheckFailures: [
        ...browser.scriptedCheckFailures,
        ...stepScriptedFailures,
      ],
    });
    const promptTraceSummaries = buildPromptTraceSummaries(
      evaluation,
      turnCheckResults,
    );
    // Reflect the gated verdict (match AND tool-error gate AND predicates) in
    // the returned evaluation so totals built from `evaluation.passed` agree
    // with the persisted iteration result.
    evaluation.passed = passed;

    const usageFinal: UsageTotals = {
      inputTokens: acc.accumulatedUsage.inputTokens,
      outputTokens: acc.accumulatedUsage.outputTokens,
      totalTokens: acc.accumulatedUsage.totalTokens,
    };
    const widgetSnapshots = await captureMcpAppWidgetSnapshots({
      injectOpenAiCompat,
      messages: acc.conversationMessages,
      mcpClientManager,
      convexClient,
    });
    // PR (this change): the resolved system prompt now flows through
    // `appendEvalTurnTrace.systemPrompt`. The `withSystemPrefix`
    // closure above still applies the prefix to LIVE SSE
    // `trace_snapshot` events for the test-runner UI (different
    // consumer than the stored transcript).
    const finishParams = buildIterationFinishParams({
      iterationId,
      // The layer that failed, when this driver could tell — the local twin of
      // the hosted path's `stepError`. Without it a local-BYOK trial that died
      // on the model call finalizes uncategorised, which is the very failure
      // the provider-error work removed on the hosted path.
      ...(acc.stepErrorSource
        ? { stepError: { source: acc.stepErrorSource } }
        : {}),
      // Keys shadow-mismatch telemetry only; never read for the verdict.
      ...(runId !== null ? { runId: String(runId) } : {}),
      // The run's FROZEN position. Threaded so a per-suite `off` is honoured on
      // THIS pass (it used to be visible only to the judge second pass, which
      // reads the run row) and so a run can reach `enforce` at all.
      ...(gradingMode ? { gradingMode } : {}),
      scoreMatchOptions: scoreMatchOptionsFor(test),
      ...(test.isNegativeTest ? { isNegativeTest: true } : {}),
      passed,
      evaluation,
      usage: usageFinal,
      messages: acc.conversationMessages,
      // Same gate as the `model` field above: a model-free case reaches this
      // runner with a DISPLAY-ONLY sentinel (`executeTestCase` hands it a
      // `pinned-only` definition and never resolves a real id), and attributing
      // the session to that sentinel would label it with a model that never ran.
      ...(caseNeedsModel ? { modelId: test.model } : {}),
      ...(streamEnhancedSystemPromptForPersist
        ? { systemPrompt: streamEnhancedSystemPromptForPersist }
        : {}),
      spans: acc.capturedSpans,
      prompts: promptTraceSummaries,
      ...(widgetSnapshots ? { widgetSnapshots } : {}),
      // PR 9: browser artifacts from the streamed Computer Use path.
      widgetRenderObservations: browser.widgetRenderObservations,
      browserInteractionSteps: browser.browserInteractionSteps,
      // A model-free pinned setup failure (server not connected) records as
      // `setup_failed` — it never reached the question; everything else
      // completes (a failed verdict is still a completed run). Mirrors the
      // former runIterationWithAiSdk.
      status: acc.pinnedSetupFailure ? "setup_failed" : "completed",
      startedAt: runStartedAt,
      // PR 5a (mirror PR 4b): if the per-turn loop set `iterationError`
      // via the failure-detection branch, surface it on the persisted
      // iteration via `status:"completed"` + `error` — the run
      // completed cleanly but the cycle failed.
      ...(acc.iterationError ? { error: acc.iterationError } : {}),
      ...(acc.iterationErrorDetails
        ? { errorDetails: acc.iterationErrorDetails }
        : {}),
      predicateResults,
      ...(toolPolicyGate?.blocks.length
        ? { policyBlocks: toolPolicyGate.blocks }
        : {}),
      ...(toolPolicyGate?.warnings.length
        ? { policyWarnings: toolPolicyGate.warnings }
        : {}),
      ...(toolPolicyGate ? { toolPolicy: toolPolicyGate.policy } : {}),
      ...(stepSkippedSteps.length ? { skippedSteps: stepSkippedSteps } : {}),
      ...(stepResults.length ? { stepResults } : {}),
      stageCase: buildStageAuthoredCase({
        test,
        // The RESOLVED steps, not `test.steps`: `resolveSteps` bridges legacy
        // `promptTurns`/probe cases into steps, and a legacy case carries no
        // `steps` of its own. Reading the raw field would drop every authored
        // assert step from `assertionCount` and report a widget-asserting case
        // as asserting nothing.
        ...(resolvedSteps.length ? { steps: resolvedSteps } : {}),
        turns: resolvedTest.promptTurns,
        caseNeedsModel,
      }),
      stageToolErrors: acc.pinnedToolErrors,
      iterationMetadataBase,
      ...(hostPolicy ? { hostPolicy } : {}),
      ...(toolSignals ? { toolSignals } : {}),
      ...(setupSignals ? { setupSignals } : {}),
      ...(setupSpans?.length ? { setupSpans } : {}),
      ...(setupAudit ? { setupAudit } : {}),
      injectOpenAiCompat,
      // D7: the per-iteration tool set the model actually chose between —
      // `prepared.allTools` (real MCP tools + meta-tools), not the
      // suite-level `_suiteTools` this runner otherwise ignores. Absent on
      // a model-free iteration (`prepared` stays null), where there is no
      // selection stage to explain anyway.
      // Narrowed to what progressive discovery actually advertised across
      // the turn, when it was enabled — see `narrowToolsToAdvertised`.
      ...(selectionToolsForFinish
        ? {
            selectionTools: selectionDiscoveryForFinish
              ? narrowToolsToAdvertised(
                  selectionToolsForFinish,
                  selectionDiscoveryForFinish.progressivePlan,
                  selectionDiscoveryForFinish.discoveryState,
                )
              : selectionToolsForFinish,
          }
        : {}),
    });
    // RE-READ THE DERIVED VERDICT so run totals agree with the persisted row.
    //
    // At `enforce` the iteration's result is the conjunction of the boolean
    // pipeline and the gating score rows, computed inside
    // `buildIterationFinishParams`. `evaluation.passed` still holds the boolean
    // one, and THAT is what `runEvalSuiteWithAiSdk` aggregates into
    // `summary.passed`/`failed`/`passRate` and what `passCriteria` is judged
    // against — so a strictness catch would persist `failed` on the iteration
    // while the run counted it a pass, and the pass rate would be inflated by
    // exactly the cases `enforce` exists to catch. Those catches are EXPECTED
    // during the soak, so this drift is reachable, not theoretical.
    //
    // Assigned AFTER the call, never before: the score rows derive the
    // `toolCalls:match` row from `evaluation.passed`, which must remain the
    // MATCHER's answer at derivation time.
    evaluation.passed = finishParams.passed;

    await finalizeIterationWithBrowserArtifacts({
      browser,
      recorder,
      convexClient,
      finishParams,
    });

    return {
      evaluation,
      iterationId: iterationId ?? undefined,
      ...(toolPolicyGate?.blocks.length
        ? { policyBlockCount: toolPolicyGate.blocks.length }
        : {}),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.debug("[evals] streaming iteration aborted due to cancellation");
      // Force passed:false (see the non-stream runner) so an all-pinned case
      // can't score a pass on abort.
      return {
        evaluation: {
          ...evaluateMultiTurnResults(
            promptTurns,
            acc.toolsCalledByPrompt,
            test.isNegativeTest,
            test.matchOptions,
          ),
          passed: false,
        },
        iterationId: undefined,
      };
    }

    logger.error("[evals] streaming iteration failed", error);

    let errorMessage: string | undefined = undefined;
    let errorDetails: string | undefined = undefined;

    if (error instanceof Error) {
      errorMessage = error.message || error.toString();

      const responseBody = (error as any).responseBody;
      if (responseBody && typeof responseBody === "string") {
        errorDetails = responseBody;
      }
    } else if (typeof error === "string") {
      errorMessage = error;
    } else {
      errorMessage = String(error);
    }

    const failAt = Date.now();
    if (acc.activeTraceCtx) {
      finalizeAiSdkTraceOnFailure(acc.activeTraceCtx, failAt, {
        completedStepCount: acc.activeCompletedStepCount,
        lastStepEndedAt: acc.activeTraceCtx.lastStepClosedEndAt,
        modelId: test.model,
        promptIndex: acc.activePromptIndex >= 0 ? acc.activePromptIndex : 0,
      });
      acc.capturedSpans.push(...acc.activeTraceCtx.recordedSpans);
    }
    appendPartialToolCallsToPrompt({
      toolsCalledByPrompt: acc.toolsCalledByPrompt,
      promptIndex: acc.activePromptIndex,
      partialResponseMessages: acc.activePartialResponseMessages,
    });
    const failMessages =
      acc.activePromptInputMessages.length > 0
        ? acc.activeCompletedStepCount > 0 ||
          acc.activePartialResponseMessages.length > 0
          ? [
              ...acc.activePromptInputMessages,
              ...acc.activePartialResponseMessages,
            ]
          : acc.activePromptInputMessages
        : acc.conversationMessages;
    const evaluation = evaluateMultiTurnResults(
      promptTurns,
      acc.toolsCalledByPrompt,
      test.isNegativeTest,
      test.matchOptions,
    );
    // Suite summary aggregates `evaluation.passed` (see runEvalSuiteWithAiSdk).
    // The persisted iteration is hard-coded `passed: false` below, but the
    // returned evaluation could still report `passed: true` on negative tests
    // or tests with no expected tools when the catch fires before any tools
    // are called — that would inflate suite-pass counts. Force false here so
    // the persisted and returned verdicts agree.
    evaluation.passed = false;
    const promptTraceSummaries = buildPromptTraceSummaries(evaluation);
    const widgetSnapshots = await captureMcpAppWidgetSnapshots({
      injectOpenAiCompat,
      messages: failMessages,
      mcpClientManager,
      convexClient,
    });

    // PR6: SSE failure signal only in streaming mode (batch has no emit).
    if (emit) {
      emit(
        buildTraceSnapshotEvent({
          turnIndex: acc.activePromptIndex >= 0 ? acc.activePromptIndex : 0,
          ...(acc.activeCompletedStepCount > 0
            ? { stepIndex: acc.activeCompletedStepCount - 1 }
            : {}),
          snapshotKind: "failure",
          messages: withSystemPrefix(failMessages),
          spans: acc.capturedSpans,
          actualToolCalls: extractToolCallsFromConversation({
            messages: failMessages,
          }),
          usage: {
            inputTokens: acc.accumulatedUsage.inputTokens,
            outputTokens: acc.accumulatedUsage.outputTokens,
            totalTokens: acc.accumulatedUsage.totalTokens,
          },
          prompts: promptTraceSummaries,
        }),
      );
      emit({
        type: "error",
        message: errorMessage ?? "Eval iteration failed",
        details: errorDetails,
      });
    }

    // PR (this change): the resolved system prompt now flows through
    // `appendEvalTurnTrace.systemPrompt`. Same threading as the
    // success path.
    const failParams = buildIterationFinishParams({
      iterationId,
      // Same as the success path: carry the layer when the driver could tell.
      // This branch is the one a model-call failure most often ends on, so
      // omitting it here would leave the fix half-applied.
      ...(acc.stepErrorSource
        ? { stepError: { source: acc.stepErrorSource } }
        : {}),
      ...(runId !== null ? { runId: String(runId) } : {}),
      ...(gradingMode ? { gradingMode } : {}),
      scoreMatchOptions: scoreMatchOptionsFor(test),
      ...(test.isNegativeTest ? { isNegativeTest: true } : {}),
      passed: false,
      evaluation,
      usage: {
        inputTokens: acc.accumulatedUsage.inputTokens,
        outputTokens: acc.accumulatedUsage.outputTokens,
        totalTokens: acc.accumulatedUsage.totalTokens,
      },
      messages: failMessages,
      // Gated exactly as on the success path: a model-free case carries a
      // DISPLAY-ONLY sentinel, and a case that throws mid-iteration must not be
      // attributed to a model it never called just because it failed rather
      // than finished.
      ...(caseNeedsModel ? { modelId: test.model } : {}),
      ...(streamEnhancedSystemPromptForPersist
        ? { systemPrompt: streamEnhancedSystemPromptForPersist }
        : {}),
      spans: acc.capturedSpans,
      prompts: promptTraceSummaries,
      ...(widgetSnapshots ? { widgetSnapshots } : {}),
      // PR 9: browser artifacts collected before the failure still persist.
      widgetRenderObservations: browser.widgetRenderObservations,
      browserInteractionSteps: browser.browserInteractionSteps,
      status: "failed",
      startedAt: runStartedAt,
      ...(toolPolicyGate?.blocks.length
        ? { policyBlocks: toolPolicyGate.blocks }
        : {}),
      ...(toolPolicyGate?.warnings.length
        ? { policyWarnings: toolPolicyGate.warnings }
        : {}),
      ...(toolPolicyGate ? { toolPolicy: toolPolicyGate.policy } : {}),
      ...(errorMessage ? { error: errorMessage } : {}),
      ...(errorDetails ? { errorDetails } : {}),
      stageCase: buildStageAuthoredCase({
        test,
        // The RESOLVED steps, not `test.steps`: `resolveSteps` bridges legacy
        // `promptTurns`/probe cases into steps, and a legacy case carries no
        // `steps` of its own. Reading the raw field would drop every authored
        // assert step from `assertionCount` and report a widget-asserting case
        // as asserting nothing.
        ...(resolvedSteps.length ? { steps: resolvedSteps } : {}),
        turns: resolvedTest.promptTurns,
        caseNeedsModel,
      }),
      stageToolErrors: acc.pinnedToolErrors,
      iterationMetadataBase,
      ...(hostPolicy ? { hostPolicy } : {}),
      ...(toolSignals ? { toolSignals } : {}),
      ...(setupSignals ? { setupSignals } : {}),
      ...(setupSpans?.length ? { setupSpans } : {}),
      ...(setupAudit ? { setupAudit } : {}),
      injectOpenAiCompat,
      // D7: the per-iteration tool set the model actually chose between —
      // `prepared.allTools` (real MCP tools + meta-tools), not the
      // suite-level `_suiteTools` this runner otherwise ignores. Absent on
      // a model-free iteration (`prepared` stays null), where there is no
      // selection stage to explain anyway.
      // Narrowed to what progressive discovery actually advertised across
      // the turn, when it was enabled — see `narrowToolsToAdvertised`.
      ...(selectionToolsForFinish
        ? {
            selectionTools: selectionDiscoveryForFinish
              ? narrowToolsToAdvertised(
                  selectionToolsForFinish,
                  selectionDiscoveryForFinish.progressivePlan,
                  selectionDiscoveryForFinish.discoveryState,
                )
              : selectionToolsForFinish,
          }
        : {}),
    });

    await finalizeIterationWithBrowserArtifacts({
      browser,
      recorder,
      convexClient,
      finishParams: failParams,
    });
    return {
      evaluation,
      iterationId: iterationId ?? undefined,
      ...(toolPolicyGate?.blocks.length
        ? { policyBlockCount: toolPolicyGate.blocks.length }
        : {}),
    };
  } finally {
    // Tear down the per-iteration eval sandbox (idempotent; GC reaps any miss).
    if (evalSandbox?.ok) {
      await releaseEvalSandbox({
        sandboxRowId: evalSandbox.value.sandboxRowId,
      }).catch(() => {});
    }
    // PR 9: tear down the harness (and its headless Chromium, if launched) on
    // success, failure, OR mid-stream abort. No-op when never constructed.
    await browser.dispose();
  }
};

// PR6: the single hosted iteration runner for BOTH quick-run modes. `emit`
// present ⇒ streaming (buildSinks wires SSE into driveHostedEvalTurn); absent ⇒
// batch (no buildSinks → driveHostedEvalTurn runs headless). Replaces the
// runIterationViaBackendWithBrowser + streamIterationViaBackendWithBrowser pair.
const runHostedIterationWithBrowser = async (
  {
    test,
    runIndex,
    // Suite-level raw set retained for `toolSignals`; per-iteration tool prep
    // is delegated to prepareChatV2 below.
    tools: _suiteTools,
    selectedServers,
    mcpClientManager,
    recorder,
    testCaseId,
    // PR 5b: `convexHttpUrl` is in the `RunIterationBackendParams` type
    // (shared with the non-stream runner + the iterative path) but
    // unused here — `runAssistantTurn` owns the Convex `/stream` fetch
    // and reads its base URL from `CONVEX_HTTP_URL` env / the configured
    // chat-orchestration helpers. Kept on the params type so the caller
    // shape stays uniform across runners.
    convexAuthToken,
    modelId,
    modelDefinition,
    orgModelConfig,
    endpointPath = "/stream",
    extraBodyFields,
    extraHeaders,
    convexClient,
    runId,
    abortSignal,
    emit,
    compareRunId,
    toolDescriptionOverride,
    precreatedIterationId,
    injectOpenAiCompat,
    hostPolicy,
    gradingMode,
    toolSignals,
    setupSignals,
    setupSpans,
    setupAudit,
    suiteHostConfig,
    orgModelConfigTarget,
    // Pinned reproducible-env id lives on the run environment; drives per-
    // iteration eval-sandbox provisioning + the bash tool (hosted parity with
    // the local runner).
    environment,
    projectEnvironmentId,
    projectEnvironmentUnresolvedReason,
    pinnedSkillSource,
    pinnedHarnessSkills,
    tasks,
    toolPolicy,
    toolAnnotations,
    toolPolicyWarnings,
    benchmarkWriteGuard,
  }: RunIterationBackendParams & {
    emit?: StreamEmit;
  },
  browser: BrowserSessionContext,
): Promise<EvalIterationOutcome> => {
  const resolvedTest = resolveEvalTestCase(test);
  const toolPolicyGate = resolveEnforcementGate({
    ...(toolPolicy ? { toolPolicy } : {}),
    ...(benchmarkWriteGuard ? { benchmarkWriteGuard } : {}),
    ...((testCaseId ?? test.testCaseId)
      ? { testCaseId: testCaseId ?? test.testCaseId }
      : {}),
    runIndex,
    annotations: toolAnnotations ?? new Map(),
    ...(toolPolicyWarnings ? { warnings: toolPolicyWarnings } : {}),
  });

  // Check if run was cancelled before starting iteration
  if (runId !== null) {
    try {
      const currentRun = await convexClient.query(
        "testSuites:getTestSuiteRun" as any,
        { runId },
      );
      if (currentRun?.status === "cancelled") {
        return {
          // A cancelled / deleted-run iteration never executed — never score it
          // as passed. evaluateMultiTurnResults returns passed:true for an
          // all-pinned case with no calls, so override explicitly.
          evaluation: {
            ...evaluateMultiTurnResults(
              resolvedTest.promptTurns,
              [],
              test.isNegativeTest,
              test.matchOptions,
            ),
            passed: false,
          },
          iterationId: undefined,
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes("not found") ||
        errorMessage.includes("unauthorized")
      ) {
        return {
          // A cancelled / deleted-run iteration never executed — never score it
          // as passed. evaluateMultiTurnResults returns passed:true for an
          // all-pinned case with no calls, so override explicitly.
          evaluation: {
            ...evaluateMultiTurnResults(
              resolvedTest.promptTurns,
              [],
              test.isNegativeTest,
              test.matchOptions,
            ),
            passed: false,
          },
          iterationId: undefined,
        };
      }
    }
  }

  const {
    query,
    expectedToolCalls,
    expectedOutput,
    promptTurns,
    advancedConfig,
  } = resolvedTest;
  // PR 4d of the engine consolidation: same resolver shape as
  // `runIterationWithAiSdk` above — suite hostConfig provides defaults,
  // per-case `advancedConfig` overrides win. `withHostContextSystemPrompt`
  // applies {{var}} substitution on the resolved value.
  const resolvedExecution = resolveExecutionContext({
    hostConfig: suiteHostConfig ?? null,
    overrides: {
      systemPrompt:
        typeof advancedConfig?.system === "string"
          ? advancedConfig.system
          : undefined,
      temperature:
        typeof advancedConfig?.temperature === "number"
          ? advancedConfig.temperature
          : undefined,
    },
    precedence: "override-wins",
  });
  const skillsSource = resolveIterationSkillsSource({
    harness: resolvedExecution.harness,
    pinnedSkillSource,
  });
  const systemPrompt = withHostContextSystemPrompt(
    resolvedExecution.systemPrompt,
    test.hostConfigOverride?.hostContext as Record<string, unknown> | undefined,
  );
  const temperature = resolvedExecution.temperature;
  const toolChoice = normalizeToolChoice(advancedConfig?.toolChoice);

  const messageHistory: ModelMessage[] = [];
  /**
   * The TRACE transcript — `messageHistory`'s evidence-enriched twin (see the
   * acc contract on `DriveHostedEvalTurnParams`). Persisted and gate-read in
   * place of the model transcript only under the run's frozen evidence
   * decision; element-identical to `messageHistory` whenever capture is off,
   * which is what keeps an off run byte-equivalent.
   */
  const traceMessageHistory: ModelMessage[] = [];
  const toolsCalledByPrompt: ToolCall[][] = [];
  const runStartedAt = Date.now();
  const iterationMetadataBase: IterationMetadataBase = {};
  if (promptTurns.length > 1) {
    iterationMetadataBase.multiTurn = true;
  }
  if (runId === null && compareRunId) {
    iterationMetadataBase.compareRunId = compareRunId;
  }
  const resolvedSteps = resolveSteps(test);

  const iterationParams = {
    testCaseId: test.testCaseId ?? testCaseId,
    testCaseSnapshot: {
      title: test.title,
      query,
      provider: test.provider,
      model: test.model,
      runs: test.runs,
      expectedToolCalls,
      isNegativeTest: test.isNegativeTest,
      expectedOutput,
      ...(test.intent !== undefined ? { intent: test.intent } : {}),
      steps: resolvedSteps,
      advancedConfig,
      matchOptions: test.matchOptions,
      hostConfigOverride: test.hostConfigOverride,
    },
    iterationNumber: runIndex + 1,
    startedAt: runStartedAt,
  };

  const iterationId = precreatedIterationId
    ? precreatedIterationId
    : recorder
      ? await recorder.startIteration(iterationParams)
      : await createIterationDirectly(convexClient, iterationParams);

  // Adopt the chat-side tool/system/temperature pipeline. Same change as the
  // local-AI-SDK runner: pulls in skill tools, progressive-discovery meta-
  // tools, Anthropic name validation, and the assembled system prompt. The
  // backend path serializes `prepared.allTools` to `toolDefs` below and
  // executes them locally on tool-call events. Run AFTER iteration creation
  // and inside a try/catch so prep failures persist as a failed iteration row
  // rather than rejecting the test case with no iteration record.
  //
  // `customProviders` is derived from `orgModelConfig` so Anthropic name
  // validation fires for hosted-org BYOK runs that use Anthropic-compatible
  // custom providers (matches the local-AI-SDK runner, which threads the same
  // shape via `resolveEvalModelRuntime`).
  const backendCustomProviders = orgModelConfig
    ? buildLlmRuntimeConfigFromOrgConfig(orgModelConfig).customProviders
    : undefined;
  // PR 4d review fix (Codex P2 / Cursor Medium): hoisted up-front (above
  // the `prepareChatV2` try) so the catch path and the assignment
  // inside the try are both in scope. Stays `undefined` if prepareChatV2
  // throws — the setup-failure persistence path doesn't need a system
  // prefix.
  let backendEnhancedSystemPromptForPersist: string | undefined = undefined;
  // PR 5a folds in the deferred 4d Cursor-Low fix: mid-run SSE
  // snapshot events (`buildTraceSnapshotEvent`) in this streaming
  // backend variant read from `messageHistory` directly. PR 4d
  // round 2 added a `withSystemPrefix` closure to
  // `streamIterationWithAiSdk` but deferred the equivalent here.
  // The full runner-engine collapse stays for PR 5b; the
  // snapshot-prefix shape is small and isolated, so it folds into
  // PR 5a alongside the local stream rewrite. Closes the
  // "live-on-main UI gap" risk entry in unification.md.
  const withSystemPrefix = (msgs: ModelMessage[]): ModelMessage[] =>
    backendEnhancedSystemPromptForPersist
      ? [
          {
            role: "system",
            content: backendEnhancedSystemPromptForPersist,
          },
          ...msgs,
        ]
      : msgs;
  // Same shape as the non-stream backend runner: suite hostConfig
  // `builtInToolIds` resolve via the shared registry, billed against the
  // project target the org-BYOK/jam billing paths derive.
  const builtInTarget = resolveOrgTargetForEval(test, orgModelConfigTarget);
  // Unattended: nothing here can pause to ask, so the run's DECLARED policy is
  // the only thing that can authorize browser tools. Absent or malformed ⇒
  // undefined ⇒ they are not advertised at all (fail-closed).
  const browserApprovalDelivery = browserApprovalDeliveryFor(
    resolvedExecution.browserToolPolicy,
    { source: "evals-runner" },
  );
  const builtInTools = resolveHostTools(
    { builtInToolIds: resolvedExecution.builtInToolIds },
    builtInTarget && "projectId" in builtInTarget
      ? {
          authHeader: convexAuthToken,
          projectId: builtInTarget.projectId,
          ...(browserApprovalDelivery ? { browserApprovalDelivery } : {}),
          // Names THIS iteration, so an unattended browser gets a profile no
          // other iteration of this suite can reach. The suite's project is
          // not enough: iterations run concurrently against it.
          ...(iterationId ? { runKey: iterationId } : {}),
        }
      : null,
  );
  // ── Harness execution inputs, resolved once per iteration.
  //
  // Both are cheap and harness-gated: `resolveWebAuthorizedHarnessStrategy`
  // only makes a deploy-topology decision, and the pinned-skill projection is a
  // map over an already-fetched list. Resolving them here (rather than inside
  // the turn) keeps the decision with the run's other frozen inputs.
  //
  // An eval run builds an ephemeral authorized manager exactly as the hosted
  // chat routes do, so it is a WEB-authorized plane request and resolves the
  // same strategy they do. Deriving a different one here is how a sandbox ends
  // up pointed at the wrong manager.
  const harnessMcpProxy = resolvedExecution.harness
    ? resolveWebAuthorizedHarnessStrategy()
    : undefined;
  // D4b: a harness runs its MCP calls itself, in a sandbox, against the
  // generated `.mcp.json` — no in-process tool map exists to wrap, so the
  // decision travels to the MCP proxy sealed inside the proxy token and is
  // applied there. Harness-gated: the emulated path stays on the in-process
  // gate alone.
  const harnessToolPolicy =
    resolvedExecution.harness && toolPolicy
      ? buildHarnessToolPolicySnapshots({
          policy: toolPolicy,
          serverIds: selectedServers,
          annotations: toolAnnotations ?? new Map(),
        })
      : undefined;
  // The run's PINNED skills, in the shape the harness materializes on box.
  //
  // Built once at the run boundary (`prepareEvalRun` → `runPinnedSkillsToHarnessArtifacts`),
  // where the full pin rows and their signed file URLs are in hand, so the
  // supporting-file download happens before any model call rather than N times
  // mid-run. Nothing is synthesized here: identity, the complete-envelope hash,
  // preserved frontmatter and file bodies all come off the pin.
  //
  // Rides `pinnedHarnessSkills` — the FROZEN-RUN channel — and not
  // `runtimeSkillsOverride`, which is the live-environment channel one rank
  // below it in `selectHarnessSkillSource`. The distinction is the whole point:
  // an eval run must deliver exactly what it pinned, and must not consult
  // anything live.
  //
  // Forwarded when DEFINED rather than truthy: `[]` is a real answer ("this run
  // delivers no skills", which is what `skillsOverride: "exclude"` means), and
  // dropping it would fall through to the live project-wide fetch and hand the
  // without-skills arm every skill in the project.

  // Reproducible-eval sandbox for this hosted iteration (parity with the local
  // runner). Provisioned inside the prepareChatV2 try so a failure records a
  // clean failed iteration; released right after the agent run below.
  let evalSandbox: Awaited<ReturnType<typeof provisionEvalSandbox>> | null =
    null;
  const releaseEvalSandboxIfAny = async (): Promise<void> => {
    if (evalSandbox?.ok) {
      const { sandboxRowId } = evalSandbox.value;
      evalSandbox = null;
      await releaseEvalSandbox({ sandboxRowId }).catch(() => {});
    }
  };
  let prepared: PrepareChatV2Result;
  try {
    throwIfDescriptionOverrideOnHarness(
      toolDescriptionOverride,
      resolvedExecution.harness,
    );
    prepared = await prepareChatV2({
      mcpClientManager,
      selectedServers,
      modelDefinition,
      systemPrompt,
      temperature,
      respectToolVisibility: hostPolicy?.respectToolVisibility,
      modelVisibleMcpToolResults: hostPolicy?.modelVisibleMcpToolResults,
      ...(resolvedExecution.harness
        ? { harness: resolvedExecution.harness }
        : {}),
      ...(descriptionOverridesFromMarker(toolDescriptionOverride)
        ? {
            toolDescriptionOverrides: descriptionOverridesFromMarker(
              toolDescriptionOverride,
            ),
          }
        : {}),
      // Host progressive-discovery toggle, same conversion as the chat-v2
      // routes and the session-sim runner. Only an explicit host value is
      // forwarded — absent stays undefined so prepareChatV2 keeps its
      // "auto" threshold behavior.
      ...(resolvedExecution.progressiveToolDiscovery !== undefined
        ? {
            progressiveToolDiscovery: {
              enabled: resolvedExecution.progressiveToolDiscovery,
            },
          }
        : {}),
      ...(backendCustomProviders?.length
        ? { customProviders: backendCustomProviders }
        : {}),
      skillsSource,
      priorMessages: [],
      ...(builtInTools ? { builtInTools } : {}),
    });
    // PR 4d review fix (Codex P2 / Cursor Medium): same persistence
    // prefix shape as the non-stream backend runner.
    backendEnhancedSystemPromptForPersist = prepared.enhancedSystemPrompt;
    if (toolDescriptionOverride) {
      stampDescriptionExperiment(
        iterationMetadataBase,
        toolDescriptionOverride,
        descriptionAppliedOnPreparedTools(
          prepared.allTools,
          toolDescriptionOverride,
        ),
      );
    }
    // Pinned env → boot a fresh ephemeral sandbox and add the `bash` tool to
    // prepared.allTools (the hosted path serializes those to toolDefs for the
    // backend agent, then executes tool calls inspector-side). A provision
    // failure throws → the catch below persists a failed iteration.
    const pinnedEnvironmentId = (
      environment as { computerEnvironmentId?: string } | undefined
    )?.computerEnvironmentId;
    if (
      needsEphemeralEvalSandbox({
        pinnedEnvironmentId,
        harness: resolvedExecution.harness,
        runId,
      })
    ) {
      if (!isComputersDataPlaneConfigured()) {
        throw new Error(
          pinnedEnvironmentId
            ? "This eval pins a reproducible computer environment, but this server isn't a computers data plane (deployed servers bootstrap credentials from INSPECTOR_SERVICE_TOKEN; see docs/project-computers.md) — it could provision a sandbox but not exec or release it."
            : "This eval runs on a harness, which boots a disposable computer per iteration, but this server isn't a computers data plane (deployed servers bootstrap credentials from INSPECTOR_SERVICE_TOKEN; see docs/project-computers.md) — it could provision a sandbox but not exec or release it.",
        );
      }
      evalSandbox = await provisionEvalSandbox({
        bearer: convexAuthToken,
        runId: String(runId),
        ...(iterationId ? { iterationId: String(iterationId) } : {}),
        ...(abortSignal ? { signal: abortSignal } : {}),
      });
      if (!evalSandbox.ok) {
        throw new Error(
          `Could not provision the eval's reproducible sandbox: ${evalSandbox.error}`,
        );
      }
      // COMP-17: seed the case's pinned attachments before exposing `bash`
      // (parity with the local-BYOK path). Fail-honest — a throw here is caught
      // below and persisted as a failed iteration, never a silent run.
      await seedAndAnnotateEvalAttachments({
        bearer: convexAuthToken,
        runId: String(runId),
        testCaseId: test.testCaseId,
        sandboxId: evalSandbox.value.sandboxId,
        promptTurns,
        ...(abortSignal ? { signal: abortSignal } : {}),
      });
      prepared.allTools[EVAL_BASH_TOOL_NAME] = buildEvalBashTool({
        sandboxId: evalSandbox.value.sandboxId,
      });
    }
  } catch (error) {
    // Release any sandbox provisioned before a later line in the try threw.
    await releaseEvalSandboxIfAny();
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("[evals] iteration setup failed (prepareChatV2)", error);
    if (toolDescriptionOverride) {
      stampDescriptionExperiment(
        iterationMetadataBase,
        toolDescriptionOverride,
        false,
      );
    }
    await persistSetupFailedIteration({
      iterationId,
      runStartedAt,
      errorMessage,
      iterationMetadataBase,
      // Same authored-case inputs the success path builds further down; this
      // runner is never reached by a model-free case.
      stageCase: buildStageAuthoredCase({
        test,
        ...(resolvedSteps.length ? { steps: resolvedSteps } : {}),
        turns: resolvedTest.promptTurns,
        caseNeedsModel: true,
      }),
      // Classify the error but never guess a culprit span: prepareChatV2's
      // getToolsForAiSdk rethrow does not identify the failing server.
      ...(setupSignals ? { setupSignals } : {}),
      ...(setupSpans?.length ? { setupSpans } : {}),
      ...(setupAudit ? { setupAudit } : {}),
      recorder,
      convexClient,
    });
    // Mirror the in-stream failure signal `streamIterationWithAiSdk` already
    // sends from its outer catch. Without this, the live test-runner UI
    // watching `streamTestCase` SSE finishes silently on hosted-model /
    // hosted-org-BYOK setup errors while the local-AI-SDK stream variant
    // emits an `error` event for the same failure mode. (Batch: no emit.)
    emit?.({
      type: "error",
      message: errorMessage,
    });
    // Suite summary aggregates `evaluation.passed`; a fresh
    // `evaluateMultiTurnResults([], ...)` returns `passed: true` for negative
    // tests and for positive tests with no expected tools, so setup failures
    // would silently count as suite passes if we returned that as-is.
    const failedEvaluation = evaluateMultiTurnResults(
      promptTurns,
      [],
      test.isNegativeTest,
      test.matchOptions,
    );
    failedEvaluation.passed = false;
    return {
      evaluation: failedEvaluation,
      iterationId,
      ...(toolPolicyGate?.blocks.length
        ? { policyBlockCount: toolPolicyGate.blocks.length }
        : {}),
    };
  }

  // PR 5b: drive the per-turn loop through `runAssistantTurn` (the same
  // engine chat / playground / synthetic / non-stream eval already use).
  // Engine owns the Convex `/stream` per-step loop, tool execution,
  // trace persistence, abort plumbing, progressive discovery, and
  // approval handling. Eval owns the per-turn `runAssistantTurn` call,
  // SSE callback wiring (text deltas via `onLiveTextDelta`, tool
  // call/result/step events via the PR 5b-pre callbacks), failure
  // detection, persistence, and grading.
  //
  // `runAssistantTurn` reads `authContext.token` and forwards it as the
  // Authorization header on the per-step Convex fetch — same shape used
  // by `runIterationViaBackend` above (PR 3/4d).
  const evalAuthContext = {
    kind: "user_bearer" as const,
    token: `Bearer ${convexAuthToken}`,
  };

  // Cursor review fix (mirrors PR 4b for the non-stream backend
  // runner): the engine swallows AbortError internally (sets its
  // `aborted` flag, omits `turnTrace`, doesn't throw out of
  // `runAssistantTurn`). Read `abortSignal.aborted` directly as the
  // authoritative cancellation signal, used at the top of each
  // iteration AND after every per-turn call (success or catch).
  const isAborted = () => abortSignal?.aborted === true;
  const returnCancelled = () => ({
    evaluation: evaluateMultiTurnResults(
      promptTurns,
      toolsCalledByPrompt,
      test.isNegativeTest,
      test.matchOptions,
    ),
    iterationId: undefined,
  });

  let accumulatedUsage: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  let iterationError: string | undefined = undefined;
  let iterationErrorDetails: string | undefined = undefined;
  /** Which layer raised `iterationError`, when the executor classified it. */
  let iterationStepError:
    | { source?: "model" | "setup"; code?: string; httpStatus?: number }
    | undefined = undefined;
  const capturedSpans: EvalTraceSpan[] = [];
  // PR 4d review fix (Codex P2 / Cursor Medium): see hoist above the
  // `prepareChatV2` try.
  // Per-turn streaming play-by-play for the executeSteps handlers (headless in batch).
  const hostedBuildSinks = emit
    ? buildHostedEvalSinks({
        emit,
        messageHistory,
        capturedSpans,
        accumulatedUsage,
        withSystemPrefix,
        extractToolCalls: (messages) =>
          extractToolCallsExcludingPolicyBlocks(
            { messages },
            toolPolicyGate?.blockedToolCallIds() ?? new Set(),
          ),
        buildTraceSnapshotEvent,
      })
    : undefined;
  // §2 + fail-fast facts from the executeSteps path.
  let hostedStepSkippedSteps: unknown[] = [];
  let hostedStepResults: unknown[] = [];
  let hostedStepScriptedFailures: { toolName: string; reason: string }[] = [];
  // Pinned (`toolCall`) steps run model-free inspector-side; their tool
  // failures accumulate here for the verdict's `failOnToolError` gate (the
  // hosted analogue of `LocalEvalTurnAcc.pinnedToolErrors`).
  const pinnedToolErrors: ToolErrorRecord[] = [];
  // Hosted unify: drive the iteration through executeSteps; the handlers wrap
  // driveHostedEvalTurn (which mutates the acc), so the post-loop verdict +
  // finishParams below consume `acc` + the executor's StepExecutionState.
  const steps = resolveSteps(test);
  /**
   * What the run FROZE about tool-call evidence, as reported by the first
   * harness turn's proxy-token mint.
   *
   * Read from the mint rather than from a flag: the mint reports the decision
   * the control plane recorded at RUN CREATION, so a flag flipped mid-run
   * cannot change what this iteration does. Stays undefined on the emulated
   * path and on any run that never mints — which reads as capture off, the
   * same as a run from before evidence existed.
   */
  let harnessEvidenceDecision:
    | {
        captureEnabled: boolean;
        gradingSource: "narration" | "evidence";
        turnId: string;
      }
    | undefined;
  const hostedHandlers = buildHostedStepHandlers({
    browser,
    prepared,
    modelDefinition,
    modelId,
    selectedServers,
    mcpClientManager,
    evalAuthContext,
    endpointPath,
    extraBodyFields,
    ...(extraHeaders ? { extraHeaders } : {}),
    toolChoice,
    toolPolicyGate,
    abortSignal,
    maxSteps: MAX_STEPS,
    runStartedAt,
    isAborted,
    harness: resolvedExecution.harness,
    requireToolApproval: resolvedExecution.requireToolApproval,
    // ── Harness execution (harness hosts only; every field below is inert on
    // the emulated path, which is why they are all conditional).
    //
    // THE SAME BOX the tool resolver already exposes as `bash`, handed to the
    // harness as well: one box per iteration, never two. It rides the handler
    // options rather than the host config because the run's config snapshot is
    // member-readable, so a binding writable there would be forgeable.
    ...(resolvedExecution.harness && evalSandbox?.ok
      ? {
          harnessSandboxBinding: {
            sandboxRowId: evalSandbox.value.sandboxRowId,
            sandboxId: evalSandbox.value.sandboxId,
          },
        }
      : {}),
    // How the sandbox reaches this inspector's MCP proxy. An eval run builds
    // an ephemeral authorized manager exactly as the hosted chat routes do, so
    // it resolves the SAME strategy rather than re-deriving the plane — and
    // `runHarnessTurn` throws without one whenever servers are selected, which
    // for an eval suite is always.
    ...(harnessMcpProxy ? { harnessMcpProxy } : {}),
    // The iteration this run's harness turns record evidence against. Sent
    // only on the harness path with a real iteration row: a quick run has no
    // run to attach evidence to, and the emulated engine records firsthand
    // results already. Whether anything is actually recorded is decided
    // downstream by the run's FROZEN capture decision, which the mint reports.
    ...(resolvedExecution.harness && iterationId
      ? {
          evalIterationId: String(iterationId),
          onHarnessEvidenceDecision: (decision) => {
            harnessEvidenceDecision = decision;
          },
        }
      : {}),
    // The sealed policy + the sink that accounts its refusals. Blocks land on
    // the SAME gate the in-process path records into, so `policyBlocks` and the
    // matcher exclusion below cover both origins with no second code path.
    ...(harnessToolPolicy
      ? {
          harnessToolPolicy,
          onHarnessPolicyBlocks: (blocks) => {
            for (const block of blocks) {
              toolPolicyGate?.recordBlock({
                toolName: block.toolName,
                reason: block.reason,
                classification: block.classification,
                ...(block.toolCallId ? { toolCallId: block.toolCallId } : {}),
              });
            }
          },
        }
      : {}),
    // The run's FROZEN skills, materialized on box. Forwarded when DEFINED,
    // not when truthy: `[]` says "this run delivers no skills" (the
    // `skillsOverride: "exclude"` arm), while absent falls through to the
    // harness's live project-wide fetch — which would let a project skill
    // edited mid-run change what a running iteration sees.
    ...(pinnedHarnessSkills !== undefined ? { pinnedHarnessSkills } : {}),
    // Passed EXPLICITLY: `runHarnessTurn` reads built-ins off this field and
    // nowhere else, so supplying only `tools` would hand the runtime a turn
    // with no built-ins and no way to notice.
    ...(builtInTools ? { builtInTools } : {}),
    // The host's MCP tool-CONSTRUCTION policies, for the same reason and with
    // the same hazard as `builtInTools` above.
    //
    // The `prepareChatV2` call a few dozen lines up builds THIS iteration's
    // emulated tool set from `hostPolicy`. A harness turn never consumes that
    // set — `runHarnessTurn` rebuilds the model-facing MCP tools itself — and
    // reads each policy off these fields and nowhere else, so a policy that
    // stops here does not exist at all on host-executed delivery.
    // `driveHostedEvalTurn` gates all three behind `harness`, so an emulated
    // iteration is unaffected by any of this.
    //
    // `tasks` is the run-level seam (`resolveToolTaskSeam`, resolved once in
    // `runEvalSuiteWithAiSdk` and threaded down) rather than anything derived
    // here — same object `getEvalToolsForAiSdkOrThrow` built the run's tool set
    // with. Note the per-iteration `prepareChatV2` above does NOT take it; that
    // is a pre-existing emulated-path gap, deliberately left alone here because
    // closing it would change emulated eval behaviour.
    //
    // Definedness, not truthiness: `respectToolVisibility: false` IS the
    // SEP-1865 opt-out.
    ...(hostPolicy?.modelVisibleMcpToolResults !== undefined
      ? { modelVisibleMcpToolResults: hostPolicy.modelVisibleMcpToolResults }
      : {}),
    ...(hostPolicy?.respectToolVisibility !== undefined
      ? { respectToolVisibility: hostPolicy.respectToolVisibility }
      : {}),
    ...(tasks !== undefined ? { tasks } : {}),
    ...(builtInTarget && "projectId" in builtInTarget
      ? { projectId: builtInTarget.projectId }
      : {}),
    // The run's PROJECT ENVIRONMENT — the grant boundary the harness path
    // scopes its BROKERED external-account credential check to. Harness-gated
    // like the rest of this cluster; the emulated path resolves no such
    // credential and would only carry an unused field.
    ...(resolvedExecution.harness && projectEnvironmentId
      ? { environmentId: projectEnvironmentId }
      : {}),
    // Replay only: the run HAS an environment and this process cannot name it.
    // Keeps the refusal honest instead of blaming a selection.
    ...(resolvedExecution.harness &&
    !projectEnvironmentId &&
    projectEnvironmentUnresolvedReason
      ? { environmentUnresolvedReason: projectEnvironmentUnresolvedReason }
      : {}),
    logSuffix: emit ? " (stream)" : "",
    extractToolCalls: (messages) =>
      extractToolCallsExcludingPolicyBlocks(
        { messages },
        toolPolicyGate?.blockedToolCallIds() ?? new Set(),
      ),
    // The evidence reconciler's exclusion set, read fresh per turn — a
    // policy-refused call never reached a server, so its absence from the
    // wire record must not degrade the turn to narration grading.
    policyBlockedToolCallIds: () =>
      toolPolicyGate?.blockedToolCallIds() ?? new Set(),
    acc: {
      messageHistory,
      traceMessageHistory,
      capturedSpans,
      accumulatedUsage,
      toolsCalledByPrompt,
    },
    buildSinks: hostedBuildSinks,
    // Same closure shape the local step handlers use (see runLocalIteration).
    resolvePinnedServerKey: (pinned) =>
      resolvePinnedServerKey(
        pinned,
        environment,
        selectedServers,
        mcpClientManager,
      ),
    pinnedToolErrors,
    ...(emit
      ? {
          emitPinnedTurn: (payload: PinnedTurnSsePayload) =>
            emitPinnedTurnSse(
              { emit, withSystemPrefix, buildTraceSnapshotEvent },
              payload,
            ),
        }
      : {}),
  });
  const stepState = createStepExecutionState();
  let result: Awaited<ReturnType<typeof executeSteps>>;
  try {
    result = await executeSteps({
      steps,
      state: stepState,
      browser,
      handlers: hostedHandlers,
      isAborted,
      ...(emit
        ? {
            onStepStatus: (e) =>
              emit({
                type: "step_status",
                turnIndex: e.turnOrdinal,
                stepId: e.stepId,
                kind: e.kind,
                status: e.status,
              }),
          }
        : {}),
    });
  } finally {
    // The eval sandbox is only used during the agent run; release as soon as it
    // finishes or throws — the verdict/finalize below don't need it, and the
    // backend GC reaps anything this misses.
    await releaseEvalSandboxIfAny();
  }
  if (isAborted()) return returnCancelled();
  if (result.iterationError) {
    iterationError = result.iterationError;
    iterationErrorDetails = result.iterationErrorDetails;
    if (result.errorSource) {
      iterationStepError = {
        source: result.errorSource,
        ...(result.errorCode ? { code: result.errorCode } : {}),
        ...(typeof result.errorHttpStatus === "number"
          ? { httpStatus: result.errorHttpStatus }
          : {}),
      };
    }
  }
  // Pinned setup failure (server not connected) — drives `status:"setup_failed"`
  // below, mirroring the local runner.
  const pinnedSetupFailure = result.setupFailure;
  hostedStepSkippedSteps = stepState.skippedSteps;
  hostedStepResults = buildStepResultRecords(stepState, steps);
  hostedStepScriptedFailures = buildStepScriptedCheckFailures(stepState);

  // Fold widget→host tool calls into each turn's actual-call set once (see the
  // local path) so a single "tool was called" check covers widget-initiated
  // calls whether authored as an expected tool call or a predicate.
  const toolsCalledByPromptWithWidgets = mergeToolCallsByPromptIndex(
    toolsCalledByPrompt,
    widgetToolCallsByPromptIndex(browser.browserInteractionSteps),
  );
  const failOnToolError =
    (advancedConfig as { failOnToolError?: boolean } | undefined)
      ?.failOnToolError !== false;
  // Which transcript the predicate gate reads. EVIDENCE grading gets the
  // trace transcript (raw results and reconstructed wire-only calls are what
  // evidence-aware predicates are for); narration grading keeps the model
  // transcript even when capture enriched the persisted view, so a
  // capture-on/narration-graded run's verdict is unchanged by enrichment.
  const gateMessages =
    harnessEvidenceDecision?.gradingSource === "evidence"
      ? traceMessageHistory
      : messageHistory;
  const traceForGate =
    capturedSpans.length > 0 || gateMessages.length > 0
      ? {
          ...(capturedSpans.length > 0 ? { spans: capturedSpans } : {}),
          messages: gateMessages as ModelMessage[] as Array<{
            role: string;
            content: unknown;
          }>,
        }
      : undefined;
  // Per-turn predicate results from step assert execution (hosted parity).
  const turnCheckResults = resolveTurnCheckResultsFromStepExecution(
    stepState,
    steps,
  );
  const effectivePredicates = test.successPredicates?.length
    ? test.successPredicates
    : isPinnedOnly({ caseType: test.caseType, promptTurns })
      ? ([{ type: "widgetRendered" }] as NonNullable<
          typeof test.successPredicates
        >)
      : undefined;
  // Flush before the shared verdict reads scripted-check failures (see local path).
  browser.flushActiveWidgetChecks();
  const { evaluation, passed, predicateResults } = buildEvalIterationVerdict({
    promptTurns,
    toolsCalledByPrompt: toolsCalledByPromptWithWidgets,
    isNegativeTest: test.isNegativeTest,
    matchOptions: test.matchOptions,
    // Skill-tool calls are exempt from tool-call expectations (see local path).
    skillToolsActive: hasSkillTools(Object.keys(prepared.allTools)),
    turnCheckResults,
    effectivePredicates,
    trace: traceForGate,
    usage: hasReportedUsage(accumulatedUsage) ? accumulatedUsage : undefined,
    renderObservations: summarizeRenderObservations(
      browser.widgetRenderObservations,
    ),
    toolErrors: pinnedToolErrors,
    iterationError,
    failOnToolError,
    pinnedToolErrors,
    // §2: legacy push-model failures + executeSteps interact/widget-assert failures.
    scriptedCheckFailures: [
      ...browser.scriptedCheckFailures,
      ...hostedStepScriptedFailures,
    ],
  });
  const promptTraceSummaries = buildPromptTraceSummaries(
    evaluation,
    turnCheckResults,
  );
  // Reflect the gated verdict (match AND tool-error gate AND predicates) in the
  // returned evaluation so totals built from `evaluation.passed` agree with the
  // persisted iteration result.
  evaluation.passed = passed;
  const widgetSnapshots = await captureMcpAppWidgetSnapshots({
    injectOpenAiCompat,
    messages: messageHistory,
    mcpClientManager,
    convexClient,
  });
  // PR (this change): the resolved system prompt now flows through
  // `appendEvalTurnTrace.systemPrompt`. The `withSystemPrefix` closure
  // above still applies the prefix to LIVE SSE `trace_snapshot` events
  // for the test-runner UI (different consumer than the stored
  // transcript).
  const finishParams = buildIterationFinishParams({
    iterationId,
    ...(runId !== null ? { runId: String(runId) } : {}),
    ...(gradingMode ? { gradingMode } : {}),
    scoreMatchOptions: scoreMatchOptionsFor(test),
    ...(test.isNegativeTest ? { isNegativeTest: true } : {}),
    passed,
    evaluation,
    usage: accumulatedUsage,
    // The persisted transcript is the TRACE view whenever this run captured
    // evidence: matched calls keep their narrated output, wire-only calls
    // appear as reconstructed tool results, and run detail / the judge's
    // second pass read what the proxy actually saw. Capture off (or a run
    // that never minted) persists the model transcript, byte-identical to
    // pre-evidence behaviour.
    messages: harnessEvidenceDecision?.captureEnabled
      ? traceMessageHistory
      : messageHistory,
    // The RESOLVED id, not `test.model`: `modelId` is what `executeTestCase`
    // canonicalized and what the hosted `/stream` call actually billed, so
    // attribution here agrees with the provider request. (This runner is never
    // reached by a model-free case — those dispatch to the local runner.)
    modelId,
    ...(backendEnhancedSystemPromptForPersist
      ? { systemPrompt: backendEnhancedSystemPromptForPersist }
      : {}),
    spans: capturedSpans,
    prompts: promptTraceSummaries,
    // UVH-IN2: the layer that raised the fatal error, so the chain can say a
    // provider outage was ours rather than filing it against the server.
    ...(iterationStepError ? { stepError: iterationStepError } : {}),
    ...(widgetSnapshots ? { widgetSnapshots } : {}),
    // Browser-rendered MCP App eval (PR 14): hosted-path browser artifacts
    // (see the non-stream backend runner).
    widgetRenderObservations: browser.widgetRenderObservations,
    browserInteractionSteps: browser.browserInteractionSteps,
    // A model-free pinned setup failure (server not connected) records as
    // `setup_failed` — it never reached the question; everything else completes
    // (a failed verdict is still a completed run). Mirrors the local runner.
    status: pinnedSetupFailure ? "setup_failed" : "completed",
    startedAt: runStartedAt,
    ...(iterationError ? { error: iterationError } : {}),
    ...(iterationErrorDetails ? { errorDetails: iterationErrorDetails } : {}),
    predicateResults,
    ...(toolPolicyGate?.blocks.length
      ? { policyBlocks: toolPolicyGate.blocks }
      : {}),
    ...(toolPolicyGate?.warnings.length
      ? { policyWarnings: toolPolicyGate.warnings }
      : {}),
    ...(toolPolicyGate ? { toolPolicy: toolPolicyGate.policy } : {}),
    ...(hostedStepSkippedSteps.length
      ? { skippedSteps: hostedStepSkippedSteps }
      : {}),
    ...(hostedStepResults.length ? { stepResults: hostedStepResults } : {}),
    // This runner is never reached by a model-free case (those dispatch to the
    // local runner), so the case always has a model turn that could select.
    stageCase: buildStageAuthoredCase({
      test,
      ...(resolvedSteps.length ? { steps: resolvedSteps } : {}),
      turns: resolvedTest.promptTurns,
      caseNeedsModel: true,
    }),
    stageToolErrors: pinnedToolErrors,
    iterationMetadataBase,
    ...(hostPolicy ? { hostPolicy } : {}),
    ...(toolSignals ? { toolSignals } : {}),
    ...(setupSignals ? { setupSignals } : {}),
    ...(setupSpans?.length ? { setupSpans } : {}),
    ...(setupAudit ? { setupAudit } : {}),
    injectOpenAiCompat,
    // D7: same `prepared.allTools` source the local runner threads through —
    // this runner always has a model turn (see the `stageCase` comment
    // above), so `prepared` is always assigned by this point. Narrowed to
    // what progressive discovery actually advertised, when enabled — see
    // `narrowToolsToAdvertised`.
    selectionTools: narrowToolsToAdvertised(
      prepared.allTools,
      prepared.progressivePlan,
      prepared.discoveryState,
    ),
  });
  // RE-READ THE DERIVED VERDICT so run totals agree with the persisted row.
  //
  // At `enforce` the iteration's result is the conjunction of the boolean
  // pipeline and the gating score rows, computed inside
  // `buildIterationFinishParams`. `evaluation.passed` still holds the boolean
  // one, and THAT is what `runEvalSuiteWithAiSdk` aggregates into
  // `summary.passed`/`failed`/`passRate` and what `passCriteria` is judged
  // against — so a strictness catch would persist `failed` on the iteration
  // while the run counted it a pass, and the pass rate would be inflated by
  // exactly the cases `enforce` exists to catch. Those catches are EXPECTED
  // during the soak, so this drift is reachable, not theoretical.
  //
  // Assigned AFTER the call, never before: the score rows derive the
  // `toolCalls:match` row from `evaluation.passed`, which must remain the
  // MATCHER's answer at derivation time.
  evaluation.passed = finishParams.passed;

  await finalizeIterationWithBrowserArtifacts({
    browser,
    recorder,
    convexClient,
    finishParams,
  });

  return {
    evaluation,
    iterationId: iterationId ?? undefined,
    ...(toolPolicyGate?.blocks.length
      ? { policyBlockCount: toolPolicyGate.blocks.length }
      : {}),
  };
};

// Thin streaming wrapper (`emit` required) — preserves the SSE call site in
// `streamEvalTestCaseWithManager` and the streaming tests.
export const streamTestCase = (
  params: Omit<Parameters<typeof executeTestCase>[0], "emit"> & {
    emit: StreamEmit;
  },
) => executeTestCase(params);
