import { ConvexHttpClient } from "convex/browser";
import type { MCPClientManager, MCPServerReplayConfig } from "@mcpjam/sdk";
import { z } from "zod";
import { generateTestCases } from "../../services/eval-agent";
import {
  convertToEvalTestCases,
  generateNegativeTestCases,
} from "../../services/negative-test-agent";
import {
  startSuiteRunWithRecorder,
  type SuiteRunRecorder,
} from "../../services/evals/recorder";
import {
  captureToolSnapshotForEvalAuthoring,
  storeReplayConfig,
} from "../../services/evals/route-helpers";
import { loadSuiteHostConfig } from "../../services/evals/compat-runtime";
import {
  applyVisibilityPolicyAndCountSignals,
  extractHostExecutionPolicy,
  resolveOpenAiCompatForHostConfig,
} from "@mcpjam/sdk/host-config/internal";
import {
  resolveSteps,
  runEvalSuiteWithAiSdk,
  streamTestCase,
} from "../../services/evals-runner";
import type { EvalStreamEvent } from "@/shared/eval-stream-events";
import {
  probeConfigSchema,
  TEST_CASE_TYPES,
  type ProbeConfig,
  type TestCaseType,
} from "@/shared/probe-config";
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
  countModelSteps,
  isModelFree,
  normalizeSteps,
  probeConfigToToolCallStep,
  stepsSchema,
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

export const RunEvalsRequestSchema = z.object({
  projectId: z.string().optional(),
  suiteId: z.string().optional(),
  suiteName: z.string().optional(),
  suiteDescription: z.string().optional(),
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
        // Unified `TestStep[]` model — the source of truth for execution.
        // Declared explicitly so Zod does not silently strip it off the wire
        // (feedback_zod_strips_unthreaded_fields).
        steps: stepsSchema.min(1),
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
  ),
  serverIds: z
    .array(z.string())
    .min(1, { message: "At least one server must be selected" }),
  serverNames: z.array(z.string()).optional(),
  chatboxId: z.string().optional(),
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
});

