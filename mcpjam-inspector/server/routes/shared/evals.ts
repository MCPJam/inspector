import { ConvexHttpClient } from "convex/browser";
import type { MCPClientManager, MCPServerReplayConfig } from "@mcpjam/sdk";
import { readTasksPolicy } from "@mcpjam/sdk";
import {
  caseIntentSchema,
  evalSuiteFileToolPolicySchema,
} from "@mcpjam/sdk/contract";
import { resolveToolTaskSeam } from "../../utils/task-seam.js";
import { mcpToolOptionsFor } from "../../utils/mcp-tool-options.js";
import { z } from "zod";
import { generateTestCases } from "../../services/eval-agent";
import {
  convertToEvalTestCases,
  generateNegativeTestCases,
} from "../../services/negative-test-agent";
import { resolveFrozenRunGradingMode } from "../../services/evals/grading-mode.js";
import {
  startSuiteRunWithRecorder,
  type SuiteRunRecorder,
} from "../../services/evals/recorder";
import {
  captureToolSnapshotForEvalAuthoring,
  storeReplayConfig,
} from "../../services/evals/route-helpers";
import { loadSuiteHostConfig } from "../../services/evals/compat-runtime";
import { isTerminalRunStatus } from "../../services/evals/run-status.js";
import {
  checkEvalExecutionAdmission,
  checkEvalHarnessAdmission,
  harnessOfHostConfig,
} from "../../services/evals/harness-admission";
import {
  applyVisibilityPolicyAndCountSignals,
  extractHostExecutionPolicy,
  resolveOpenAiCompatForHostConfig,
} from "@mcpjam/sdk/host-config/internal";
import {
  resolveSteps,
  runEvalSuiteWithAiSdk,
  streamTestCase,
  type EvalPinnedSkillSource,
} from "../../services/evals-runner";
import type { EvalStreamEvent } from "@/shared/eval-stream-events";
import {
  probeConfigSchema,
  TEST_CASE_TYPES,
  type ProbeConfig,
  type TestCaseType,
} from "@/shared/probe-config";
import { deriveItemIdempotencyKey } from "../../utils/idempotency.js";
import {
  createEvalCasesInBatches,
  partialResultOf,
  withMintedCaseIds,
  type EvalCaseBatchItem,
} from "./eval-case-batch.js";
import { logger } from "../../utils/logger";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import {
  resolveOrgModelConfig,
  type ResolvedOrgModelConfig,
} from "../../utils/org-model-config";
import {
  flattenServerToolSnapshotTools,
  type ServerToolSnapshot,
} from "../../utils/export-helpers.js";
import { sanitizeForConvexTransport } from "../../services/evals/convex-sanitize.js";
import {
  environmentEffectiveServerIds,
  environmentServerIds,
  environmentServerNames,
  resolveEnvironmentForLaunch,
  type ResolvedEnvironmentForLaunch,
} from "../../services/environments/resolve.js";
import { resolveSuiteRunPluginServers } from "../../services/plugins/run-plugin-servers.js";
import {
  assertPinnedSkillFilesReachable,
  buildRunCapabilitySet,
  runNeedsEffectiveSkillSurface,
  type RunPinnedSkill,
} from "../../services/evals/run-plugin-snapshot.js";
import { runPinnedSkillsToHarnessArtifacts } from "../../services/evals/run-pinned-harness-skills.js";
import { harnessToolPolicyLaunchRefusal } from "../../utils/harness/harness-proxy-policy-enforcement.js";
import type { PinnedSkillArtifact } from "@/shared/skill-types";
import {
  countModelSteps,
  isModelFree,
  normalizePromptTurns,
  normalizeSteps,
  probeConfigToToolCallStep,
  promptTurnsToSteps,
  stepsSchema,
  type PromptTurn,
  type TestStep,
} from "@/shared/steps";
import {
  matchOptionsSchema,
  resolveMatchOptions,
  resolveCaseSuccessPredicates,
  casePredicatesSchema,
  type MatchOptionsDTO,
} from "@/shared/eval-matching";

const toolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({
    type: z.literal("tool"),
    toolName: z.string().min(1),
  }),
]);

/**
 * Resolve legacy multi-turn data from BOTH the top-level `promptTurns` and the
 * historical `advancedConfig.promptTurns` storage location (pre-migration cases
 * stored turns there). Returns [] when neither carries turns, so callers keep
 * their own single-turn / placeholder fallbacks. Mirrors the source precedence
 * of `resolvePromptTurns` without its query-synthesis tail.
 */
function resolveLegacyPromptTurns(src: {
  promptTurns?: unknown;
  advancedConfig?: unknown;
}): PromptTurn[] {
  const topLevel = normalizePromptTurns(src.promptTurns);
  if (topLevel.length > 0) return topLevel;
  return normalizePromptTurns(
    (src.advancedConfig as { promptTurns?: unknown } | undefined)?.promptTurns
  );
}

/**
 * Boundary compat: project a wire test's legacy fields onto the steps-first
 * `TestStep[]` contract. Precedence mirrors `internalCaseToSteps` in
 * routes/v1/evals.ts so every surface converges on the same shape:
 *   1. explicit `steps` (or `widget_probe` + `probeConfig`) win;
 *   2. multi-turn `promptTurns` (top-level OR `advancedConfig`) → `promptTurnsToSteps`;
 *   3. single-turn `query`/`expectedToolCalls` → one `prompt` step + asserts.
 * `query` is required on the wire, so this always returns ≥1 step.
 */
function wireTestToSteps(test: {
  steps?: unknown;
  caseType?: TestCaseType;
  probeConfig?: ProbeConfig;
  promptTurns?: unknown;
  advancedConfig?: unknown;
  query?: string;
  expectedToolCalls?: any[];
}): TestStep[] {
  const explicit = resolveAuthoringSteps(test);
  if (explicit && explicit.length > 0) return explicit;

  const turns = resolveLegacyPromptTurns(test);
  if (turns.length > 0) return promptTurnsToSteps(turns);

  const steps: TestStep[] = [
    {
      id: "step-1-prompt",
      kind: "prompt",
      prompt: typeof test.query === "string" ? test.query : "",
    },
  ];
  const expected = Array.isArray(test.expectedToolCalls)
    ? test.expectedToolCalls
    : [];
  expected.forEach((call: any, i: number) => {
    steps.push({
      id: `step-1-expect-${i}`,
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName: String(call?.toolName ?? ""),
        args: { args: call?.arguments ?? {} },
      },
    });
  });
  return steps;
}

/**
 * Quick-run compat: a PERSISTED case that predates the `steps` field but still
 * carries legacy `promptTurns` converts to steps so a single-case quick/compare
 * run executes every turn — without this it falls back to the top-level
 * `query`/`expectedToolCalls` and silently drops later turns/assertions.
 */
function legacyCaseStepsFallback(testCase: {
  promptTurns?: unknown;
  advancedConfig?: unknown;
}): TestStep[] | undefined {
  const turns = resolveLegacyPromptTurns(testCase);
  return turns.length > 0 ? promptTurnsToSteps(turns) : undefined;
}

export const RunEvalsRequestSchema = z.object({
  projectId: z.string().optional(),
  suiteId: z.string().optional(),
  suiteName: z.string().optional(),
  suiteDescription: z.string().optional(),
  toolPolicy: evalSuiteFileToolPolicySchema.optional(),
  tests: z.array(
    z
      .object({
        title: z.string(),
        query: z.string(),
        runs: z.number().int().positive().max(10),
        model: z.string(),
        provider: z.string(),
        expectedToolCalls: z.array(
          z.object({
            toolName: z.string(),
            arguments: z.record(z.string(), z.any()),
          })
        ),
        isNegativeTest: z.boolean().optional(),
        scenario: z.string().optional(),
        expectedOutput: z.string().optional(),
        // Optional analytics label. This authoring/run shape only creates or
        // updates from a complete test definition, so it carries the stored
        // string form; only the authoritative PATCH wire accepts `null`.
        intent: caseIntentSchema.optional(),
        // Unified `TestStep[]` model — the source of truth for execution.
        // Declared explicitly so Zod does not silently strip it off the wire
        // (feedback_zod_strips_unthreaded_fields). Optional on the wire so
        // pre-migration callers (UI run path, MCP/hosted, scheduled worker)
        // that still send `query`/`expectedToolCalls`/`promptTurns` are
        // accepted; the `.transform` below projects those legacy fields onto
        // `steps` so everything downstream sees the steps-first contract.
        steps: stepsSchema.optional(),
        // Legacy multi-turn shape. Accepted (not stripped) purely so the
        // transform can convert it to `steps`; never persisted as-is.
        promptTurns: z.array(z.any()).optional(),
        advancedConfig: z
          .object({
            system: z.string().optional(),
            temperature: z.number().optional(),
            toolChoice: toolChoiceSchema.optional(),
          })
          .passthrough()
          .optional(),
        matchOptions: matchOptionsSchema.optional(),
        // Case-level predicate gate override; threaded through every Zod
        // boundary on the wire so it doesn't get silently stripped
        // (feedback_zod_strips_unthreaded_fields).
        predicates: casePredicatesSchema.optional(),
        // Widget-probe discriminant + pinned tool call. Same silent-strip
        // rationale as `predicates` above. Probe entries carry display-only
        // model/provider sentinels to satisfy the required fields; the
        // runner forks off the LLM path before any model resolution and
        // `assertSuiteRunWithinCap` excludes them from LLM-call math.
        caseType: z.enum(TEST_CASE_TYPES).optional(),
        probeConfig: probeConfigSchema.optional(),
      })
      .superRefine((test, ctx) => {
        // Compatibility-field invariant: `steps` are the execution source of
        // truth, but when callers also send legacy widget-probe metadata, the
        // discriminant and payload must agree so later layers never see a
        // malformed mixed contract.
        if (test.caseType === "widget_probe" && !test.probeConfig) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["probeConfig"],
            message: "probeConfig is required when caseType is widget_probe",
          });
        }
        if (test.caseType !== "widget_probe" && test.probeConfig) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["probeConfig"],
            message: "probeConfig is only allowed on widget_probe cases",
          });
        }
      })
      // Project legacy fields onto `steps` so the rest of the pipeline only
      // ever deals with the steps-first contract. Steps-first callers pass
      // through UNCHANGED (no normalization churn); only legacy bodies are
      // converted. `query` is always present (required above), so the
      // single-turn fallback guarantees ≥1 step.
      .transform((test) => {
        if (Array.isArray(test.steps) && test.steps.length > 0) return test;
        return { ...test, steps: wireTestToSteps(test) };
      })
  ),
  // Non-empty for legacy launches; environment launches (environmentId set)
  // send NO server ids — the browser never knows an environment's closed
  // execution set, `prepareEvalRun` resolves it authoritatively (P0.1) and
  // enforces the ≥1-server rule for legacy requests at runtime (a `.min(1)`
  // here would reject every env launch; a `.superRefine` would break the
  // hosted variant's `.omit`).
  serverIds: z.array(z.string()),
  serverNames: z.array(z.string()).optional(),
  scenarioId: z.string().optional(),
  accessVersion: z.number().int().nonnegative().optional(),
  storageServerIds: z.array(z.string()).optional(),
  modelApiKeys: z.record(z.string(), z.string()).optional(),
  convexAuthToken: z.string(),
  notes: z.string().optional(),
  passCriteria: z
    .object({
      minimumPassRate: z.number(),
    })
    .optional(),
  /**
   * When true, the request is a rerun of an already-persisted suite — skip
   * the per-test-case upsert. Without this, derived wire fields (suite
   * default model substituted in for model-less cases, merged advancedConfig)
   * get baked into per-case overrides on first rerun, breaking later edits
   * to the suite default.
   */
  suiteRerun: z.boolean().optional(),
  /**
   * Transient per-run iteration count (1-10). Overlays `runs` on every
   * test case in the run snapshot without mutating the persisted
   * `EvalCase.runs` default. Cap-math counts this against
   * MAX_TOTAL_LLM_CALLS.
   */
  iterationOverride: z.number().int().min(1).max(10).optional(),
  /**
   * Run-only case subset (Convex testCase ids). When set, the run is scoped
   * to just these suite cases instead of every case — a single filter on the
   * run snapshot, with precreate + the runner unchanged. Used by single-case
   * runs from the public /api/v1 surface; the persisted suite is untouched.
   */
  caseIds: z.array(z.string().min(1)).min(1).optional(),
  /**
   * One-off match-option override for this run only. Resolved on top of
   * suite defaults + case overrides into each iteration's snapshot;
   * does NOT mutate persisted suite/case records.
   */
  matchOptionsOverride: matchOptionsSchema.optional(),
  /**
   * Scope this run to a single host attached to the suite. The Convex
   * `startTestSuiteRun` mutation snapshots the host's current config and
   * derives the run's server environment from it. When the suite has
   * multiple host attachments, the client makes one request per host.
   */
  namedHostId: z.string().optional(),
  /**
   * When true on a suiteRerun, explicitly re-derives suite.hostConfigId
   * from the request's server list and persists it. Without this flag,
   * plain reruns leave suite.hostConfigId (and suite.environment) frozen
   * so connecting new servers cannot silently contaminate existing suites.
   */
  refreshSnapshot: z.boolean().optional(),
  /**
   * Client-generated UUID set on every per-host POST when a multi-host
   * eval launch fans out (N > 1). Threaded into Convex `startTestSuiteRun`
   * so the resulting `testSuiteRun` rows share a group id, which the UI
   * uses to collapse them into a single parent row. Absent on single-host
   * launches and on legacy runs — those render ungrouped.
   *
   * Must be declared explicitly on every Zod boundary in the wire path;
   * unknown keys are stripped silently.
   */
  runGroupId: z.string().optional(),
  /**
   * Caller-supplied write idempotency key, forwarded to Convex
   * `startTestSuiteRun.idempotencyKey`. A repeat call with the same key (and
   * the same actor + suite) returns the EXISTING run instead of creating and
   * billing a second one.
   *
   * DECLARED ON THE WIRE, not just server-internal: unattended callers are
   * exactly the ones that retry. The Slack bot derives it from the triggering
   * event so a redelivered event or a double-clicked button lands on one run,
   * and the scheduled worker passes its trigger id. Zod strips unknown keys
   * silently, so leaving this undeclared meant a caller could send the key,
   * get a 202, and still be billed twice — with nothing to indicate the key
   * had been dropped.
   */
  idempotencyKey: z.string().min(1).max(256).optional(),
  /**
   * SHA-256 hex of the suite-file bytes that launched this run. Lowercase,
   * 64 characters. Forwarded to Convex `startTestSuiteRun.sourceHash` so a
   * file-owned run records the exact bytes it ran. Absent on UI / API
   * launches that did not come from a file.
   */
  sourceHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/, "sourceHash must be a 64-character lowercase SHA-256 hex digest")
    .optional(),
  /**
   * Project-environment launch (one per attached env on a Run-all fan-out;
   * always sent explicitly, even single-env). `prepareEvalRun` resolves the
   * environment's closed server set via
   * `projectEnvironments:resolveEnvironmentForLaunch` BEFORE server
   * connection/tool capture, uses it INSTEAD of browser-supplied
   * `serverIds`, and forwards the resolved revision to `startTestSuiteRun`
   * as `expectedEnvironmentRevision` (stale ⇒ structured 409, no run row).
   *
   * Must be declared explicitly on every Zod boundary in the wire path;
   * unknown keys are stripped silently.
   */
  environmentId: z.string().optional(),
  /**
   * Compose-and-run opt-in: accept a project-scoped, non-archived environment
   * that is NOT a suite member. Never mutates the suite. Absent / false keeps
   * today's membership check. Older backends reject the unknown arg; clients
   * probe `ephemeralEnvironmentLaunch` before sending it.
   */
  ephemeralEnvironment: z.boolean().optional(),
  /**
   * The "without skills" arm of an A/B compare (INS-5). `'exclude'` runs this
   * suite with skills DELIBERATELY off: the backend pins nothing from ANY of
   * the three channels — host `skillSelection`, the environment's standalone
   * selection, and the PLUGIN channel — and marks the run `skillsExcluded`, so
   * the comparison arm is honestly labelled rather than just quietly skill-free.
   *
   * KNOWN AND DELIBERATE ASYMMETRY, inherited verbatim from the backend
   * (`convex/testSuites.ts`, `resolveEnvironmentPinnedSkills`): this drops
   * plugin SKILLS, not plugin SERVERS. The flag is scoped to skill delivery, so
   * a pinned plugin's MCP servers stay connected and stay in the run's
   * `environmentPluginVersions` provenance. Dropping them too would change
   * which servers the arm connects, which is the one variable a skills A/B has
   * to hold fixed. A genuinely plugin-free comparison arm needs a backend
   * override that does not exist yet — see the INS-5 notes.
   *
   * Must be declared explicitly on every Zod boundary in the wire path;
   * unknown keys are stripped silently.
   */
  skillsOverride: z.literal("exclude").optional(),
  /**
   * Per-run approval of `approximated` imported cases, by HOSTED test-case id.
   *
   * Claim-only in both directions: the caller supplies an id and a reason, and
   * the backend derives the approver from the authenticated launcher, stamps
   * the time, and FREEZES the resulting decision into the run's own case
   * snapshot. A caller-supplied approver would file one person's approval
   * under another's name and a caller-supplied timestamp could be backdated
   * past the edit that invalidated the claim, so neither is representable
   * here.
   *
   * Nothing about this persists on the case. The next run of the same
   * approximation needs a new approval — that is the difference between
   * approving a RUN and accepting a CASE, and the whole reason there is no
   * second concept.
   *
   * Must be declared explicitly on every Zod boundary in the wire path;
   * unknown keys are stripped silently, and a silently-stripped approval
   * would be reported to the caller as a backend policy refusal.
   */
  importApprovals: z
    .array(
      z
        .object({
          testCaseId: z.string().min(1),
          reason: z.string().trim().min(1).max(500),
        })
        .strict()
    )
    .min(1)
    .optional(),
});