export type RunEvalsRequest = z.infer<typeof RunEvalsRequestSchema>;
type RunEvalsWithManagerRequest = RunEvalsRequest & {
  orgModelConfig?: ResolvedOrgModelConfig;
  /**
   * Run origin persisted on `testSuiteRun.source`; /api/v1 passes 'api',
   * the scheduled-evals worker passes 'schedule'.
   */
  source?: "ui" | "api" | "schedule";
  /**
   * Forwarded to `startTestSuiteRun.idempotencyKey`. The scheduled worker
   * passes its trigger id so claim retries can never double-create a run.
   */
  idempotencyKey?: string;
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
  chatboxId: z.string().optional(),
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
    .optional(),
  /**
   * One-off match-option override for this single-case run only. Does
   * NOT mutate the persisted case's `matchOptions`.
   */
  matchOptionsOverride: matchOptionsSchema.optional(),
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
  }>
): RunEvalsRequest["tests"] {
  const entries: RunEvalsRequest["tests"] = [];
  for (const testCase of cases ?? []) {
    const steps = (
      Array.isArray(testCase.steps) && testCase.steps.length > 0
        ? testCase.steps
        : [{ id: "legacy-cap-prompt", kind: "prompt", prompt: "" }]
    ) as RunEvalsRequest["tests"][number]["steps"];
    // Model-free cases (no `prompt` step) need one cap entry; model cases fan
    // out per model. The cap reducer counts `prompt` steps, so a model-free
    // case contributes 0 LLM calls regardless of fanout — the entry carries
    // `steps` so the reducer sees the real count.
    const modelFree = isModelFree(steps ?? []);
    const fanout = modelFree ? 1 : Math.max(testCase.models?.length ?? 0, 1);
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
  }> | null
): void {
  const unrunnable = (cases ?? [])
    .filter(
      (c) =>
        // Model-free cases (every step is a `toolCall`/no `prompt`) need no
        // model and ARE runnable — don't flag them as unrunnable prompt cases.
        !isModelFree(Array.isArray(c.steps) ? c.steps : []) &&
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
   * Execute the prepared run to completion. `runEvalSuiteWithAiSdk` owns
   * terminal run status (completed/failed/cancelled); callers that detach
   * this (the async /api/v1 route) should still catch and defensively
   * finalize via `recorder` for errors thrown outside the runner's own
   * try.
   */
  execute: () => Promise<void>;
};

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

      for (const [, testCaseData] of testCaseMap.entries()) {
        const testCaseStepsKey = JSON.stringify(
          normalizeForComparison(testCaseData.steps || [])
        );
        const hasStepKey = (testCaseData.steps?.length ?? 0) > 0;
        const existingTestCase = existingTestCases?.find((tc: any) => {
          if (tc.title !== testCaseData.title) return false;
          if (hasStepKey || Array.isArray(tc.steps)) {
            return (
              JSON.stringify(normalizeForComparison(tc.steps || [])) ===
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
                steps: sanitizeForConvexTransport(testCaseData.steps),
                advancedConfig: sanitizeForConvexTransport(
                  testCaseData.advancedConfig
                ),
                matchOptions: testCaseData.matchOptions,
                predicates: testCaseData.predicates,
              });
            }
            committedCases.push({
              id: String(existingTestCase._id),
              name: testCaseData.title,
            });
          } else {
            await convexClient.mutation("testSuites:createTestCase" as any, {
              suiteId: resolvedSuiteId,
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
              steps: sanitizeForConvexTransport(testCaseData.steps),
              judgeRequirement: testCaseData.judgeRequirement,
              advancedConfig: sanitizeForConvexTransport(
                testCaseData.advancedConfig
              ),
              matchOptions: testCaseData.matchOptions,
              predicates: testCaseData.predicates,
            });
            committedCases.push({ name: testCaseData.title });
          }
        } catch (error) {
          failedCases.push({
            id: existingTestCase ? String(existingTestCase._id) : undefined,
            name: testCaseData.title,
            error: error instanceof Error ? error.message : String(error),
          });
          logger.warn("[evals] Failed to upsert test case", {
            suiteId: resolvedSuiteId,
            title: testCaseData.title,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
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
      }
    );

    if (!createdSuite?._id) {
      throw new Error("Failed to create suite");
    }

    resolvedSuiteId = createdSuite._id as string;

    for (const [, testCaseData] of testCaseMap.entries()) {
      try {
        await convexClient.mutation("testSuites:createTestCase" as any, {
          suiteId: resolvedSuiteId,
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
          steps: sanitizeForConvexTransport(testCaseData.steps),
          judgeRequirement: testCaseData.judgeRequirement,
          advancedConfig: sanitizeForConvexTransport(
            testCaseData.advancedConfig
          ),
          matchOptions: testCaseData.matchOptions,
          predicates: testCaseData.predicates,
        });
        committedCases.push({ name: testCaseData.title });
      } catch (error) {
        failedCases.push({
          name: testCaseData.title,
          error: error instanceof Error ? error.message : String(error),
        });
        logger.warn("[evals] Failed to create test case", {
          suiteId: resolvedSuiteId,
          title: testCaseData.title,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

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
    chatboxId,
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
    source,
    idempotencyKey,
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
    assertBareRerunCasesRunnable(
      persistedCases as Parameters<typeof assertBareRerunCasesRunnable>[0]
    );
    assertSuiteRunWithinCap({
      ...request,
      tests: buildCapEntriesFromPersistedCases(persistedCases ?? []),
    });
  } else {
    assertSuiteRunWithinCap(request);
  }

  const resolvedServerIds = resolveServerIdsOrThrow(serverIds, clientManager);
  const persistedServerRefs =
    storageServerIds && storageServerIds.length > 0
      ? storageServerIds
      : resolvedServerIds;
  const { convexClient, convexHttpUrl } = createConvexClients(convexAuthToken);
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
    });
  const committedCases = authoredCaseUpsert.committed;
  const failedCases = authoredCaseUpsert.failed;

  const {
    runId,
    config,
    recorder,
    hostConfig: runHostConfigSnapshot,
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
    source,
    idempotencyKey,
  });
  const suiteHostConfig =
    runHostConfigSnapshot ??
    (await loadSuiteHostConfig(convexClient, resolvedSuiteId, namedHostId));
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
  // For reruns, projectId may not be in the request — derive it from the
  // suite record so org BYOK keeps working.
  const hasClientKeys = !!modelApiKeys && Object.keys(modelApiKeys).length > 0;
  const resolvedModelApiKeys = hasClientKeys ? modelApiKeys : undefined;
  let resolvedOrgModelConfig = orgModelConfig;
  let resolvedOrgModelConfigTarget: { projectId: string } | undefined;
  let projectIdForOrgConfig: string | undefined = projectId;
  if (!projectIdForOrgConfig && resolvedSuiteId) {
    try {
      const suite = await convexClient.query("testSuites:getTestSuite" as any, {
        suiteId: resolvedSuiteId,
      });
      if (suite?.projectId) {
        projectIdForOrgConfig = String(suite.projectId);
      }
    } catch (error) {
      logger.warn("[evals] Failed to load suite for projectId fallback", {
        suiteId: resolvedSuiteId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const orgConfigTarget = projectIdForOrgConfig
    ? { projectId: projectIdForOrgConfig }
    : undefined;
  resolvedOrgModelConfigTarget = orgConfigTarget;

  if (!resolvedModelApiKeys && !resolvedOrgModelConfig) {
    if (orgConfigTarget) {
      try {
        const orgConfig = await resolveOrgModelConfig(orgConfigTarget, {
          bearerToken: convexAuthToken,
          chatboxId,
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
      // PR 4d: thread the raw suite hostConfig record into the runner so
      // it can resolve CONFIG fields (`systemPrompt` / `temperature` /
      // `selectedServerIds`) via `resolveExecutionContext`. `hostPolicy`
      // is the POLICY subset extracted upstream; this is the rest.
      suiteHostConfig,
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
    chatboxId,
    accessVersion,
    skipLastMessageRunUpdate,
    modelApiKeys,
    orgModelConfig,
    convexAuthToken,
    testCaseOverrides,
    matchOptionsOverride,
    namedHostId,
    hostConfigOverride,
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
  const suiteInjectOpenAiCompat = resolveOpenAiCompatForHostConfig(
    suiteHostConfig,
    hostConfigOverride as Record<string, unknown> | undefined
  );
  const suiteHostPolicy = extractHostExecutionPolicy(
    suiteHostConfig,
    namedHostId
  );
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
    expectedToolCalls:
      testCaseOverrides?.expectedToolCalls ?? testCase.expectedToolCalls ?? [],
    isNegativeTest:
      testCaseOverrides?.isNegativeTest ?? testCase.isNegativeTest,
    expectedOutput:
      testCaseOverrides?.expectedOutput ?? testCase.expectedOutput,
    steps:
      (testCaseOverrides?.steps as TestStep[] | undefined) ??
      (testCase as { steps?: TestStep[] }).steps,
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
          chatboxId,
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
  }
): Promise<ReadableStream<Uint8Array>> {
  const {
    testCaseId,
    model,
    provider,
    compareRunId,
    serverIds,
    chatboxId,
    accessVersion,
    skipLastMessageRunUpdate,
    modelApiKeys,
    orgModelConfig,
    convexAuthToken,
    testCaseOverrides,
    matchOptionsOverride,
    namedHostId,
    hostConfigOverride,
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
  const suiteInjectOpenAiCompat = resolveOpenAiCompatForHostConfig(
    suiteHostConfig,
    hostConfigOverride as Record<string, unknown> | undefined
  );
  const suiteHostPolicy = extractHostExecutionPolicy(
    suiteHostConfig,
    namedHostId
  );
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
    expectedToolCalls:
      testCaseOverrides?.expectedToolCalls ?? testCase.expectedToolCalls ?? [],
    isNegativeTest:
      testCaseOverrides?.isNegativeTest ?? testCase.isNegativeTest,
    expectedOutput:
      testCaseOverrides?.expectedOutput ?? testCase.expectedOutput,
    steps:
      (testCaseOverrides?.steps as TestStep[] | undefined) ??
      (testCase as { steps?: TestStep[] }).steps,
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
          chatboxId,
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
  const tools = (
    suiteHostPolicy
      ? await clientManager.getToolsForAiSdk(resolvedServerIds, {
          includeAppOnly: true,
        })
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
          compareRunId,
          injectOpenAiCompat: suiteInjectOpenAiCompat,
          hostPolicy: suiteHostPolicy,
          // PR 4d: thread the raw hostConfig for the streamTestCase path
          // so its runners (`streamIterationWithAiSdk` /
          // `streamIterationViaBackend`) can resolve CONFIG fields via
          // `resolveExecutionContext`. PR 5 will reduce these runners
          // further; the threading still applies in the meantime.
          suiteHostConfig,
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
            status === "cancelled"
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
          // Prefer the row we know we created; only then fall back to "most
          // recent for this case" (legacy behavior, kept as a last resort).
          const byId = expectedIterationId
            ? recentIterations?.find(
                (iter: any) => iter?._id === expectedIterationId
              )
            : undefined;
          latestIteration = byId ?? recentIterations?.[0] ?? latestIteration;
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
        controller.enqueue(
          sseEncode({
            type: "complete",
            iterationId: expectedIterationId,
            iteration: latestIteration,
          })
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
        options?.onStreamComplete?.();
      }
    },
  });
}