export type RunEvalsRequest = z.infer<typeof RunEvalsRequestSchema>;
type RunEvalsWithManagerRequest = RunEvalsRequest & {
  orgModelConfig?: ResolvedOrgModelConfig;
  /**
   * Run origin persisted on `testSuiteRun.source`; /api/v1 passes 'api',
   * the scheduled-evals worker passes 'schedule', and the GitHub-checks
   * worker passes 'github_check'. Server-internal on purpose: it is NOT on
   * `RunEvalsRequestSchema`, so API callers cannot spoof run provenance.
   */
  source?: "ui" | "api" | "schedule" | "github_check";
  /**
   * Pre-resolved environment from the caller's manager-priming preflight (the
   * hosted `/run` route and the scheduled worker resolve the environment ONCE
   * to connect its closed set). When present — and for the same
   * `environmentId` — `prepareEvalRun` reuses THIS resolution, including its
   * revision, instead of re-resolving. That makes `expectedEnvironmentRevision`
   * describe the exact set the manager was connected with, so an environment
   * edit after the preflight fails the run-start revision check (clean 409 /
   * retry) rather than pairing a stale manager with a newer run snapshot.
   */
  resolvedEnvironment?: ResolvedEnvironmentForLaunch;
};

export const RunTestCaseRequestSchema = z.object({
  testCaseId: z.string(),
  model: z.string(),
  provider: z.string(),
  compareRunId: z.string().optional(),
  skipLastMessageRunUpdate: z.boolean().optional(),
  serverIds: z
    .array(z.string())
    .min(1, { message: "At least one server must be selected" }),
  scenarioId: z.string().optional(),
  accessVersion: z.number().int().nonnegative().optional(),
  modelApiKeys: z.record(z.string(), z.string()).optional(),
  convexAuthToken: z.string(),
  testCaseOverrides: z
    .object({
      query: z.string().optional(),
      expectedToolCalls: z.array(z.any()).optional(),
      isNegativeTest: z.boolean().optional(),
      runs: z.number().int().positive().max(10).optional(),
      expectedOutput: z.string().optional(),
      // Unified `TestStep[]` override for a single-case quick run. Declared so
      // Zod doesn't strip it off the wire.
      steps: stepsSchema.min(1).optional(),
      // Legacy multi-turn override still sent by the test-template editor's
      // quick-run path. Accepted (not stripped) so the transform below can
      // convert it to `steps`; otherwise unsaved multi-turn/pinned edits are
      // silently dropped and the run falls back to the persisted case.
      promptTurns: z.array(z.any()).optional(),
      advancedConfig: z
        .object({
          system: z.string().optional(),
          temperature: z.number().optional(),
          toolChoice: toolChoiceSchema.optional(),
        })
        .passthrough()
        .optional(),
      matchOptions: matchOptionsSchema.optional(),
      // State-based predicate gate (see shared/predicates). Accepted as a
      // per-run override so SDK / corpus cases can gate on predicates without
      // the deferred Convex `testCase` schema change. Loosely typed like
      // `expectedToolCalls` above; predicate shape is validated by the corpus
      // validator at authoring time and evaluated deterministically by the
      // runner (unknown types fail closed).
      successPredicates: z.array(z.any()).optional(),
      // Case-level predicate override envelope ({ mode, list }). Threaded
      // through every Zod boundary; the runner resolves it against the
      // suite's `defaultPredicates` per the case mode.
      predicates: casePredicatesSchema.optional(),
    })
    // Convert a legacy `promptTurns` override (top-level OR `advancedConfig`)
    // to `steps` when the caller didn't send `steps` directly, so the runner's
    // `overrides.steps ?? case.steps` precedence picks up unsaved multi-turn
    // edits.
    .transform((overrides) => {
      if (!overrides.steps || overrides.steps.length === 0) {
        const turns = resolveLegacyPromptTurns(overrides);
        if (turns.length > 0) {
          return { ...overrides, steps: promptTurnsToSteps(turns) };
        }
      }
      return overrides;
    })
    .optional(),
  /**
   * One-off match-option override for this single-case run only. Does
   * NOT mutate the persisted case's `matchOptions`.
   */
  matchOptionsOverride: matchOptionsSchema.optional(),
  toolPolicy: evalSuiteFileToolPolicySchema.optional(),
  /**
   * Scope this single-case run to a single host attached to the suite. Mirrors
   * suite-run host selection and reuses `loadSuiteHostConfig`.
   */
  namedHostId: z.string().optional(),
  /**
   * One-off hostConfig override for this single-case run. Subset of
   * `HostConfigInputV2`; recorded on the iteration snapshot so the trace
   * shows which config the run actually used. Does NOT mutate the suite
   * hostConfig.
   */
  hostConfigOverride: z
    .object({
      hostStyle: z.string().optional(),
      hostContext: z.record(z.string(), z.unknown()).optional(),
      clientCapabilities: z.record(z.string(), z.unknown()).optional(),
      hostCapabilitiesOverride: z.record(z.string(), z.unknown()).optional(),
      chatUiOverride: z.record(z.string(), z.unknown()).optional(),
      mcpProfile: z.record(z.string(), z.unknown()).optional(),
      connectionDefaults: z
        .object({
          headers: z.record(z.string(), z.string()).optional(),
          requestTimeout: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type RunTestCaseRequest = z.infer<typeof RunTestCaseRequestSchema>;
type RunTestCaseWithManagerRequest = RunTestCaseRequest & {
  orgModelConfig?: ResolvedOrgModelConfig;
};

export const MAX_TOTAL_LLM_CALLS = 300;

export function assertSuiteRunWithinCap(
  request: RunEvalsRequest,
  configCount = 1
) {
  const override = request.iterationOverride;
  // Each iteration issues one model call per prompt turn; counting only `runs`
  // lets a multi-turn save-from-chat case bypass the cap. Widget probes issue
  // zero model calls and are excluded entirely.
  const totalCalls =
    request.tests.reduce((sum, t) => {
      const iterations = override ?? t.runs ?? 0;
      // Every wire case carries `steps`: count only `prompt` steps (each issues
      // one model call; `toolCall`/`interact`/`assert` issue none). A model-free
      // (no-prompt) case contributes nothing to the LLM budget.
      return sum + iterations * countModelSteps(t.steps ?? []);
    }, 0) * Math.max(configCount, 1);
  if (totalCalls > MAX_TOTAL_LLM_CALLS) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Suite run would issue ${totalCalls} LLM calls, above the cap of ${MAX_TOTAL_LLM_CALLS}. Reduce iterations or test count.`,
      { totalCalls, cap: MAX_TOTAL_LLM_CALLS }
    );
  }
}

/**
 * Synthesize cap-math entries from PERSISTED suite cases for bare suite
 * reruns (`suiteId` + empty wire `tests`: the scheduled-evals worker and the
 * /api/v1 suiteId-only rerun). Without this, `assertSuiteRunWithinCap` sums
 * an empty list and unattended runs bypass the cap interactive launches
 * enforce. One entry per (case × model) mirrors the interactive fan-out;
 * model-less prompt cases count once (they are rejected up front by
 * {@link assertBareRerunCasesRunnable}, but still counted here so cap math
 * never under-reports); widget probes carry `caseType` so the cap reducer
 * excludes them.
 */
export function buildCapEntriesFromPersistedCases(
  cases: Array<{
    title?: string;
    runs?: number;
    models?: Array<{ model: string; provider: string }>;
    steps?: unknown;
    promptTurns?: unknown;
    advancedConfig?: unknown;
    caseType?: TestCaseType;
    probeConfig?: ProbeConfig;
  }>,
  options?: { environmentBacked?: boolean }
): RunEvalsRequest["tests"] {
  const entries: RunEvalsRequest["tests"] = [];
  for (const testCase of cases ?? []) {
    const steps =
      // Resolve real steps for cap math so the count matches what executes:
      //  - explicit `steps` (or legacy `widget_probe`+`probeConfig`, which is
      //    MODEL-FREE → 0 LLM calls) via resolveAuthoringSteps;
      //  - legacy multi-turn `promptTurns` (top-level/advancedConfig) so every
      //    model turn is counted;
      //  - else an empty `prompt` placeholder (counts once).
      // Without the probe branch, a legacy widget probe would synthesize a
      // `prompt` placeholder and be over-counted as a model call, so big/iterated
      // probe suites could be wrongly rejected over MAX_TOTAL_LLM_CALLS.
      (resolveAuthoringSteps(testCase) ??
        legacyCaseStepsFallback(testCase) ?? [
          { id: "legacy-cap-prompt", kind: "prompt", prompt: "" },
        ]) as RunEvalsRequest["tests"][number]["steps"];
    // Model-free cases (no `prompt` step) need one cap entry; model cases fan
    // out per model. The cap reducer counts `prompt` steps, so a model-free
    // case contributes 0 LLM calls regardless of fanout — the entry carries
    // `steps` so the reducer sees the real count.
    const modelFree = isModelFree(steps ?? []);
    const fanout =
      modelFree || options?.environmentBacked
        ? 1
        : Math.max(testCase.models?.length ?? 0, 1);
    for (let i = 0; i < fanout; i++) {
      entries.push({
        title: testCase.title ?? "",
        query: "",
        runs: Math.max(1, Math.floor(testCase.runs ?? 1)),
        model: "cap-check",
        provider: "none",
        expectedToolCalls: [],
        steps,
      });
    }
  }
  return entries;
}

/**
 * Reject a bare suite rerun (scheduled worker, /api/v1 suiteId-only) whose
 * persisted snapshot contains a prompt case that cannot contribute a single
 * runnable entry.
 *
 * The bare-rerun path builds the runner's `config.tests` straight from the
 * persisted cases (see `startSuiteRunWithRecorder`). A prompt case with an
 * empty `models` array and no legacy `model`/`provider` relies on
 * `suite.defaultConfig.modelId` — but that substitution only ever runs
 * client-side (it needs the model catalog to resolve the provider) and is
 * absent here, so the recorder's config builder silently drops the case
 * (`return []`). The run would then execute fewer cases than the cap reserved
 * for — or, for a model-default-only suite, zero — while reporting success.
 * For an unattended monitor that silent under-run is the dangerous failure
 * mode, so surface it loudly instead: a 400 on the /api/v1 surface, and on the
 * scheduled path a failed claim the backend's failure accounting can pause and
 * notify on.
 *
 * (Honest scope: full suite-default support for bare reruns needs the backend
 * snapshot + `precreateIterationsForRun` to carry the substituted model so the
 * recorder has a precreated row to pair against — substituting only in the
 * inspector's config builder would execute the case with nowhere to record it.
 * Tracked as a follow-up.)
 */
export function assertBareRerunCasesRunnable(
  cases: Array<{
    title?: string;
    models?: Array<{ model: string; provider: string }>;
    model?: string;
    provider?: string;
    steps?: unknown;
    caseType?: TestCaseType;
    probeConfig?: ProbeConfig;
  }> | null
): void {
  const unrunnable = (cases ?? [])
    .filter(
      (c) =>
        // Model-free cases (every step is a `toolCall`/no `prompt`) need no
        // model and ARE runnable — don't flag them as unrunnable prompt cases.
        // Derive steps through `resolveAuthoringSteps` so PRE-MIGRATION
        // `widget_probe` rows (no `steps`, only `caseType`/`probeConfig`) are
        // recognized as model-free instead of mistaken for prompt cases.
        !isModelFree(resolveAuthoringSteps(c) ?? []) &&
        !(c.models && c.models.length > 0) &&
        !(c.model && c.provider)
    )
    .map((c) => c.title?.trim() || "(untitled)");
  if (unrunnable.length > 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Cannot run this suite unattended: ${unrunnable.length} prompt case(s) ` +
        `have no model of their own and rely on the suite default model, ` +
        `which is only applied for interactive launches. Add a per-case ` +
        `model to run on a schedule or via the API: ${unrunnable.join(", ")}.`,
      { unrunnableCases: unrunnable }
    );
  }
}

/**
 * Counts override prompt-turns when present, then falls back to the
 * persisted case's prompt-turns count. Callers that have already loaded
 * the persisted test case should pass it via `resolved` — without it, a
 * multi-turn saved case can slip past the cap because we'd count it as a
 * single-turn run.
 */
export function assertTestCaseRunWithinCap(
  request: RunTestCaseRequest,
  configCount = 1,
  resolved?: { modelStepCount?: number }
) {
  const iterations = request.testCaseOverrides?.runs ?? 1;
  const overrideCalls = request.testCaseOverrides?.steps
    ? countModelSteps(request.testCaseOverrides.steps)
    : undefined;
  const resolvedCalls = resolved?.modelStepCount;
  const turns = Math.max(overrideCalls ?? resolvedCalls ?? 0, 1);
  const totalCalls = iterations * turns * Math.max(configCount, 1);
  if (totalCalls > MAX_TOTAL_LLM_CALLS) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Test case run would issue ${totalCalls} LLM calls, above the cap of ${MAX_TOTAL_LLM_CALLS}.`,
      { totalCalls, cap: MAX_TOTAL_LLM_CALLS }
    );
  }
}

// Optional attachment metadata threaded into the backend eval-generation
// endpoint so the LLM can scope the cases by the suite's saved server
// attachment (per-server tests + at least one explicit cross-server test
// when the attachment spans ≥2 servers). `resolvedServerNames` carries
// runtime server identifiers — NOT Convex serverAttachment document ids —
// to avoid ambiguity at the wire boundary.
export const ServerAttachmentInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  resolvedServerNames: z.array(z.string().min(1)).min(1),
});

export type ServerAttachmentInput = z.infer<typeof ServerAttachmentInputSchema>;

// Per-bucket case counts for configurable generation. Field names mirror the
// backend `CaseMix`. Each bucket is bounded; the backend additionally caps the
// total. Omitted buckets inherit the backend's mode default.
export const CaseMixSchema = z.object({
  simple: z.number().int().min(0).max(10).optional(),
  multiTool: z.number().int().min(0).max(10).optional(),
  multiTurn: z.number().int().min(0).max(10).optional(),
  complex: z.number().int().min(0).max(10).optional(),
  negative: z.number().int().min(0).max(10).optional(),
});

// Optional generation knobs forwarded to the backend generate endpoint.
export const GenerationOptionsSchema = z.object({
  caseMix: CaseMixSchema.optional(),
  varyUserStyles: z.boolean().optional(),
});

export type GenerationOptions = z.infer<typeof GenerationOptionsSchema>;

// `serverNames` is the optional parallel array that pairs each `serverIds[i]`
// (the manager key — Convex Id in hosted mode, display name in standalone)
// with its runtime display name. The backend snapshot/attachment check is
// keyed by display name (see `applyAttachmentScope` in
// `convex/evalGeneration/routes.ts`), so generators must rewrite the snapshot's
// `serverId` to the display name before forwarding. Without the parallel
// array the rewrite is a no-op and standalone callers (where manager key ==
// display name) continue to work unchanged.
export const GenerateTestsRequestSchema = z.object({
  serverIds: z
    .array(z.string())
    .min(1, { message: "At least one server must be selected" }),
  serverNames: z.array(z.string()).optional(),
  convexAuthToken: z.string(),
  projectId: z.string().min(1).optional(),
  serverAttachment: ServerAttachmentInputSchema.optional(),
  generationOptions: GenerationOptionsSchema.optional(),
});

export type GenerateTestsRequest = z.infer<typeof GenerateTestsRequestSchema>;

export const GenerateNegativeTestsRequestSchema = z.object({
  serverIds: z
    .array(z.string())
    .min(1, { message: "At least one server must be selected" }),
  serverNames: z.array(z.string()).optional(),
  convexAuthToken: z.string(),
  projectId: z.string().min(1).optional(),
  serverAttachment: ServerAttachmentInputSchema.optional(),
});

export type GenerateNegativeTestsRequest = z.infer<
  typeof GenerateNegativeTestsRequestSchema
>;

/**
 * Best-effort fetch of a suite's `defaultMatchOptions` so single-case
 * runs resolve the same suite → case → override precedence chain that
 * `precreateIterationsForRun` applies for suite-level runs.
 * Returns undefined on any error; defaults still apply downstream.
 */
async function loadSuiteDefaultMatchOptions(
  convexClient: ConvexHttpClient,
  suiteId?: string
): Promise<MatchOptionsDTO | undefined> {
  if (!suiteId) return undefined;
  try {
    const suite = await convexClient.query("testSuites:getTestSuite" as any, {
      suiteId,
    });
    return (
      (suite?.defaultMatchOptions as MatchOptionsDTO | undefined) ?? undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * Best-effort fetch of a suite's `defaultPredicates` so single-case runs
 * resolve the same suite → case predicate precedence chain that the suite
 * run path applies via `precreateIterationsForRun` once the backend ships
 * the resolved field. Returns undefined on any error; runner treats that
 * as no suite default.
 */
async function loadSuiteDefaultPredicates(
  convexClient: ConvexHttpClient,
  suiteId?: string
): Promise<import("@/shared/eval-matching").Predicate[] | undefined> {
  if (!suiteId) return undefined;
  try {
    const suite = await convexClient.query("testSuites:getTestSuite" as any, {
      suiteId,
    });
    const defaults = (suite as { defaultPredicates?: unknown } | undefined)
      ?.defaultPredicates;
    if (!Array.isArray(defaults) || defaults.length === 0) return undefined;
    return defaults as import("@/shared/eval-matching").Predicate[];
  } catch {
    return undefined;
  }
}

async function loadSuiteEnvironment(
  convexClient: ConvexHttpClient,
  suiteId?: string
): Promise<unknown> {
  if (!suiteId) return undefined;
  try {
    const suite = await convexClient.query("testSuites:getTestSuite" as any, {
      suiteId,
    });
    return (suite as { environment?: unknown } | undefined)?.environment;
  } catch {
    return undefined;
  }
}

function buildRuntimeEnvironmentWithBindings(args: {
  resolvedServerIds: string[];
  suiteEnvironment: unknown;
}) {
  const rawBindings = (
    args.suiteEnvironment as
      | {
          serverBindings?: Array<{
            serverName?: unknown;
            projectServerId?: unknown;
          }>;
        }
      | undefined
  )?.serverBindings;
  const serverBindings = Array.isArray(rawBindings)
    ? rawBindings.flatMap((binding) =>
        typeof binding.serverName === "string" &&
        typeof binding.projectServerId === "string"
          ? [
              {
                serverName: binding.serverName,
                projectServerId: binding.projectServerId,
              },
            ]
          : []
      )
    : [];
  return {
    servers: args.resolvedServerIds,
    ...(serverBindings.length > 0 ? { serverBindings } : {}),
  };
}

export function createConvexClients(convexAuthToken: string) {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_URL is not set");
  }

  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }

  const convexClient = new ConvexHttpClient(convexUrl);
  convexClient.setAuth(convexAuthToken);

  return { convexClient, convexHttpUrl };
}

export function resolveServerIdsOrThrow(
  requestedIds: string[],
  clientManager: MCPClientManager
): string[] {
  const available = clientManager.listServers();
  const resolved: string[] = [];

  for (const requestedId of requestedIds) {
    const match =
      available.find((id) => id === requestedId) ??
      available.find((id) => id.toLowerCase() === requestedId.toLowerCase());

    if (!match) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        `Could not start eval because "${requestedId}" is not connected. Reconnect the server and try again.`,
        { serverId: requestedId }
      );
    }

    if (!resolved.includes(match)) {
      resolved.push(match);
    }
  }

  return resolved;
}

function normalizeForComparison(obj: any): any {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(normalizeForComparison);

  const sorted: Record<string, unknown> = {};
  Object.keys(obj)
    .sort()
    .forEach((key) => {
      sorted[key] = normalizeForComparison(obj[key]);
    });
  return sorted;
}

export function filterAndRemapReplayConfigs(
  replayConfigs: MCPServerReplayConfig[],
  resolvedServerIds: string[],
  persistedServerIds: string[]
): MCPServerReplayConfig[] {
  const persistedIdByResolvedId = new Map<string, string>();

  for (const [index, resolvedServerId] of resolvedServerIds.entries()) {
    const persistedServerId = persistedServerIds[index] ?? resolvedServerId;
    if (!resolvedServerId || !persistedServerId) {
      continue;
    }
    persistedIdByResolvedId.set(resolvedServerId, persistedServerId);
  }

  return replayConfigs.flatMap((config) => {
    const persistedServerId = persistedIdByResolvedId.get(config.serverId);
    if (!persistedServerId) {
      return [];
    }

    return [
      {
        ...config,
        serverId: persistedServerId,
      },
    ];
  });
}

function buildPersistedSuiteEnvironment(args: {
  resolvedServerIds: string[];
  persistedServerRefs: string[];
  serverNames?: string[];
}) {
  const serverNames =
    args.serverNames &&
    args.serverNames.length > 0 &&
    args.serverNames.length === args.resolvedServerIds.length
      ? args.serverNames
      : args.persistedServerRefs;

  const serverBindings =
    args.serverNames &&
    args.serverNames.length > 0 &&
    args.serverNames.length === args.resolvedServerIds.length
      ? args.serverNames.map((serverName, index) => ({
          serverName,
          projectServerId: args.resolvedServerIds[index],
        }))
      : undefined;

  return {
    servers: serverNames,
    ...(serverBindings ? { serverBindings } : {}),
  };
}

export type PreparedEvalRun = {
  suiteId: string;
  runId: string;
  caseUpsert: {
    committed: Array<{ id?: string; name: string }>;
    failed: Array<{ id?: string; name: string; error: string }>;
  };
  recorder: SuiteRunRecorder;
  /**
   * This "start" REPLAYED an existing run rather than creating one — an
   * idempotency-key hit, or the keyless fingerprint window. Undefined against a
   * backend that predates the signal.
   *
   * Read it through {@link shouldSkipExecution}; a bare truthiness check here
   * is the wrong question, because a replay of a run still in flight is not the
   * same as a replay of one that finished.
   */
  deduped?: boolean;
  /** The run's status as the platform holds it. `running` for a fresh start;
   *  on a replay, whatever the existing run actually is. */
  status?: string;
  /**
   * Execute the prepared run to completion. `runEvalSuiteWithAiSdk` owns
   * terminal run status (completed/failed/cancelled); callers that detach
   * this (the async /api/v1 route) should still catch and defensively
   * finalize via `recorder` for errors thrown outside the runner's own
   * try.
   *
   * DO NOT call this unconditionally on a prepared run — see
   * {@link shouldSkipExecution}. A replay of a finished run must not execute:
   * the suite would run a second time and bill a second time, against a run
   * whose results are already recorded.
   */
  execute: () => Promise<void>;
};

/**
 * Whether a prepared run has already been run and must NOT be executed again.
 *
 * TRUE for exactly one case: the platform replayed an existing run AND that run
 * is terminal. Executing then would re-run every case and bill for it, writing
 * over results that are already final — which is the double-spend an
 * idempotency key is sent to prevent.
 *
 * FALSE for a replay of a NON-terminal run, deliberately. Two situations are
 * indistinguishable from here — a run genuinely in flight, and one abandoned
 * when its process died mid-execution — and they want opposite treatments. The
 * conservative answer preserves the behaviour that predates this check, so a
 * crashed run can still be driven to completion by a retry the way it always
 * has been. Deciding that case needs a liveness signal (a lease or heartbeat on
 * the run), not a guess made here.
 *
 * FALSE against a backend with no `deduped` field, for the same reason: unknown
 * is not a licence to change behaviour.
 */
export function shouldSkipExecution(prepared: {
  deduped?: boolean;
  status?: string;
}): boolean {
  return prepared.deduped === true && isTerminalRunStatus(prepared.status);
}

/**
 * A probe's identity is title + server + tool: every probe shares query ""
 * and arrives as exactly one wire row (no model fan-out to reassemble).
 * Used both as the upsert dedupe key for probe rows and to pair a probe
 * wire entry with its persisted case. NUL-joined so a title containing the
 * other segments can't forge a collision.
 */
export function probeIdentityKey(entry: {
  title: string;
  probeConfig?: ProbeConfig;
}): string {
  return [
    "widget_probe",
    entry.title,
    entry.probeConfig?.serverId ?? entry.probeConfig?.serverName ?? "",
    entry.probeConfig?.toolName ?? "",
  ].join("\u0000");
}

/**
 * Dedupe key for `prepareEvalRun`'s per-case upsert map. Prompt rows keep
 * the historical title+query key (the per-model fan-out sends one row per
 * model of the same case and must reassemble). Step-native rows key by
 * normalized steps so distinct same-titled render checks do not collide and
 * prompt models are not pushed into a model-free entry.
 */
export function buildUpsertCaseKey(test: {
  title: string;
  query: string;
  steps?: TestStep[];
  caseType?: TestCaseType;
  probeConfig?: ProbeConfig;
}): string {
  const steps = resolveAuthoringSteps(test);
  if (steps && steps.length > 0) {
    return `${test.title}-${test.query}-${JSON.stringify(
      normalizeForComparison(steps)
    )}`;
  }
  return test.caseType === "widget_probe"
    ? probeIdentityKey(test)
    : `${test.title}-${test.query}`;
}

function legacyProbeConfigToSteps(probeConfig: ProbeConfig): TestStep[] {
  const call = probeConfigToToolCallStep("step-1", probeConfig);
  return [
    call,
    {
      id: "step-2",
      kind: "assert",
      assertion: { type: "widgetRendered", toolName: call.toolName },
    },
  ];
}

function resolveAuthoringSteps(test: {
  steps?: unknown;
  caseType?: TestCaseType;
  probeConfig?: ProbeConfig;
}): TestStep[] | undefined {
  const steps = normalizeSteps(test.steps);
  if (steps.length > 0) return steps;
  if (test.caseType === "widget_probe" && test.probeConfig) {
    return legacyProbeConfigToSteps(test.probeConfig);
  }
  return undefined;
}

/**
 * Project one entry of the upsert map onto a `createTestCases` batch item.
 *
 * `judgeRequirement` is deliberately absent. The map type declares it but
 * nothing ever assigns it, so every create so far has sent `undefined` — which
 * Convex drops — and the backend's case validators have no such field. The
 * batch item validator is CLOSED, so forwarding the dead key would turn every
 * case into a rejected item rather than a silent no-op.
 */
function toCaseBatchItem(
  testCaseData: {
    title: string;
    query: string;
    runs: number;
    models: Array<{ model: string; provider: string }>;
    expectedToolCalls: any[];
    isNegativeTest?: boolean;
    scenario?: string;
    expectedOutput?: string;
    intent?: string;
    steps?: TestStep[];
    advancedConfig?: any;
    matchOptions?: import("@/shared/eval-matching").MatchOptionsDTO;
    predicates?: import("@/shared/eval-matching").CasePredicates;
  },
  opts: { idempotencyKey?: string }
): EvalCaseBatchItem {
  return {
    title: testCaseData.title,
    query: testCaseData.query,
    models: testCaseData.models,
    runs: testCaseData.runs,
    expectedToolCalls: sanitizeForConvexTransport(
      testCaseData.expectedToolCalls
    ),
    isNegativeTest: testCaseData.isNegativeTest,
    scenario: testCaseData.scenario,
    expectedOutput: testCaseData.expectedOutput,
    ...(testCaseData.intent !== undefined
      ? { intent: testCaseData.intent }
      : {}),
    steps: sanitizeForConvexTransport(testCaseData.steps),
    advancedConfig: sanitizeForConvexTransport(testCaseData.advancedConfig),
    matchOptions: testCaseData.matchOptions,
    predicates: testCaseData.predicates,
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  };
}

/**
 * One case's upsert outcome, held in its ORIGINAL position.
 *
 * Creates are now deferred to a batch that runs after the whole map has been
 * walked, so appending outcomes as they happen would reorder the response —
 * every updated case ahead of every created one. Callers render these lists to
 * a human next to the tests they submitted, so the slot is kept and filled.
 */
type CaseUpsertOutcome =
  | { kind: "committed"; id?: string; name: string }
  | { kind: "failed"; id?: string; name: string; error: string };

/**
 * Author the deferred creates through `createTestCases` and fill their slots.
 *
 * A whole-call throw is turned back into one failure per pending case. The
 * batch mutation rejects an entire call for a caller-level mistake — an
 * unauthorized actor, a suite that vanished — and before batching, that same
 * condition threw once per `createTestCase` and filed every case as failed.
 * Preserving that is what keeps this function's partial-failure contract (and
 * the empty-new-suite rollback below, which reads "nothing committed") true.
 */
async function commitPendingCaseCreates(args: {
  convexClient: ReturnType<typeof createConvexClients>["convexClient"];
  suiteId: string;
  pending: Array<{ slot: number; title: string; item: EvalCaseBatchItem }>;
  outcomes: Array<CaseUpsertOutcome | undefined>;
}): Promise<void> {
  const { convexClient, suiteId, pending, outcomes } = args;
  if (pending.length === 0) return;

  // Mint here rather than at the map walk: an id is only meaningful for a row
  // that is actually being created, and an update keeps whatever identity the
  // stored case already has.
  const cases = withMintedCaseIds(pending.map((p) => p.item));

  let result: Awaited<ReturnType<typeof createEvalCasesInBatches>>;
  let rejection: string | undefined;
  try {
    result = await createEvalCasesInBatches(convexClient, { suiteId, cases });
  } catch (error) {
    // A rejection carries whatever earlier chunks committed. Those rows exist;
    // reporting them as failures would send the caller into a retry that
    // authors them twice.
    result = partialResultOf(error);
    rejection = error instanceof Error ? error.message : String(error);
    logger.warn("[evals] Batch case create rejected the whole call", {
      suiteId,
      cases: pending.length,
      committedBeforeRejection: result.committed.length,
      error: rejection,
    });
  }

  for (const entry of result.committed) {
    const slotted = pending[entry.index];
    if (!slotted) {
      logger.warn("[evals] Batch result named a case index we never sent", {
        suiteId,
        index: entry.index,
        sent: pending.length,
      });
      continue;
    }
    outcomes[slotted.slot] = {
      kind: "committed",
      id: String(entry.testCaseId),
      name: slotted.title,
    };
  }
  for (const entry of result.failed) {
    const slotted = pending[entry.index];
    if (!slotted) {
      logger.warn("[evals] Batch result named a case index we never sent", {
        suiteId,
        index: entry.index,
        sent: pending.length,
      });
      continue;
    }
    outcomes[slotted.slot] = {
      kind: "failed",
      name: slotted.title,
      // The code is the stable half; the message is what a human reads.
      error: `${entry.code}: ${entry.message}`,
    };
    logger.warn("[evals] Failed to create test case", {
      suiteId,
      title: slotted.title,
      code: entry.code,
      error: entry.message,
    });
  }

  // Warnings are the audit half of the batch contract — a policy coercion, a
  // replay that kept a different id. This surface renders `{id?, name}` and has
  // nowhere to put them, so they are logged rather than dropped.
  // Everything the rejected call never reached. Filled last so a case the
  // partial result already accounted for keeps its real outcome.
  if (rejection !== undefined) {
    for (const { slot, title } of pending) {
      if (outcomes[slot] === undefined) {
        outcomes[slot] = { kind: "failed", name: title, error: rejection };
      }
    }
  }

  const entryWarnings = result.committed.flatMap((entry) =>
    (entry.warnings ?? []).map((w) => ({ title: entry.title, ...w }))
  );
  if (result.warnings.length > 0 || entryWarnings.length > 0) {
    logger.info("[evals] Batch case create returned warnings", {
      suiteId,
      warnings: [...result.warnings, ...entryWarnings],
    });
  }
}

/** Drain positional outcomes into the response's two flat lists, in order. */
function flushCaseOutcomes(
  outcomes: Array<CaseUpsertOutcome | undefined>,
  committedCases: Array<{ id?: string; name: string }>,
  failedCases: Array<{ id?: string; name: string; error: string }>
): void {
  for (const outcome of outcomes) {
    if (!outcome) continue;
    if (outcome.kind === "committed") {
      committedCases.push({
        ...(outcome.id ? { id: outcome.id } : {}),
        name: outcome.name,
      });
    } else {
      failedCases.push({
        ...(outcome.id ? { id: outcome.id } : {}),
        name: outcome.name,
        error: outcome.error,
      });
    }
  }
}

/**
 * Author phase of a suite run: persist the suite + its test cases (create or
 * upsert), WITHOUT creating a run record or executing anything. Extracted from
 * `prepareEvalRun` so the author-only public surface
 * (`POST /api/v1/projects/:projectId/eval-suites`) can reuse the exact same
 * suite/case persistence the run path uses — same probe/widget handling,
 * partial-failure visibility, and rerun snapshot rules — and `prepareEvalRun`
 * stays the single run engine that calls this then starts the recorder.
 */
export async function authorEvalSuite(args: {
  convexClient: ReturnType<typeof createConvexClients>["convexClient"];
  tests: RunEvalsRequest["tests"];
  resolvedServerIds: string[];
  persistedServerRefs: string[];
  serverNames: string[] | undefined;
  projectId: string | undefined;
  suiteId: string | null;
  suiteName: string | undefined;
  suiteDescription: string | undefined;
  passCriteria: RunEvalsRequest["passCriteria"];
  suiteRerun: boolean | undefined;
  refreshSnapshot: boolean | undefined;
  /**
   * Caller-supplied write idempotency key (see utils/idempotency.ts). When
   * set, the suite create and EACH case create derive a stable per-row key, so
   * a retry lands on the same suite and only re-creates the cases that did not
   * commit. Per-case keys are derived from the case discriminator rather than
   * its index: a retry whose case ORDER differs must still match.
   */
  idempotencyKey?: string;
}): Promise<{
  suiteId: string;
  suiteName: string | undefined;
  caseUpsert: {
    committed: Array<{ id?: string; name: string }>;
    failed: Array<{ id?: string; name: string; error: string }>;
  };
}> {
  const {
    convexClient,
    tests,
    resolvedServerIds,
    persistedServerRefs,
    serverNames,
    projectId,
    suiteId,
    suiteName,
    suiteDescription,
    passCriteria,
    suiteRerun,
    refreshSnapshot,
    idempotencyKey,
  } = args;

  const persistedEnvironment = buildPersistedSuiteEnvironment({
    resolvedServerIds,
    persistedServerRefs,
    serverNames,
  });

  let resolvedSuiteId = suiteId ?? null;

  // Per-case upsert outcomes. We don't rollback on partial failure; the point
  // is visibility — surface which cases were committed vs. which failed so
  // the UI can show a partial-state banner instead of just a generic error.
  const committedCases: Array<{ id?: string; name: string }> = [];
  const failedCases: Array<{ id?: string; name: string; error: string }> = [];

  const testCaseMap = new Map<
    string,
    {
      title: string;
      query: string;
      runs: number;
      models: Array<{ model: string; provider: string }>;
      expectedToolCalls: any[];
      isNegativeTest?: boolean;
      scenario?: string;
      expectedOutput?: string;
      intent?: string;
      steps?: TestStep[];
      judgeRequirement?: string;
      advancedConfig?: any;
      matchOptions?: import("@/shared/eval-matching").MatchOptionsDTO;
      predicates?: import("@/shared/eval-matching").CasePredicates;
    }
  >();

  for (const test of tests) {
    const authoringSteps = resolveAuthoringSteps(test);
    const key = buildUpsertCaseKey(test);
    if (!testCaseMap.has(key)) {
      testCaseMap.set(key, {
        title: test.title,
        query: test.query,
        runs: test.runs,
        models: [],
        expectedToolCalls: test.expectedToolCalls,
        isNegativeTest: test.isNegativeTest,
        scenario: test.scenario,
        expectedOutput: test.expectedOutput,
        intent: test.intent,
        steps: authoringSteps,
        advancedConfig: test.advancedConfig,
        matchOptions: test.matchOptions,
        predicates: test.predicates,
      });
    }
    // Probe entries carry display-only model sentinels — never collect them
    // into the case's persisted model list.
    if (!isModelFree(authoringSteps)) {
      testCaseMap.get(key)!.models.push({
        model: test.model,
        provider: test.provider,
      });
    }
  }

  if (resolvedSuiteId) {
    // On a plain rerun do NOT overwrite the suite's persisted environment or
    // hostConfigId — new connected servers would silently contaminate the
    // frozen execution snapshot. Only update when explicitly refreshing or
    // on first-run (non-rerun) writes.
    const shouldUpdateSnapshot = !suiteRerun || refreshSnapshot === true;
    await convexClient.mutation("testSuites:updateTestSuite" as any, {
      suiteId: resolvedSuiteId,
      name: suiteName,
      description: suiteDescription,
      ...(shouldUpdateSnapshot ? { environment: persistedEnvironment } : {}),
      ...(shouldUpdateSnapshot && refreshSnapshot === true
        ? { refreshHostConfigFromEnvironment: true }
        : {}),
    });

    // On a suite rerun, do NOT upsert per-case fields. The wire payload
    // contains values derived from suite.defaultConfig (model substituted in
    // for model-less cases, etc.); writing them back would bake the current
    // suite default into per-case overrides and stop later default changes
    // from propagating. Cases are already persisted; rerun just runs them.
    if (suiteRerun) {
      // skip upsert
    } else {
      const existingTestCases = await convexClient.query(
        "testSuites:listTestCases" as any,
        { suiteId: resolvedSuiteId }
      );

      // Updates still go one at a time — `updateTestCase` is a different
      // mutation with no batch form, and a rerun-time edit is not the bulk
      // authoring path W0.3 exists for. Only the CREATES are deferred.
      const outcomes: Array<CaseUpsertOutcome | undefined> = [];
      const pendingCreates: Array<{
        slot: number;
        title: string;
        item: EvalCaseBatchItem;
      }> = [];

      for (const [caseDedupeKey, testCaseData] of testCaseMap.entries()) {
        const slot = outcomes.length;
        outcomes.push(undefined);
        const testCaseStepsKey = JSON.stringify(
          normalizeForComparison(testCaseData.steps || [])
        );
        const hasStepKey = (testCaseData.steps?.length ?? 0) > 0;
        const existingTestCase = existingTestCases?.find((tc: any) => {
          if (tc.title !== testCaseData.title) return false;
          // Match on `steps` only when BOTH sides carry them. A pre-migration
          // row persisted with only `query` (no `steps`) must still match a
          // steps-bearing wire payload by its legacy title+query identity —
          // otherwise the upsert creates a duplicate instead of migrating the
          // existing row forward.
          const storedHasSteps = Array.isArray(tc.steps) && tc.steps.length > 0;
          if (hasStepKey && storedHasSteps) {
            return (
              JSON.stringify(normalizeForComparison(tc.steps)) ===
              testCaseStepsKey
            );
          }
          return tc.query === testCaseData.query;
        });

        try {
          if (existingTestCase) {
            const normalize = (val: any) =>
              val === undefined || val === null ? null : val;

            const modelsChanged =
              JSON.stringify(
                normalizeForComparison(existingTestCase.models || [])
              ) !==
              JSON.stringify(normalizeForComparison(testCaseData.models || []));
            const runsChanged =
              normalize(existingTestCase.runs) !== normalize(testCaseData.runs);
            const expectedToolCallsChanged =
              JSON.stringify(
                normalizeForComparison(existingTestCase.expectedToolCalls || [])
              ) !==
              JSON.stringify(
                normalizeForComparison(testCaseData.expectedToolCalls || [])
              );
            const isNegativeTestChanged =
              normalize(existingTestCase.isNegativeTest) !==
              normalize(testCaseData.isNegativeTest);
            const scenarioChanged =
              normalize(existingTestCase.scenario) !==
              normalize(testCaseData.scenario);
            const expectedOutputChanged =
              normalize(existingTestCase.expectedOutput) !==
              normalize(testCaseData.expectedOutput);
            // Omitted intent is a preserve, not an implicit clear. Only a
            // caller that supplied the label may make an existing row differ.
            const intentChanged =
              testCaseData.intent !== undefined &&
              normalize(existingTestCase.intent) !==
                normalize(testCaseData.intent);
            const stepsChanged =
              JSON.stringify(
                normalizeForComparison(existingTestCase.steps || [])
              ) !==
              JSON.stringify(normalizeForComparison(testCaseData.steps || []));
            const judgeRequirementChanged =
              normalize(existingTestCase.judgeRequirement) !==
              normalize(testCaseData.judgeRequirement);
            const advancedConfigChanged =
              JSON.stringify(
                normalizeForComparison(existingTestCase.advancedConfig)
              ) !==
              JSON.stringify(
                normalizeForComparison(testCaseData.advancedConfig)
              );
            const matchOptionsChanged =
              JSON.stringify(
                normalizeForComparison(existingTestCase.matchOptions)
              ) !==
              JSON.stringify(normalizeForComparison(testCaseData.matchOptions));
            const predicatesChanged =
              JSON.stringify(
                normalizeForComparison(existingTestCase.predicates)
              ) !==
              JSON.stringify(normalizeForComparison(testCaseData.predicates));
            const hasChanges =
              modelsChanged ||
              runsChanged ||
              expectedToolCallsChanged ||
              isNegativeTestChanged ||
              scenarioChanged ||
              expectedOutputChanged ||
              intentChanged ||
              stepsChanged ||
              judgeRequirementChanged ||
              advancedConfigChanged ||
              matchOptionsChanged ||
              predicatesChanged;

            if (hasChanges) {
              await convexClient.mutation("testSuites:updateTestCase" as any, {
                testCaseId: existingTestCase._id,
                models: testCaseData.models,
                runs: testCaseData.runs,
                expectedToolCalls: sanitizeForConvexTransport(
                  testCaseData.expectedToolCalls
                ),
                isNegativeTest: testCaseData.isNegativeTest,
                scenario: testCaseData.scenario,
                expectedOutput: testCaseData.expectedOutput,
                ...(testCaseData.intent !== undefined
                  ? { intent: testCaseData.intent }
                  : {}),
                steps: sanitizeForConvexTransport(testCaseData.steps),
                advancedConfig: sanitizeForConvexTransport(
                  testCaseData.advancedConfig
                ),
                matchOptions: testCaseData.matchOptions,
                predicates: testCaseData.predicates,
              });
            }
            outcomes[slot] = {
              kind: "committed",
              id: String(existingTestCase._id),
              name: testCaseData.title,
            };
          } else {
            pendingCreates.push({
              slot,
              title: testCaseData.title,
              item: toCaseBatchItem(testCaseData, {
                // Discriminated by the case's dedupe key, not its index: a
                // retry whose case ORDER differs must still match.
                idempotencyKey: idempotencyKey
                  ? deriveItemIdempotencyKey(idempotencyKey, caseDedupeKey)
                  : undefined,
              }),
            });
          }
        } catch (error) {
          outcomes[slot] = {
            kind: "failed",
            id: existingTestCase ? String(existingTestCase._id) : undefined,
            name: testCaseData.title,
            error: error instanceof Error ? error.message : String(error),
          };
          logger.warn("[evals] Failed to upsert test case", {
            suiteId: resolvedSuiteId,
            title: testCaseData.title,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await commitPendingCaseCreates({
        convexClient,
        suiteId: resolvedSuiteId,
        pending: pendingCreates,
        outcomes,
      });
      flushCaseOutcomes(outcomes, committedCases, failedCases);
    }
  } else {
    const createdSuite = await convexClient.mutation(
      "testSuites:createTestSuite" as any,
      {
        projectId,
        name: suiteName!,
        description: suiteDescription,
        environment: persistedEnvironment,
        defaultPassCriteria: passCriteria,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }
    );

    if (!createdSuite?._id) {
      throw new Error("Failed to create suite");
    }

    resolvedSuiteId = createdSuite._id as string;

    const outcomes: Array<CaseUpsertOutcome | undefined> = [];
    const pendingCreates: Array<{
      slot: number;
      title: string;
      item: EvalCaseBatchItem;
    }> = [];
    for (const [caseDedupeKey, testCaseData] of testCaseMap.entries()) {
      pendingCreates.push({
        slot: outcomes.length,
        title: testCaseData.title,
        item: toCaseBatchItem(testCaseData, {
          idempotencyKey: idempotencyKey
            ? deriveItemIdempotencyKey(idempotencyKey, caseDedupeKey)
            : undefined,
        }),
      });
      outcomes.push(undefined);
    }
    await commitPendingCaseCreates({
      convexClient,
      suiteId: resolvedSuiteId,
      pending: pendingCreates,
      outcomes,
    });
    flushCaseOutcomes(outcomes, committedCases, failedCases);

    // New-suite path only: if every case create failed, the freshly-made
    // suite has zero cases. Leaving it would orphan an empty suite and (on the
    // run path) snapshot nothing into an opaque "No tests supplied" failure.
    // Roll the suite back (best-effort) and surface the structured breakdown
    // as a client error — this is a bad request, not an internal fault.
    if (committedCases.length === 0 && failedCases.length > 0) {
      const firstError = failedCases[0]?.error ?? "unknown error";
      try {
        await convexClient.mutation("testSuites:deleteTestSuite" as any, {
          suiteId: resolvedSuiteId,
        });
      } catch (rollbackError) {
        logger.warn(
          "[evals] Failed to roll back empty suite after all cases failed",
          {
            suiteId: resolvedSuiteId,
            error:
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError),
          }
        );
      }
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        `Failed to save any of ${failedCases.length} test case(s) to the new suite. ` +
          `First failure: ${firstError}. ` +
          `Suite creation aborted because it would have zero cases.`,
        { caseUpsert: { committed: committedCases, failed: failedCases } }
      );
    }
  }

  return {
    suiteId: resolvedSuiteId,
    suiteName,
    caseUpsert: {
      committed: committedCases,
      failed: failedCases,
    },
  };
}

/** Backoff schedule for {@link fetchRunPinnedSkillsWithRetry} (2 retries). */
const RUN_PINNED_SKILLS_RETRY_DELAYS_MS = [250, 1_000] as const;

/**
 * Fetch a suite run's pinned skills, retrying transient Convex failures with a
 * short backoff. A persistent failure THROWS — failing run preparation — because
 * the run record's configSnapshot and the judge both assert the pinned skills
 * were in play; silently executing without them would grade a run against
 * skills it never had. Returns `undefined` when the run has no pins.
 * `sleep` is injectable for tests.
 *
 * INS-5: the rows are returned WHOLE. This used to project each pin down to
 * `{name, description, content, contentHash}`, which was lossless while every
 * pinnable skill was SKILL.md-only — and became a silent truncation the moment
 * BE-5 started pinning folder skills. `modelRef` is how a plugin skill is
 * ADDRESSED (two plugins may declare the same `name`), `aggregateHash`
 * identifies the complete artifact rather than just the markdown envelope, and
 * `files` is the frozen `scripts/`/`references/` the run is supposed to
 * reproduce. Dropping them at the boundary meant a plugin run delivered a
 * script-less skill under an ambiguous name and reported success.
 */
export async function fetchRunPinnedSkillsWithRetry(
  // Structural: satisfied by ConvexHttpClient (whose `query` takes a typed
  // FunctionReference) and by a plain fake in tests.
  convexClient: {
    query: (name: any, ...args: any[]) => Promise<any>;
  },
  runId: string,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<RunPinnedSkill[] | undefined> {
  const attempts = RUN_PINNED_SKILLS_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = (await convexClient.query(
        "testSuites:getRunPinnedSkills" as any,
        { runId }
      )) as {
        pinnedSkills?: RunPinnedSkill[];
      };
      const list = res?.pinnedSkills ?? [];
      if (list.length === 0) return undefined;
      return list;
    } catch (error) {
      logger.warn("[evals] getRunPinnedSkills failed", {
        runId,
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      });
      if (attempt < RUN_PINNED_SKILLS_RETRY_DELAYS_MS.length) {
        await sleep(RUN_PINNED_SKILLS_RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw new Error(
    `Failed to load this run's pinned skills after ${attempts} attempts — ` +
      "aborting so the run doesn't silently execute without its skills. " +
      "Retry the run."
  );
}

/**
 * Titles of the run's cases that assert `widgetRendered`.
 *
 * Only relevant to a harness run, where the inspector's widget manager never
 * sees the tool call — the harness reaches MCP through the signed proxy — so
 * the assertion has nothing to observe. Collected here rather than inside the
 * gate because the gate is deliberately shape-agnostic about cases; this is the
 * one place that already knows the run's own step model.
 */
function casesAssertingWidgetRender(
  tests: ReadonlyArray<Record<string, any>>
): string[] {
  const titles = new Set<string>();
  for (const test of tests) {
    const steps = Array.isArray(test.steps) ? test.steps : [];
    const asserts =
      steps.some(
        (step: any) =>
          step?.kind === "assert" && step?.assertion?.type === "widgetRendered"
      ) ||
      (Array.isArray(test.successPredicates) &&
        test.successPredicates.some(
          (predicate: any) => predicate?.type === "widgetRendered"
        ));
    if (asserts) titles.add(String(test.title ?? "(untitled case)"));
  }
  return [...titles];
}

/**
 * Terminally fail a run that has a row but has not executed anything.
 *
 * `startSuiteRunWithRecorder` creates the run AND precreates its iteration
 * rows, so finalizing only the run leaves every attempt stuck pending — the
 * shape an operator sees as a run that never ends. Both writes are best-effort
 * and their failures are LOGGED, never rethrown: the caller is already
 * reporting a real cause, and masking it with a cleanup error costs the reason
 * the run failed.
 *
 * Shared by the pinned-skill setup abort and the harness admission gate: they
 * fail at the same point in the lifecycle and must leave the same wreckage
 * behind, which is exactly the invariant a second hand-written copy loses.
 */
async function failRunBeforeExecution(
  convexClient: ConvexHttpClient,
  recorder: SuiteRunRecorder,
  runId: string,
  { reason }: { reason: string }
): Promise<void> {
  const cause = reason.slice(0, 500);
  await convexClient
    .mutation("testSuites:markSetupPendingIterationsFailed" as any, {
      runId,
      error: cause,
    })
    .catch((cleanupError: unknown) =>
      logger.warn(
        "[evals] Failed to fail pending iterations after setup abort",
        {
          runId,
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
        }
      )
    );
  await recorder
    .finalize({ status: "failed", notes: cause })
    .catch((finalizeError: unknown) =>
      logger.warn("[evals] Failed to finalize run after setup abort", {
        runId,
        error:
          finalizeError instanceof Error
            ? finalizeError.message
            : String(finalizeError),
      })
    );
}

/**
 * Prepare phase of a suite run: validate, upsert suite + cases, create the
 * run record (status 'running'), store replay configs, and resolve model
 * credentials. Returns an `execute` closure over `runEvalSuiteWithAiSdk` so
 * callers choose whether to await execution inline (`runEvalsWithManager`,
 * the /api/web path) or detach it and respond immediately with the runId
 * (the async public /api/v1 path). All request/quota validation errors
 * surface here, synchronously, before any caller responds.
 */
export async function prepareEvalRun(
  clientManager: MCPClientManager,
  request: RunEvalsWithManagerRequest
): Promise<PreparedEvalRun> {
  const {
    suiteId,
    projectId,
    suiteName,
    suiteDescription,
    tests,
    serverIds,
    serverNames,
    scenarioId,
    accessVersion,
    storageServerIds,
    modelApiKeys,
    orgModelConfig,
    convexAuthToken,
    notes,
    passCriteria,
    suiteRerun,
    iterationOverride,
    caseIds,
    matchOptionsOverride,
    namedHostId,
    refreshSnapshot,
    runGroupId,
    environmentId,
    resolvedEnvironment,
    source,
    idempotencyKey,
    sourceHash,
    skillsOverride,
    ephemeralEnvironment,
    toolPolicy,
    importApprovals,
  } = request;

  if (!suiteId && (!suiteName || suiteName.trim().length === 0)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Provide suiteId or suiteName"
    );
  }
  if (!suiteId && !projectId) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "projectId is required when creating a new eval suite"
    );
  }

  // Bare suite reruns (scheduled worker, /api/v1 suiteId-only) carry no wire
  // tests — cap-math over the empty list would let unattended runs bypass
  // MAX_TOTAL_LLM_CALLS. Assert over the persisted cases instead; the wired
  // path below re-derives the same cases for execution.
  if (suiteId && tests.length === 0) {
    const { convexClient: capClient } = createConvexClients(convexAuthToken);
    const allPersistedCases = (await capClient.query(
      "testSuites:listTestCases" as any,
      { suiteId }
    )) as Parameters<typeof buildCapEntriesFromPersistedCases>[0] | null;
    // Single-case runs narrow cap-math (and the runnable check) to the chosen
    // case(s) so a one-case run of a large suite isn't rejected by the suite's
    // total cap. Mirrors the backend snapshot filter; same caseIds.
    const persistedCases =
      caseIds && caseIds.length
        ? ((allPersistedCases ?? []).filter((c: any) =>
            caseIds.includes(String(c._id))
          ) as typeof allPersistedCases)
        : allPersistedCases;
    if (caseIds && caseIds.length && (persistedCases?.length ?? 0) === 0) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "None of the requested caseIds belong to this suite"
      );
    }
    // No client substituted the suite default model onto these cases, so a
    // model-less prompt case would be silently dropped from execution. Reject
    // before cap-math so the error names the real cause, not the cap.
    //
    // NOT for an environment-backed run. The premise of this check — "nothing
    // supplies a model, so the recorder drops the case" — stops holding the
    // moment an environment is in play: `startTestSuiteRun` projects every
    // prompt case onto the environment's effective model, writes that into
    // `configSnapshot.tests`, and `precreateIterationsForRun` creates rows
    // from the projection, so the case has both a model AND somewhere to
    // record. (An environment that resolves to NO model never gets this far —
    // the backend refuses the launch with `ENV_MODEL_REQUIRED`.) Keeping the
    // check here would make an unattended env-backed rerun the one launch
    // shape that cannot run a suite the interactive UI runs fine.
    if (!environmentId) {
      assertBareRerunCasesRunnable(
        persistedCases as Parameters<typeof assertBareRerunCasesRunnable>[0]
      );
    }
    assertSuiteRunWithinCap({
      ...request,
      tests: buildCapEntriesFromPersistedCases(persistedCases ?? [], {
        environmentBacked: Boolean(environmentId),
      }),
    });
  } else {
    assertSuiteRunWithinCap(request);
  }

  const { convexClient, convexHttpUrl } = createConvexClients(convexAuthToken);

  // Environment launch (P0.1): resolve the environment's closed execution
  // set BEFORE server resolution and tool capture, and use it INSTEAD of
  // any browser-supplied serverIds. The resolved revision travels to the
  // run-start mutation as `expectedEnvironmentRevision`, so a
  // resolve-to-mutation edit rejects rather than pairing a tool snapshot
  // from one environment revision with a run snapshot from another.
  let environmentLaunch: ResolvedEnvironmentForLaunch | undefined;
  if (environmentId) {
    if (!projectId) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "projectId is required for environment runs"
      );
    }
    // Reuse the caller's preflight resolution when it is for THIS environment
    // (the manager was primed from it) so the revision we assert equals the
    // one we connected — a same-key edit after the preflight then loses the
    // revision check instead of silently pairing a stale manager with a newer
    // snapshot. Fall back to resolving here for callers that didn't preflight.
    environmentLaunch =
      resolvedEnvironment &&
      resolvedEnvironment.environmentRef.environmentId === environmentId
        ? resolvedEnvironment
        : await resolveEnvironmentForLaunch(convexClient, {
            projectId,
            environmentId,
          });
  } else if (serverIds.length === 0) {
    // Legacy launches keep the old ≥1-server contract; enforced here (not
    // in Zod) because environment launches legitimately send none.
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "At least one server must be selected"
    );
  }

  const resolvedServerIds = resolveServerIdsOrThrow(
    environmentLaunch ? environmentServerIds(environmentLaunch) : serverIds,
    clientManager
  );
  const persistedServerRefs =
    !environmentLaunch && storageServerIds && storageServerIds.length > 0
      ? storageServerIds
      : resolvedServerIds;
  const { toolSnapshot, toolSnapshotDebug } =
    await captureToolSnapshotForEvalAuthoring(
      clientManager,
      resolvedServerIds,
      {
        logPrefix: "evals",
      }
    );

  // Persist suite + cases (create or upsert). The suite/case persistence is
  // shared with the author-only public surface; `prepareEvalRun` then starts
  // the recorder below. `resolvedSuiteId`/`committedCases`/`failedCases` keep
  // their names so the run record + return below still reference them.
  const { suiteId: resolvedSuiteId, caseUpsert: authoredCaseUpsert } =
    await authorEvalSuite({
      convexClient,
      tests,
      resolvedServerIds,
      persistedServerRefs,
      serverNames,
      projectId,
      suiteId: suiteId ?? null,
      suiteName,
      suiteDescription,
      passCriteria,
      suiteRerun,
      refreshSnapshot,
      // The SAME key the run creation uses. Without it, a retried
      // /eval-runs call authors a second suite and duplicates its cases
      // BEFORE the run-level idempotency check runs — and the new suite id
      // then prevents that check from finding the original run at all.
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  const committedCases = authoredCaseUpsert.committed;
  const failedCases = authoredCaseUpsert.failed;

  const {
    runId,
    config,
    recorder,
    deduped: runWasDeduped,
    status: existingRunStatus,
    hostConfig: runHostConfigSnapshot,
    pluginVersions: runEnvironmentPluginVersions = [],
    gradingEngine: runGradingEngine,
  } = await startSuiteRunWithRecorder({
    convexClient,
    suiteId: resolvedSuiteId,
    notes,
    passCriteria,
    serverIds: resolvedServerIds,
    toolSnapshot,
    toolSnapshotDebug,
    iterationOverride,
    caseIds,
    matchOptionsOverride,
    namedHostId,
    runGroupId,
    environmentId,
    // All three preconditions come from the SAME resolution the tool snapshot
    // was captured against. The revision alone is not enough: an environment
    // pins a `hostId` and optionally an attachment, both dereferenced live, so
    // a host-config rotation or a server-group edit changes what the
    // environment resolves to at an unchanged revision. Echoing all three lets
    // the mutation reject that drift instead of starting a run whose tool
    // snapshot describes a different configuration than it executes.
    expectedEnvironmentRevision: environmentLaunch?.environmentRef.revision,
    expectedEnvironmentHostConfigId: environmentLaunch?.hostConfigId,
    expectedEnvironmentServerIds: environmentLaunch
      ? environmentEffectiveServerIds(environmentLaunch)
      : undefined,
    source,
    idempotencyKey,
    ...(sourceHash ? { sourceHash } : {}),
    skillsOverride,
    ...(ephemeralEnvironment === true ? { ephemeralEnvironment: true } : {}),
    // Named explicitly, like every other field in this call: `startSuiteRun-
    // WithRecorder` reconstructs the mutation args from its own parameters,
    // so a field nobody destructures here is a field the backend never sees —
    // and an approval that never arrives is reported to the caller as the
    // backend refusing a run they did approve.
    ...(importApprovals?.length ? { importApprovals } : {}),
  });
  const suiteHostConfig =
    runHostConfigSnapshot ??
    (await loadSuiteHostConfig(convexClient, resolvedSuiteId, namedHostId));

  // For reruns, projectId may not be in the request — derive it from the
  // suite record so org BYOK keeps working.
  let projectIdForOrgConfig: string | undefined = projectId;
  // "We asked and the suite has none" and "we could not ask" are different
  // facts, and the harness gate below reads an absent project as the FORMER.
  // Kept apart so a transient Convex failure is never reported as "this suite
  // is org-level", which would send the author to change a setting that was
  // never wrong.
  let suiteProjectLookupFailed = false;
  if (!projectIdForOrgConfig && resolvedSuiteId) {
    try {
      const suite = await convexClient.query("testSuites:getTestSuite" as any, {
        suiteId: resolvedSuiteId,
      });
      if (suite?.projectId) {
        projectIdForOrgConfig = String(suite.projectId);
      }
    } catch (error) {
      suiteProjectLookupFailed = true;
      logger.warn("[evals] Failed to load suite for projectId fallback", {
        suiteId: resolvedSuiteId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Only a HARNESS run turns an unresolved project into a refusal — an
  // emulated run merely loses its org-BYOK fallback, which is the behavior
  // this lookup has always had on failure.
  if (
    !projectIdForOrgConfig &&
    suiteProjectLookupFailed &&
    harnessOfHostConfig(suiteHostConfig)
  ) {
    const reason =
      "this run could not look up the suite's project, so the computer its " +
      "harness iterations run on cannot be provisioned or billed. This is " +
      "usually transient — retry the run.";
    await failRunBeforeExecution(convexClient, recorder, runId, { reason });
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, reason, {
      reason: "HARNESS_UNAVAILABLE",
    });
  }

  // GENERAL EXECUTION GATE — every eval run, harness or emulated.
  //
  // `resolveHostTools` warn-and-SKIPS a computer-backed built-in when no
  // computer is attached, so a `bash` host with no pinned image runs with the
  // tool silently absent: cases that needed a shell fail as if the model chose
  // badly, and a suite that did not need one reports green for a host
  // configuration that never existed. A server log is not a result.
  //
  // Deliberately NOT inside the harness checks below: those return admitted on
  // their first line when no harness is selected, which is exactly the runs
  // this rule is about.
  const executionAdmission = checkEvalExecutionAdmission({
    hostConfig: suiteHostConfig ?? null,
    pinnedComputerImageId:
      (config.environment as { computerEnvironmentId?: string } | undefined)
        ?.computerEnvironmentId ?? null,
  });
  if (!executionAdmission.ok) {
    await failRunBeforeExecution(convexClient, recorder, runId, {
      reason: executionAdmission.reason,
    });
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      executionAdmission.reason,
      { reason: "EVAL_EXECUTION_UNAVAILABLE" }
    );
  }

  // HARNESS HONESTY GATE. A host config carrying `harness` runs the REAL
  // runtime in chat and swarms; eval runs used to forward the selector into
  // `prepareChatV2` and then quietly execute on the emulated engine, reporting
  // green for a runtime that never ran. Decided HERE — after the run's host
  // config is known, before the runner touches a model — so a refusal costs
  // nothing and names the reason the shared gate gave.
  //
  // The run row already exists (`startSuiteRunWithRecorder` created it and
  // precreated its iterations), so a refusal has to finalize it rather than
  // throw and strand it running forever. Same cleanup the setup phase below
  // performs, for the same reason.
  const harnessAdmission = checkEvalHarnessAdmission({
    hostConfig: suiteHostConfig ?? null,
    // Already includes the servers the environment's pinned plugin versions
    // contribute (`environmentServerIds` projects the effective set), so the
    // gate's plugin-servers-count rule is satisfied without a second read.
    serverIds: resolvedServerIds,
    // The run's OWN snapshotted cases (`config.tests`), not the request's
    // inline tests: a bare rerun has none of the latter, and the snapshot is
    // what actually executes.
    cases: config.tests as Array<{
      title?: string;
      model?: string;
      provider?: string;
    }>,
    widgetAssertingCaseTitles: casesAssertingWidgetRender(config.tests),
    // Explicitly `null` when the suite is org-level. `runHarnessTurn` needs a
    // project to resolve the box and throws without one — mid-iteration, after
    // the box was booted and paid for. This makes it a pre-flight refusal.
    projectId: projectIdForOrgConfig ?? null,
    // NO pinned image is passed, and none is required: a harness run boots a
    // box either way — the run's frozen image when it pins one, the
    // deployment-default template when it doesn't. What it must never do is
    // borrow the acting member's personal computer, and that is prevented by
    // always provisioning, not by demanding an image.
  });
  if (!harnessAdmission.ok) {
    await failRunBeforeExecution(convexClient, recorder, runId, {
      reason: harnessAdmission.reason,
    });
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      harnessAdmission.reason,
      { reason: "HARNESS_UNAVAILABLE", harness: harnessAdmission.harness }
    );
  }
  // A NATIVE-delivery harness makes its MCP calls out of process, so the policy
  // is enforced at the MCP proxy the generated `.mcp.json` points at — sealed
  // into the proxy token, so dropping the policy drops the credential. Refused
  // only when this deployment cannot seal it. A host-executed adapter never
  // mints that token (it enforces in-process), and the refusal reads its
  // delivery off the adapter rather than off a bare "is a harness" boolean.
  const harnessPolicyRefusal = harnessToolPolicyLaunchRefusal({
    hasToolPolicy: Boolean(toolPolicy),
    harness: harnessAdmission.harness,
  });
  if (harnessPolicyRefusal) {
    await failRunBeforeExecution(convexClient, recorder, runId, {
      reason: harnessPolicyRefusal,
    });
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      harnessPolicyRefusal,
      {
        reason: "TOOL_POLICY_UNSUPPORTED",
        harness: harnessAdmission.harness,
      }
    );
  }
  // ATTRIBUTION is stamped by the platform, not here: `startTestSuiteRun`
  // derives `configSnapshot.executionEngine` from the run's own
  // `hostConfigId`, so the record cannot disagree with the config the run
  // executed under and no client can claim an engine it did not use. This
  // gate's job is to make sure the two agree in the first place — an admitted
  // harness run reaches a harness, and a refused one reaches nothing.

  const suiteInjectOpenAiCompat =
    resolveOpenAiCompatForHostConfig(suiteHostConfig);
  const suiteHostPolicy = extractHostExecutionPolicy(
    suiteHostConfig,
    namedHostId
  );

  const replayConfigsToStore = filterAndRemapReplayConfigs(
    clientManager.getServerReplayConfigs(),
    resolvedServerIds,
    persistedServerRefs
  );
  if (replayConfigsToStore.length > 0) {
    try {
      await storeReplayConfig(runId, replayConfigsToStore, convexAuthToken);
    } catch (error) {
      logger.warn("[evals] Failed to store replay config for suite run", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Resolve org model config: prefer client-sent keys, fall back to org config.
  // Treat an empty client-provided map as "no keys" so org fallback still runs.
  const hasClientKeys = !!modelApiKeys && Object.keys(modelApiKeys).length > 0;
  const resolvedModelApiKeys = hasClientKeys ? modelApiKeys : undefined;
  let resolvedOrgModelConfig = orgModelConfig;
  let resolvedOrgModelConfigTarget: { projectId: string } | undefined;
  // `projectIdForOrgConfig` is resolved ABOVE, before the admission gates —
  // the harness gate needs it to refuse an org-level suite before a box is
  // booted, and resolving it twice could disagree.
  const orgConfigTarget = projectIdForOrgConfig
    ? { projectId: projectIdForOrgConfig }
    : undefined;
  resolvedOrgModelConfigTarget = orgConfigTarget;

  if (!resolvedModelApiKeys && !resolvedOrgModelConfig) {
    if (orgConfigTarget) {
      try {
        const orgConfig = await resolveOrgModelConfig(orgConfigTarget, {
          bearerToken: convexAuthToken,
          scenarioId,
          accessVersion,
          serverIds: resolvedServerIds,
        });
        resolvedOrgModelConfig = orgConfig;
      } catch (error) {
        logger.warn("[evals] Failed to resolve org model config", {
          projectId: projectIdForOrgConfig,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // SETUP phase for this run's pinned capabilities (PR-E3, extended by INS-5).
  // Suite runs only — quick-run (runId null) has no run row to carry pins, so
  // it stays skill-free. STRICT throughout: the pin fetch is retried (250ms/1s
  // backoff), plugin pins are re-gated against the live plugin lifecycle, and
  // every pinned supporting file must be readable. Any of those failing FAILS
  // run preparation. Silently degrading to "no skills" or "fewer servers" would
  // let the run execute while the configSnapshot and the judge still claim the
  // full pinned surface was available — a green run measuring a configuration
  // that never existed.
  //
  // Everything here happens BEFORE `execute()`, which is the whole point: a
  // setup failure must precede model execution and name the component that
  // caused it.
  let pinnedSkillSource: EvalPinnedSkillSource | undefined;
  /**
   * The run's frozen skills in HARNESS shape (materialized on box), built here
   * rather than per iteration because the supporting-file download is I/O that
   * belongs in run preparation — where a failure fails the run cleanly, before
   * any model call, naming the skill and path.
   *
   * Set for EVERY runId-bearing run, empty included. The harness selects its
   * pinned source by PRESENCE, so `[]` says "this run delivers no skills" while
   * `undefined` falls through to a live project-wide fetch of whatever the
   * project holds right now — which would unfreeze a frozen run, and would hand
   * the `skillsOverride: "exclude"` arm every skill in the project.
   */
  let pinnedHarnessSkills: PinnedSkillArtifact[] | undefined;
  if (runId) {
    // The run row already exists (startSuiteRunWithRecorder created it), so a
    // persistent setup failure would otherwise strand the run as
    // running/pending forever. Finalize it as failed before rethrowing.
    try {
      const runPinnedSkills = await fetchRunPinnedSkillsWithRetry(
        convexClient,
        runId
      );

      // INS-5 — decision D2, at the last moment before execution.
      //
      // The run snapshot records which plugin VERSIONS the environment pinned.
      // That is provenance, never a standing grant: the backend re-resolves the
      // live plugin rows on every call, so a plugin disabled or uninstalled
      // since the launch resolution (seconds ago, but a race is a race) reports
      // here and stops the run. Failing NOW is the point — the run row exists,
      // no model has been called, and the failure names the component.
      //
      // Called for every run with a runId, including plugin-free ones: the
      // backend's all-clear for "pinned nothing" is the same empty envelope, so
      // there is no snapshot read to do first. A LEGACY (non-environment) run
      // cannot carry a pin at all — the environment is the only pin carrier —
      // so it tolerates a backend that predates BE-5 rather than failing for a
      // capability it structurally cannot have.
      const runPluginServers = await resolveSuiteRunPluginServers(
        () => convexClient,
        {
          runId,
          allowUndeployedBackend: !environmentLaunch,
        }
      );

      // A pinned supporting file whose blob is gone fails the run BEFORE the
      // model runs, attributed to the skill and the path. `url: null` is an
      // unreachable blob, never "no file" — see the assertion's own note.
      // Hoisted above the `length` guard so it also runs ahead of the harness
      // adaptation below, which downloads those same blobs: an unreachable one
      // should report through this assertion's wording, not a fetch failure's.
      assertPinnedSkillFilesReachable(runPinnedSkills ?? []);

      // Empty is a real answer for the harness (see `pinnedHarnessSkills`), so
      // this is assigned outside the `length` guard below.
      pinnedHarnessSkills = await runPinnedSkillsToHarnessArtifacts(
        runPinnedSkills ?? []
      );

      if (runPinnedSkills?.length) {
        pinnedSkillSource = runNeedsEffectiveSkillSurface(runPinnedSkills)
          ? {
              kind: "pinned-effective",
              capabilities: buildRunCapabilitySet({
                pins: runPinnedSkills,
                // Straight from `configSnapshot.environmentPluginVersions` —
                // the run's own record. NOT re-resolved to the plugin's active
                // version, which is what would let a mid-run re-import change
                // an in-flight run.
                pluginVersions: runEnvironmentPluginVersions,
                pluginServers: runPluginServers,
                effectiveServerIds: resolvedServerIds,
                serverNames: environmentLaunch
                  ? environmentServerNames(environmentLaunch)
                  : serverNames,
              }),
            }
          : { kind: "pinned", skills: runPinnedSkills };
      }
    } catch (error) {
      await failRunBeforeExecution(convexClient, recorder, runId, {
        reason: (error instanceof Error ? error.message : String(error)).slice(
          0,
          500
        ),
      });
      throw error;
    }
  }

  const execute = async () => {
    await runEvalSuiteWithAiSdk({
      suiteId: resolvedSuiteId,
      runId,
      config,
      modelApiKeys: resolvedModelApiKeys ?? undefined,
      orgModelConfig: resolvedOrgModelConfig,
      orgModelConfigTarget: resolvedOrgModelConfigTarget,
      convexClient,
      convexHttpUrl,
      convexAuthToken,
      mcpClientManager: clientManager,
      recorder,
      suiteInjectOpenAiCompat,
      hostExecutionPolicy: suiteHostPolicy,
      // B3b: the run's FROZEN grading-engine position, resolved once by the
      // backend at run creation and combined here with this process's env
      // ceiling. Threading it makes a per-suite `off` authoritative on the
      // FIRST pass — before, only the judge second pass (which reads the run
      // row) could see it — and is what lets a run reach `enforce` at all.
      //
      // AN ABSENT STAMP IS A DECISION, NOT A MISSING OPINION. The backend
      // writes no `gradingEngine` key at all when it resolved `off` — so the
      // snapshot of an `off` run stays byte-identical to a pre-B3b one — and
      // this resolver treats a position with no opinion as UNCONSTRAINED,
      // falling back to the env ceiling. Passing the absence straight through
      // would therefore promote every `off` run to whatever the process env
      // says the moment that var is raised, which is exactly backwards: the
      // suite ceiling, the org flag and the legacy clamp all live upstream of
      // that stamp, and an absent stamp is their combined answer.
      gradingMode: resolveFrozenRunGradingMode(runGradingEngine),
      // PR 4d: thread the raw suite hostConfig record into the runner so
      // it can resolve CONFIG fields (`systemPrompt` / `temperature` /
      // `selectedServerIds`) via `resolveExecutionContext`. `hostPolicy`
      // is the POLICY subset extracted upstream; this is the rest.
      suiteHostConfig,
      ...(pinnedSkillSource ? { pinnedSkillSource } : {}),
      // Presence is meaningful (empty ⇒ "no skills", absent ⇒ live fetch), so
      // this checks for undefined rather than truthiness.
      ...(pinnedHarnessSkills !== undefined ? { pinnedHarnessSkills } : {}),
      ...(toolPolicy ? { toolPolicy } : {}),
    });
  };

  return {
    suiteId: resolvedSuiteId,
    runId,
    caseUpsert: {
      committed: committedCases,
      failed: failedCases,
    },
    recorder,
    deduped: runWasDeduped,
    status: existingRunStatus,
    execute,
  };
}

export async function runEvalsWithManager(
  clientManager: MCPClientManager,
  request: RunEvalsWithManagerRequest
) {
  const prepared = await prepareEvalRun(clientManager, request);
  await prepared.execute();

  return {
    success: true,
    suiteId: prepared.suiteId,
    runId: prepared.runId,
    message: "Evals completed successfully. Check the Evals tab for results.",
    caseUpsert: prepared.caseUpsert,
  };
}

export type RunEvalTestCaseWithManagerOptions = {
  /** When true, skip mutating `testCase.lastMessageRun` after the run (safe for parallel quick runs on the same case). */
  skipLastMessageRunUpdate?: boolean;
};

export async function runEvalTestCaseWithManager(
  clientManager: MCPClientManager,
  request: RunTestCaseWithManagerRequest,
  options?: RunEvalTestCaseWithManagerOptions
) {
  const {
    testCaseId,
    model,
    provider,
    compareRunId,
    serverIds,
    scenarioId,
    accessVersion,
    skipLastMessageRunUpdate,
    modelApiKeys,
    orgModelConfig,
    convexAuthToken,
    testCaseOverrides,
    matchOptionsOverride,
    namedHostId,
    hostConfigOverride,
    toolPolicy,
  } = request;

  const resolvedServerIds = resolveServerIdsOrThrow(serverIds, clientManager);
  const { convexClient, convexHttpUrl } = createConvexClients(convexAuthToken);

  const testCase = await convexClient.query("testSuites:getTestCase" as any, {
    testCaseId,
  });

  if (!testCase) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Test case not found");
  }

  assertTestCaseRunWithinCap(request, 1, {
    // resolveSteps converts legacy promptTurns/probe rows so multi-turn cases
    // without persisted `steps` count their real model calls, not a floored 1.
    modelStepCount: countModelSteps(
      resolveSteps(testCase as unknown as Parameters<typeof resolveSteps>[0])
    ),
  });

  const suiteDefaultMatchOptions = await loadSuiteDefaultMatchOptions(
    convexClient,
    testCase.evalTestSuiteId
  );
  const suiteDefaultPredicates = await loadSuiteDefaultPredicates(
    convexClient,
    testCase.evalTestSuiteId
  );
  const suiteHostConfig = await loadSuiteHostConfig(
    convexClient,
    testCase.evalTestSuiteId,
    namedHostId
  );
  const effectiveHostConfig =
    (hostConfigOverride as Record<string, unknown> | undefined) ??
    suiteHostConfig;
  const suiteInjectOpenAiCompat = resolveOpenAiCompatForHostConfig(
    suiteHostConfig,
    hostConfigOverride as Record<string, unknown> | undefined
  );
  const suiteHostPolicy = extractHostExecutionPolicy(
    suiteHostConfig,
    namedHostId
  );
  // Enforced at the MCP proxy for NATIVE-delivery harness runs (see the suite
  // path); refused only where this deployment cannot seal the policy into the
  // proxy token. Host-executed delivery enforces in-process and mints no token.
  const harnessPolicyRefusal = harnessToolPolicyLaunchRefusal({
    hasToolPolicy: Boolean(toolPolicy),
    harness: harnessOfHostConfig(effectiveHostConfig),
  });
  if (harnessPolicyRefusal) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      harnessPolicyRefusal,
      { reason: "TOOL_POLICY_UNSUPPORTED" }
    );
  }

  // The same honesty gate the suite path applies, with the surface named: a
  // single-case run passes `runId: null`, and both sandbox-provisioning sites
  // require `runId !== null`, so no box is ever booted for it. A host granting
  // a computer-backed built-in would therefore execute with the tool silently
  // skipped by `resolveHostTools`. Refused instead — and the message points at
  // running the case inside a suite rather than at pinning an image, which
  // would change nothing here.
  const singleCaseAdmission = checkEvalExecutionAdmission({
    hostConfig:
      (hostConfigOverride as Record<string, unknown> | undefined) ??
      suiteHostConfig ??
      null,
    surface: "single-case",
  });
  if (!singleCaseAdmission.ok) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      singleCaseAdmission.reason,
      { reason: "EVAL_EXECUTION_UNAVAILABLE" }
    );
  }
  const suiteEnvironment = await loadSuiteEnvironment(
    convexClient,
    testCase.evalTestSuiteId
  );
  const runtimeEnvironment = buildRuntimeEnvironmentWithBindings({
    resolvedServerIds,
    suiteEnvironment,
  });
  const test = {
    title: testCase.title,
    query: testCaseOverrides?.query ?? testCase.query,
    runs: testCaseOverrides?.runs ?? 1,
    model,
    provider,
    // Freeze the authored analytics label onto the runtime case. The runner
    // carries it into each iteration snapshot; reading it live later would
    // re-attribute historical trials after a case is retagged.
    ...(typeof testCase.intent === "string" ? { intent: testCase.intent } : {}),
    expectedToolCalls:
      testCaseOverrides?.expectedToolCalls ?? testCase.expectedToolCalls ?? [],
    isNegativeTest:
      testCaseOverrides?.isNegativeTest ?? testCase.isNegativeTest,
    expectedOutput:
      testCaseOverrides?.expectedOutput ?? testCase.expectedOutput,
    steps:
      (testCaseOverrides?.steps as TestStep[] | undefined) ??
      (testCase as { steps?: TestStep[] }).steps ??
      legacyCaseStepsFallback(
        testCase as { promptTurns?: unknown; advancedConfig?: unknown }
      ),
    advancedConfig:
      testCaseOverrides?.advancedConfig ?? testCase.advancedConfig,
    matchOptions: resolveMatchOptions(
      suiteDefaultMatchOptions,
      (testCaseOverrides?.matchOptions ?? testCase.matchOptions) as
        | MatchOptionsDTO
        | undefined,
      matchOptionsOverride
    ),
    // Thread the predicate gate into the runtime case so the runner
    // evaluates it. See `resolveCaseSuccessPredicates` for the full
    // precedence rules — kept as a shared helper so all three resolution
    // sites (this function, `streamEvalTestCaseWithManager`, and the
    // suite-run recorder) stay in lockstep.
    successPredicates: resolveCaseSuccessPredicates({
      suiteDefaults: suiteDefaultPredicates,
      runOverride: testCaseOverrides?.successPredicates as
        | import("@/shared/eval-matching").Predicate[]
        | undefined,
      envelope: (testCaseOverrides?.predicates ??
        (testCase as { predicates?: unknown }).predicates) as
        | import("@/shared/eval-matching").CasePredicates
        | undefined,
      legacyCase: (testCase as { successPredicates?: unknown })
        .successPredicates as
        | import("@/shared/eval-matching").Predicate[]
        | undefined,
    }),
    hostConfigOverride: hostConfigOverride as
      | Record<string, unknown>
      | undefined,
    testCaseId: testCase._id,
  };

  // Resolve org model config: prefer client-sent keys, fall back to org config.
  // Treat an empty client-provided map as "no keys".
  const hasClientKeysForCase =
    !!modelApiKeys && Object.keys(modelApiKeys).length > 0;
  const resolvedModelApiKeys = hasClientKeysForCase ? modelApiKeys : undefined;
  let resolvedOrgModelConfig = orgModelConfig;
  const testCaseProjectId =
    typeof testCase.projectId === "string" ? testCase.projectId : undefined;
  const testCaseOrgConfigTarget = testCaseProjectId
    ? { projectId: testCaseProjectId }
    : undefined;
  if (
    !resolvedModelApiKeys &&
    !resolvedOrgModelConfig &&
    testCaseOrgConfigTarget
  ) {
    try {
      resolvedOrgModelConfig = await resolveOrgModelConfig(
        testCaseOrgConfigTarget,
        {
          bearerToken: convexAuthToken,
          scenarioId,
          accessVersion,
          serverIds: resolvedServerIds,
        }
      );
    } catch (error) {
      logger.warn("[evals] Failed to resolve org model config for test case", {
        testCaseId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const quickResult = await runEvalSuiteWithAiSdk({
    suiteId: testCase.evalTestSuiteId,
    runId: null,
    config: {
      tests: [test],
      environment: runtimeEnvironment,
    },
    modelApiKeys: resolvedModelApiKeys ?? undefined,
    orgModelConfig: resolvedOrgModelConfig,
    orgModelConfigTarget: testCaseOrgConfigTarget,
    convexClient,
    convexHttpUrl,
    convexAuthToken,
    mcpClientManager: clientManager,
    recorder: null,
    testCaseId,
    compareRunId,
    suiteInjectOpenAiCompat,
    hostExecutionPolicy: suiteHostPolicy,
    // PR 4d: see comment on the suite-run wire-up site above.
    suiteHostConfig,
    ...(toolPolicy ? { toolPolicy } : {}),
  });

  const expectedIterationId =
    quickResult?.quickRunIterationOutcomes?.[0]?.iterationId;

  let latestIteration: unknown = null;
  if (expectedIterationId) {
    latestIteration = await convexClient.query(
      "testSuites:getTestIteration" as any,
      { iterationId: expectedIterationId }
    );
  }
  if (!latestIteration) {
    const recentIterations = await convexClient.query(
      "testSuites:listTestIterations" as any,
      { testCaseId }
    );
    latestIteration = recentIterations?.[0] || null;
  }

  if (
    !options?.skipLastMessageRunUpdate &&
    !skipLastMessageRunUpdate &&
    (latestIteration as any)?._id
  ) {
    await convexClient.mutation("testSuites:updateTestCase" as any, {
      testCaseId,
      lastMessageRun: (latestIteration as any)._id,
    });
  }

  return {
    success: true,
    message: "Test case completed successfully",
    iteration: latestIteration,
  };
}

// Map each manager key back to the runtime display name the inspector client
// sent in `serverNames`. The map drives the snapshot rewrite below so the
// Convex `applyAttachmentScope` set-comparison lines up with
// `serverAttachment.resolvedServerNames` (display names) instead of the
// manager keys (Convex Ids in hosted mode).
export function buildManagerKeyToDisplayNameMap(
  clientManager: MCPClientManager,
  requestServerIds: string[],
  requestServerNames: string[] | undefined
): Map<string, string> {
  const map = new Map<string, string>();
  if (
    !requestServerNames ||
    requestServerNames.length !== requestServerIds.length
  ) {
    return map;
  }
  const available = clientManager.listServers();
  for (let i = 0; i < requestServerIds.length; i++) {
    const requestedId = requestServerIds[i];
    const displayName = requestServerNames[i];
    if (!displayName || displayName === requestedId) continue;
    const match =
      available.find((id) => id === requestedId) ??
      available.find((id) => id.toLowerCase() === requestedId.toLowerCase());
    if (!match) continue;
    if (!map.has(match)) {
      map.set(match, displayName);
    }
  }
  return map;
}

export function remapSnapshotServerIdsForAttachment(
  snapshot: ServerToolSnapshot,
  managerKeyToDisplayName: Map<string, string>
): ServerToolSnapshot {
  if (managerKeyToDisplayName.size === 0) return snapshot;
  let mutated = false;
  const servers = snapshot.servers.map((server) => {
    const displayName = managerKeyToDisplayName.get(server.serverId);
    if (!displayName || displayName === server.serverId) return server;
    mutated = true;
    return { ...server, serverId: displayName };
  });
  return mutated ? { ...snapshot, servers } : snapshot;
}

export async function generateEvalTestsWithManager(
  clientManager: MCPClientManager,
  request: GenerateTestsRequest
) {
  const resolvedServerIds = resolveServerIdsOrThrow(
    request.serverIds,
    clientManager
  );
  const { toolSnapshot: rawSnapshot } =
    await captureToolSnapshotForEvalAuthoring(
      clientManager,
      resolvedServerIds,
      {
        logPrefix: "evals.generate-tests",
      }
    );
  const toolSnapshot = remapSnapshotServerIdsForAttachment(
    rawSnapshot,
    buildManagerKeyToDisplayNameMap(
      clientManager,
      request.serverIds,
      request.serverNames
    )
  );
  const filteredTools = flattenServerToolSnapshotTools(toolSnapshot);

  if (filteredTools.length === 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "No tools found for selected servers"
    );
  }

  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }

  const tests = await generateTestCases(
    toolSnapshot,
    convexHttpUrl,
    request.convexAuthToken,
    request.serverAttachment,
    request.projectId,
    request.generationOptions
  );

  return {
    success: true,
    tests,
  };
}

export async function generateNegativeEvalTestsWithManager(
  clientManager: MCPClientManager,
  request: GenerateNegativeTestsRequest
) {
  const resolvedServerIds = resolveServerIdsOrThrow(
    request.serverIds,
    clientManager
  );
  const { toolSnapshot: rawSnapshot } =
    await captureToolSnapshotForEvalAuthoring(
      clientManager,
      resolvedServerIds,
      {
        logPrefix: "evals.generate-negative-tests",
      }
    );
  const toolSnapshot = remapSnapshotServerIdsForAttachment(
    rawSnapshot,
    buildManagerKeyToDisplayNameMap(
      clientManager,
      request.serverIds,
      request.serverNames
    )
  );
  const filteredTools = flattenServerToolSnapshotTools(toolSnapshot);

  if (filteredTools.length === 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "No tools found for selected servers"
    );
  }

  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }

  const tests = await generateNegativeTestCases(
    toolSnapshot,
    convexHttpUrl,
    request.convexAuthToken,
    request.serverAttachment,
    request.projectId
  );

  return {
    success: true,
    tests,
    evalTests: convertToEvalTestCases(tests),
  };
}

export async function streamEvalTestCaseWithManager(
  clientManager: MCPClientManager,
  request: RunTestCaseWithManagerRequest,
  options?: {
    skipLastMessageRunUpdate?: boolean;
    onStreamComplete?: () => void;
    /**
     * The HTTP request's abort signal (`c.req.raw.signal`). Aborts the
     * single-case run — including an in-flight `await`-mode task drive — when
     * the client goes away. The returned stream's own `cancel()` aborts too,
     * so either teardown path stops the work.
     */
    requestSignal?: AbortSignal;
  }
): Promise<ReadableStream<Uint8Array>> {
  const {
    testCaseId,
    model,
    provider,
    compareRunId,
    serverIds,
    scenarioId,
    accessVersion,
    skipLastMessageRunUpdate,
    modelApiKeys,
    orgModelConfig,
    convexAuthToken,
    testCaseOverrides,
    matchOptionsOverride,
    namedHostId,
    hostConfigOverride,
    toolPolicy,
  } = request;

  const resolvedServerIds = resolveServerIdsOrThrow(serverIds, clientManager);
  const { convexClient, convexHttpUrl } = createConvexClients(convexAuthToken);

  const testCase = await convexClient.query("testSuites:getTestCase" as any, {
    testCaseId,
  });

  if (!testCase) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Test case not found");
  }

  assertTestCaseRunWithinCap(request, 1, {
    // resolveSteps converts legacy promptTurns/probe rows so multi-turn cases
    // without persisted `steps` count their real model calls, not a floored 1.
    modelStepCount: countModelSteps(
      resolveSteps(testCase as unknown as Parameters<typeof resolveSteps>[0])
    ),
  });

  const suiteDefaultMatchOptions = await loadSuiteDefaultMatchOptions(
    convexClient,
    testCase.evalTestSuiteId
  );
  const suiteDefaultPredicates = await loadSuiteDefaultPredicates(
    convexClient,
    testCase.evalTestSuiteId
  );
  const suiteHostConfig = await loadSuiteHostConfig(
    convexClient,
    testCase.evalTestSuiteId,
    namedHostId
  );
  const effectiveHostConfig =
    (hostConfigOverride as Record<string, unknown> | undefined) ??
    suiteHostConfig;
  const suiteInjectOpenAiCompat = resolveOpenAiCompatForHostConfig(
    suiteHostConfig,
    hostConfigOverride as Record<string, unknown> | undefined
  );
  const suiteHostPolicy = extractHostExecutionPolicy(
    suiteHostConfig,
    namedHostId
  );
  // Enforced at the MCP proxy for NATIVE-delivery harness runs (see the suite
  // path); refused only where this deployment cannot seal the policy into the
  // proxy token. Host-executed delivery enforces in-process and mints no token.
  const harnessPolicyRefusal = harnessToolPolicyLaunchRefusal({
    hasToolPolicy: Boolean(toolPolicy),
    harness: harnessOfHostConfig(effectiveHostConfig),
  });
  if (harnessPolicyRefusal) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      harnessPolicyRefusal,
      { reason: "TOOL_POLICY_UNSUPPORTED" }
    );
  }

  // The same honesty gate the suite path applies, with the surface named: a
  // single-case run passes `runId: null`, and both sandbox-provisioning sites
  // require `runId !== null`, so no box is ever booted for it. A host granting
  // a computer-backed built-in would therefore execute with the tool silently
  // skipped by `resolveHostTools`. Refused instead — and the message points at
  // running the case inside a suite rather than at pinning an image, which
  // would change nothing here.
  const singleCaseAdmission = checkEvalExecutionAdmission({
    hostConfig:
      (hostConfigOverride as Record<string, unknown> | undefined) ??
      suiteHostConfig ??
      null,
    surface: "single-case",
  });
  if (!singleCaseAdmission.ok) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      singleCaseAdmission.reason,
      { reason: "EVAL_EXECUTION_UNAVAILABLE" }
    );
  }
  const suiteEnvironment = await loadSuiteEnvironment(
    convexClient,
    testCase.evalTestSuiteId
  );
  const runtimeEnvironment = buildRuntimeEnvironmentWithBindings({
    resolvedServerIds,
    suiteEnvironment,
  });
  const test = {
    title: testCase.title,
    query: testCaseOverrides?.query ?? testCase.query,
    runs: testCaseOverrides?.runs ?? 1,
    model,
    provider,
    // Keep quick and streamed single-case runs identical to suite runs: the
    // label is authored metadata, but it must be frozen at iteration create.
    ...(typeof testCase.intent === "string" ? { intent: testCase.intent } : {}),
    expectedToolCalls:
      testCaseOverrides?.expectedToolCalls ?? testCase.expectedToolCalls ?? [],
    isNegativeTest:
      testCaseOverrides?.isNegativeTest ?? testCase.isNegativeTest,
    expectedOutput:
      testCaseOverrides?.expectedOutput ?? testCase.expectedOutput,
    steps:
      (testCaseOverrides?.steps as TestStep[] | undefined) ??
      (testCase as { steps?: TestStep[] }).steps ??
      legacyCaseStepsFallback(
        testCase as { promptTurns?: unknown; advancedConfig?: unknown }
      ),
    advancedConfig:
      testCaseOverrides?.advancedConfig ?? testCase.advancedConfig,
    matchOptions: resolveMatchOptions(
      suiteDefaultMatchOptions,
      (testCaseOverrides?.matchOptions ?? testCase.matchOptions) as
        | MatchOptionsDTO
        | undefined,
      matchOptionsOverride
    ),
    // Thread the predicate gate into the runtime case so the runner evaluates
    // it. See `resolveCaseSuccessPredicates` for the full precedence rules.
    successPredicates: resolveCaseSuccessPredicates({
      suiteDefaults: suiteDefaultPredicates,
      runOverride: testCaseOverrides?.successPredicates as
        | import("@/shared/eval-matching").Predicate[]
        | undefined,
      envelope: (testCaseOverrides?.predicates ??
        (testCase as { predicates?: unknown }).predicates) as
        | import("@/shared/eval-matching").CasePredicates
        | undefined,
      legacyCase: (testCase as { successPredicates?: unknown })
        .successPredicates as
        | import("@/shared/eval-matching").Predicate[]
        | undefined,
    }),
    hostConfigOverride: hostConfigOverride as
      | Record<string, unknown>
      | undefined,
    testCaseId: testCase._id,
  };

  // Resolve org model config: prefer client-sent keys, fall back to org config.
  // Treat an empty client-provided map as "no keys".
  const hasClientStreamKeys =
    !!modelApiKeys && Object.keys(modelApiKeys).length > 0;
  const resolvedStreamModelApiKeys = hasClientStreamKeys
    ? modelApiKeys
    : undefined;
  let resolvedStreamOrgModelConfig = orgModelConfig;
  const streamTestCaseProjectId =
    typeof testCase.projectId === "string" ? testCase.projectId : undefined;
  const streamTestCaseOrgConfigTarget = streamTestCaseProjectId
    ? { projectId: streamTestCaseProjectId }
    : undefined;
  if (
    !resolvedStreamModelApiKeys &&
    !resolvedStreamOrgModelConfig &&
    streamTestCaseOrgConfigTarget
  ) {
    try {
      resolvedStreamOrgModelConfig = await resolveOrgModelConfig(
        streamTestCaseOrgConfigTarget,
        {
          bearerToken: convexAuthToken,
          scenarioId,
          accessVersion,
          serverIds: resolvedServerIds,
        }
      );
    } catch (error) {
      logger.warn(
        "[evals] Failed to resolve org model config for stream test case",
        {
          testCaseId,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  }

  // Mirror runEvalSuiteWithAiSdk: when a host policy is present, fetch the
  // full tool set (including app-only) so the policy can both filter and
  // count drops honestly. Without this, app-only tools are pre-stripped by
  // getToolsForAiSdk and host visibility signals are blank.
  // Host-only, and never merged with `hostConfigOverride`: a single-case
  // override must not be able to switch tasks on for a suite whose host said
  // off. Eval resolves to `await` — a run has nobody watching a handle.
  // Abort umbrella for this single-case run, fired from BOTH teardown paths:
  // the HTTP request aborting (client disconnect) and the SSE stream being
  // cancelled by its consumer. Wired into the task seam (stops an in-flight
  // `await`-mode task drive promptly instead of leaving it polling until the
  // driver timeout) and into `streamTestCase` (stops the iteration loop).
  const streamAbortController = new AbortController();
  const abortSingleCaseRun = () => {
    if (!streamAbortController.signal.aborted) {
      streamAbortController.abort(
        new Error("Eval stream aborted by the client")
      );
    }
  };
  const requestSignal = options?.requestSignal;
  if (requestSignal?.aborted) {
    abortSingleCaseRun();
  } else {
    requestSignal?.addEventListener("abort", abortSingleCaseRun, {
      once: true,
    });
  }
  const releaseRequestAbortListener = () => {
    requestSignal?.removeEventListener("abort", abortSingleCaseRun);
  };

  const singleCaseTasksSeam = resolveToolTaskSeam({
    tasksPolicy: readTasksPolicy(
      suiteHostConfig as Parameters<typeof readTasksPolicy>[0]
    ),
    surface: "eval",
    // Driver `timeoutMs` stays at its default — the task drive nests under
    // the run's own teardown, which aborts through this signal.
    await: { signal: streamAbortController.signal },
  });
  // `includeAppOnly` is tied to the PRESENCE of a host policy, not to
  // `respectToolVisibility`: eval wants the full set so the visibility gate
  // below can both filter and COUNT the drops honestly.
  const singleCaseToolOptions = mcpToolOptionsFor({
    includeAppOnly: Boolean(suiteHostPolicy),
    modelVisibleMcpToolResults: suiteHostPolicy?.modelVisibleMcpToolResults,
    tasks: singleCaseTasksSeam,
  });
  const tools = (
    singleCaseToolOptions
      ? await clientManager.getToolsForAiSdk(
          resolvedServerIds,
          singleCaseToolOptions
        )
      : await clientManager.getToolsForAiSdk(resolvedServerIds)
  ) as Record<string, any>;
  const streamToolSignals = suiteHostPolicy
    ? applyVisibilityPolicyAndCountSignals(
        tools as Record<string, unknown>,
        clientManager,
        suiteHostPolicy
      )
    : undefined;
  const encoder = new TextEncoder();

  const sseEncode = (event: EvalStreamEvent): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const outcomes = await streamTestCase({
          test,
          tools,
          selectedServers: resolvedServerIds,
          mcpClientManager: clientManager,
          recorder: null,
          modelApiKeys: resolvedStreamModelApiKeys ?? undefined,
          orgModelConfig: resolvedStreamOrgModelConfig,
          orgModelConfigTarget: streamTestCaseOrgConfigTarget,
          convexHttpUrl,
          convexAuthToken,
          convexClient,
          testCaseId,
          suiteId: testCase.evalTestSuiteId,
          runId: null,
          // Previously unwired here: without it, a cancelled stream kept the
          // iteration loop (and any awaited task) running to completion.
          abortSignal: streamAbortController.signal,
          compareRunId,
          injectOpenAiCompat: suiteInjectOpenAiCompat,
          hostPolicy: suiteHostPolicy,
          // PR 4d: thread the raw hostConfig for the streamTestCase path
          // so its runners (`streamIterationWithAiSdk` /
          // `streamIterationViaBackend`) can resolve CONFIG fields via
          // `resolveExecutionContext`. PR 5 will reduce these runners
          // further; the threading still applies in the meantime.
          suiteHostConfig,
          ...(toolPolicy ? { toolPolicy } : {}),
          toolSignals: streamToolSignals,
          environment: runtimeEnvironment,
          emit: (event: EvalStreamEvent) => {
            try {
              controller.enqueue(sseEncode(event));
            } catch {
              // controller may be closed
            }
          },
        });

        // Retrieve the finalized iteration to attach to the `complete` event.
        // The iteration is pre-created as `running` and finalized to a terminal
        // status (`completed`/`failed`/`cancelled`) by `finalizeEvalIteration`
        // right before the stream loop returns. An immediate read can race that
        // write and return either `null` (write not yet visible) or the still
        // `running` row (mid-finalize). Both are toxic to the client: a `null`
        // or non-terminal `iteration` on `complete` makes a fully-graded run
        // look like a failure — the Preview row vanishes and the user sees
        // "Compare run failed for all selected models" (telemetry: rare
        // `result=unknown` / `pending` compare_model_completed events). Poll
        // briefly for the terminal row before emitting.
        const expectedIterationId = outcomes[0]?.iterationId;
        const isTerminalIteration = (iter: unknown): boolean => {
          const status = (iter as { status?: unknown } | null)?.status;
          return (
            status === "completed" ||
            status === "failed" ||
            status === "cancelled" ||
            status === "timed_out"
          );
        };
        let latestIteration: unknown = null;
        if (expectedIterationId) {
          for (let attempt = 0; attempt < 6; attempt++) {
            latestIteration = await convexClient.query(
              "testSuites:getTestIteration" as any,
              { iterationId: expectedIterationId }
            );
            if (isTerminalIteration(latestIteration)) break;
            // Backoff ~150ms between reads; total budget ~0.75s before we fall
            // back. Don't keep the last (possibly non-terminal) read on the
            // final attempt — let the fallback try a fresh listing instead.
            if (attempt < 5) {
              await new Promise((resolve) => setTimeout(resolve, 150));
            } else {
              latestIteration = null;
            }
          }
        }
        if (!isTerminalIteration(latestIteration)) {
          const recentIterations = await convexClient.query(
            "testSuites:listTestIterations" as any,
            { testCaseId }
          );
          // Prefer a TERMINAL row so we never emit a `running` iteration on
          // `complete` (the client reads that as a failed run). Order: our own
          // created row if terminal → most recent terminal row → then the
          // non-terminal fallbacks only as a last resort.
          const byId = expectedIterationId
            ? recentIterations?.find(
                (iter: any) => iter?._id === expectedIterationId
              )
            : undefined;
          const terminalById = isTerminalIteration(byId) ? byId : undefined;
          const terminalRecent = recentIterations?.find((iter: any) =>
            isTerminalIteration(iter)
          );
          latestIteration =
            terminalById ??
            terminalRecent ??
            byId ??
            recentIterations?.[0] ??
            latestIteration;
        }

        // Update lastMessageRun
        if (
          !options?.skipLastMessageRunUpdate &&
          !skipLastMessageRunUpdate &&
          (latestIteration as any)?._id
        ) {
          await convexClient.mutation("testSuites:updateTestCase" as any, {
            testCaseId,
            lastMessageRun: (latestIteration as any)._id,
          });
        }

        // Emit complete event
        try {
          controller.enqueue(
            sseEncode({
              type: "complete",
              iterationId: expectedIterationId,
              iteration: latestIteration,
            })
          );
        } catch {
          // stream cancelled mid-run; nobody is listening
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          controller.enqueue(
            sseEncode({
              type: "error",
              message,
              details:
                error instanceof WebRouteError && error.details
                  ? JSON.stringify(error.details)
                  : undefined,
            })
          );
        } catch {
          // stream cancelled mid-run; nobody is listening
        }
      } finally {
        releaseRequestAbortListener();
        try {
          controller.close();
        } catch {
          // already closed
        }
        options?.onStreamComplete?.();
      }
    },
    cancel() {
      // The consumer walked away from the SSE stream (tab closed, fetch
      // aborted downstream of the route). Stop the run — and release the
      // request listener here too, since `start`'s finally may still be far
      // away while the iteration loop unwinds.
      abortSingleCaseRun();
      releaseRequestAbortListener();
    },
  });
}
