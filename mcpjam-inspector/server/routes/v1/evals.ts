/**
 * Public v1 eval surface: async suite runs + polling reads.
 *
 * POST creates the run (suite/case upsert + run record, all synchronous so
 * validation and quota errors surface as normal v1 errors), then DETACHES
 * execution and responds 202 with the runId. Agents poll the GET routes for
 * status, per-iteration results (tool calls, token usage, latency), and full
 * traces. Runs land in the same Convex tables the hosted UI Runs/Cases tabs
 * read, so a human can watch the run live while the agent polls.
 *
 * Reads are thin proxies over the same Convex queries the UI uses, called
 * with the request's Convex bearer (the caller's JWT, or the short-lived
 * delegated JWT minted for WorkOS API-key callers). Convex enforces
 * membership + the delegated org scope; the routes additionally cross-check
 * the resource's projectId against the path so a valid id from another
 * project reads as NOT_FOUND.
 */
import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  toRunScoreIntegrity,
  toScoreProjection,
} from "./eval-score-projection.js";
import { toStageProjection } from "./eval-stage-projection.js";
import {
  buildEvalRunDecisionSummaryResponse,
  decisionSummaryPageIsComplete,
  parseDecisionSummaryLimit,
} from "./eval-decision-summary-projection.js";
import {
  toRunVerdictProjection,
  toSuiteVerdictPolicyDto,
} from "./eval-verdict-projection.js";
import {
  toRunCompareDto,
  type RunCompareBaseline,
} from "./eval-compare-projection.js";
import { ConvexHttpClient } from "convex/browser";
import { parseWithSchema, ErrorCode, WebRouteError } from "../web/errors.js";
import { createAuthorizedManager, callerContextFromHono } from "../web/auth.js";
import { resolveXaaIssuer } from "../../services/xaa-mint.js";
import { HOSTED_MODE } from "../../config.js";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import {
  deriveItemIdempotencyKey,
  deriveOperationIdempotencyKey,
  readAnyIdempotencyKey,
  readIdempotencyKey,
} from "../../utils/idempotency.js";
import {
  evalSuiteFileCaseImportSchema,
  IMPORT_MAPPING_STATUSES,
  opaqueIdSchema,
} from "@mcpjam/sdk/contract";
import { checkEvalHarnessStaticAdmission } from "../../services/evals/harness-admission.js";
import { loadSuiteHostConfig } from "../../services/evals/compat-runtime.js";
import {
  TERMINAL_ITERATION_STATUSES,
  TERMINAL_RUN_STATUSES,
} from "../../services/evals/run-status.js";
import { shouldSkipExecution } from "../shared/evals.js";
import {
  createEvalCasesInBatches,
  partialResultOf,
  withMintedCaseIds,
  MAX_CASES_PER_BATCH,
  type CaseBatchFailedEntry,
  type EvalCaseBatchItem,
} from "../shared/eval-case-batch.js";
import {
  RunEvalsRequestSchema,
  prepareEvalRun,
  authorEvalSuite,
  createConvexClients,
  resolveServerIdsOrThrow,
  generateEvalTestsWithManager,
  generateNegativeEvalTestsWithManager,
  type PreparedEvalRun,
  type RunEvalsRequest,
} from "../shared/evals.js";
import {
  resolveEnvironmentForLaunch,
  environmentServerIds,
  environmentServerNames,
  type ResolvedEnvironmentForLaunch,
} from "../../services/environments/resolve.js";
import {
  matchOptionsSchema,
  casePredicatesSchema,
} from "@/shared/eval-matching";
import {
  stepsSchema,
  normalizeSteps,
  isModelFree,
  deriveQuery,
  isPromptStep,
  isToolCallStep,
  isAssertStep,
  isWidgetAssertion,
  promptTurnsToSteps,
  probeConfigToToolCallStep,
  type TestStep,
} from "@/shared/steps";
import type { TestCaseType, ProbeConfig } from "@/shared/probe-config";
import type { PromptTurn } from "@/shared/steps";
import {
  assembleStepResults,
  type EvalStepReplay,
} from "@/shared/eval-step-replay";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  measureTraceBytes,
  recordEvalIterationRead,
} from "../../services/eval-trace-access-audit.js";
import { logger } from "../../utils/logger.js";
import { v1Error, v1PageJson, v1Resource } from "./envelope.js";
import { translateConvexWriteError as translateConvexError } from "./convex-errors.js";
import { loadInsightsEnvelope } from "./insights-envelope-load.js";
import { readJsonObjectBody } from "./adapter.js";
import {
  getCanonicalModelId,
  hostedModelDefinitionsFromSnapshot,
  SUPPORTED_MODELS,
} from "@/shared/types";
import { classifyModelIdProvider } from "@/shared/model-provider";
import { GOAL_COMPLETION_DEFAULTS } from "@/shared/judge-defaults";
import { isHostedCatalogModel } from "../../services/hosted-model-catalog.js";

// BYOK statics + the hosted snapshot — hosted display rows were removed from
// SUPPORTED_MODELS, so provider derivation / suggestions read both.
const MODEL_LOOKUP = [
  ...SUPPORTED_MODELS,
  ...hostedModelDefinitionsFromSnapshot(),
];

const evals = new Hono();

// ── Public authoring contract: TestStep[] ↔ internal case fields ──────
//
// The public eval surface authors cases as an ordered `steps` array
// (`TestStep[]` — see shared/steps.ts). The shared run/author pipeline now
// executes from `steps`; the older per-case fields (`query` /
// `expectedToolCalls`) remain as denormalized compatibility/display fields.
// These routes preserve `steps` and project those display fields from the same
// source so both contracts stay in sync.

/** One turn projected from the steps array: a prompt + its following asserts. */
type InternalExpectedToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
};

/** Collect the `toolCalledWith` predicate asserts that follow a prompt. */
function expectedCallsFromAsserts(
  steps: TestStep[],
): InternalExpectedToolCall[] {
  const out: InternalExpectedToolCall[] = [];
  for (const step of steps) {
    if (!isAssertStep(step)) continue;
    const a = step.assertion;
    if (isWidgetAssertion(a)) continue;
    if (a.type === "toolCalledWith") {
      out.push({ toolName: a.toolName, arguments: a.args.args ?? {} });
    }
  }
  return out;
}

/**
 * Internal display fields derived from a public `steps` array. `caseType` /
 * `probeConfig` are route-local classifiers used to detect model-free
 * render-check cases; the original `steps` array remains the persisted/run
 * source of truth.
 */
type InternalCaseFields = {
  query: string;
  expectedToolCalls?: InternalExpectedToolCall[];
  caseType?: TestCaseType;
  probeConfig?: {
    serverId?: string;
    serverName: string;
    toolName: string;
    arguments: Record<string, unknown>;
    renderTimeoutMs?: number;
  };
};

/**
 * Project a public `steps` array onto legacy display/compat fields.
 */
function stepsToInternalCaseFields(steps: TestStep[]): InternalCaseFields {
  const promptSteps = steps.filter(isPromptStep);
  const toolCallSteps = steps.filter(isToolCallStep);

  // Model-free render-check: a single deterministic toolCall, no prompt.
  if (promptSteps.length === 0 && toolCallSteps.length === 1) {
    const call = toolCallSteps[0]!;
    return {
      query: "",
      caseType: "widget_probe",
      probeConfig: {
        ...(call.serverId ? { serverId: call.serverId } : {}),
        serverName: call.serverName,
        toolName: call.toolName,
        arguments: call.arguments,
        ...(call.renderTimeoutMs !== undefined
          ? { renderTimeoutMs: call.renderTimeoutMs }
          : {}),
      },
    };
  }

  // Prompt case. Group steps into turns by `prompt`; each turn's expected
  // tool calls are the `toolCalledWith` asserts that follow it.
  const turns: Array<{ prompt: string; asserts: TestStep[] }> = [];
  let current: { prompt: string; asserts: TestStep[] } | undefined;
  for (const step of steps) {
    if (isPromptStep(step)) {
      current = { prompt: step.prompt, asserts: [] };
      turns.push(current);
    } else if (current) {
      current.asserts.push(step);
    }
  }

  if (turns.length <= 1) {
    const only = turns[0];
    return {
      query: only?.prompt ?? deriveQuery(steps),
      expectedToolCalls: expectedCallsFromAsserts(steps),
    };
  }

  return {
    query: turns[0]!.prompt,
    expectedToolCalls: [],
  };
}

function withImplicitRenderAssertForSingleToolCall(
  steps: TestStep[],
): TestStep[] {
  const normalized = normalizeSteps(steps);
  if (normalized.length !== 1 || !isToolCallStep(normalized[0]!)) {
    return normalized;
  }
  const call = normalized[0]!;
  return [
    call,
    {
      id: `${call.id}-rendered`,
      kind: "assert",
      assertion: { type: "widgetRendered", toolName: call.toolName },
    },
  ];
}

// ── Public match-option vocabulary ───────────────────────────────────
//
// DECLARED HERE, above every schema that references it, rather than beside the
// other public-model translators further down: the run schemas below are built
// at module-init time, so a later `const` would be in its temporal dead zone
// and importing this module would throw.

const PUBLIC_TOOL_CALL_ORDER = ["any", "in-order", "exact"] as const;
// Public → internal tool-call-order vocabulary (and the inverse for DTOs).
const ORDER_TO_INTERNAL = {
  any: "ignore",
  "in-order": "superset",
  exact: "strict",
} as const;
const ORDER_TO_PUBLIC: Record<string, (typeof PUBLIC_TOOL_CALL_ORDER)[number]> =
  { ignore: "any", superset: "in-order", strict: "exact" };

const publicMatchOptionsSchema = z
  .object({
    toolCallOrder: z.enum(PUBLIC_TOOL_CALL_ORDER).optional(),
    extraToolCalls: z
      .union([z.literal("unlimited"), z.number().int().min(0)])
      .optional(),
    arguments: z.enum(["ignore", "partial", "exact"]).optional(),
  })
  .strict();
type PublicMatchOptions = z.infer<typeof publicMatchOptionsSchema>;

function toInternalMatchOptions(
  mo: PublicMatchOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (mo.toolCallOrder !== undefined)
    out.toolCallOrder = ORDER_TO_INTERNAL[mo.toolCallOrder];
  if (mo.extraToolCalls !== undefined)
    out.maxExtraToolCalls =
      mo.extraToolCalls === "unlimited" ? null : mo.extraToolCalls;
  if (mo.arguments !== undefined) out.argumentMatching = mo.arguments;
  return out;
}


/**
 * Fold a run's `matchOptionsOverride` — sent in EITHER the public or the
 * internal vocabulary — down to the internal shape the pipeline consumes.
 *
 * The two schemas are `.strict()` and their vocabularies are disjoint (public
 * `any|in-order|exact` / `extraToolCalls` / `arguments` versus internal
 * `ignore|superset|strict` / `maxExtraToolCalls` / `argumentMatching`), so a
 * body can only satisfy one of them and a re-parse is a reliable discriminant.
 * An EMPTY object parses as public and normalizes to an empty override, which
 * is the same no-op either way.
 */
function normalizeRunMatchOptionsOverride(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const asPublic = publicMatchOptionsSchema.safeParse(value);
  return asPublic.success
    ? toInternalMatchOptions(asPublic.data)
    : (value as Record<string, unknown>);
}

// ── Request schema ───────────────────────────────────────────────────

const MAX_V1_TESTS = 100;

// Public inline-test shape for run-create. The case body is the `steps`
// contract (`TestStep[]`); model/provider/runs are required (no suite-level
// defaults exist on the run path). `stepsToInternalCaseFields` projects each
// case onto the internal run-schema fields before `prepareEvalRun`.
const publicInlineTestSchema = z.object({
  title: z.string().min(1),
  steps: stepsSchema.min(1),
  runs: z.number().int().positive().max(10),
  model: z.string().min(1),
  provider: z.string().min(1),
  expectedOutput: z.string().optional(),
  isNegativeTest: z.boolean().optional(),
  scenario: z.string().optional(),
  advancedConfig: z
    .object({
      system: z.string().optional(),
      temperature: z.number().optional(),
      toolChoice: z.any().optional(),
    })
    .passthrough()
    .optional(),
  matchOptions: matchOptionsSchema.optional(),
  predicates: casePredicatesSchema.optional(),
});
type PublicInlineTest = z.infer<typeof publicInlineTestSchema>;

/** Project a public inline test (`steps`) onto the internal run-schema test. */
function publicInlineTestToRunTest(
  test: PublicInlineTest,
): RunEvalsRequest["tests"][number] {
  const derived = stepsToInternalCaseFields(test.steps as TestStep[]);
  return {
    title: test.title,
    steps: withImplicitRenderAssertForSingleToolCall(test.steps as TestStep[]),
    query: derived.query,
    runs: test.runs,
    model: test.model,
    provider: test.provider,
    expectedToolCalls: derived.expectedToolCalls ?? [],
    ...(test.expectedOutput !== undefined
      ? { expectedOutput: test.expectedOutput }
      : {}),
    ...(test.isNegativeTest !== undefined
      ? { isNegativeTest: test.isNegativeTest }
      : {}),
    ...(test.scenario !== undefined ? { scenario: test.scenario } : {}),
    ...(test.advancedConfig !== undefined
      ? { advancedConfig: test.advancedConfig }
      : {}),
    ...(test.matchOptions !== undefined
      ? { matchOptions: test.matchOptions }
      : {}),
    ...(test.predicates !== undefined ? { predicates: test.predicates } : {}),
  };
}

// Public shape: the web RunEvalsRequestSchema minus hosted-app plumbing the
// public surface must not accept (`convexAuthToken` comes from the bearer;
// scenario/access/storage fields are hosted-client concerns) and minus the
// internal-contract `tests` (replaced by the public `steps`-based shape).
const createEvalRunSchema = RunEvalsRequestSchema.omit({
  convexAuthToken: true,
  scenarioId: true,
  accessVersion: true,
  storageServerIds: true,
  tests: true,
})
  .extend({
    // Inline tests are optional on the public surface: a bare `suiteId`
    // rerun is the simplest possible call.
    tests: z.array(publicInlineTestSchema).max(MAX_V1_TESTS).default([]),
    // Optional on reruns: when omitted with a `suiteId`, the route derives
    // the suite's saved server selection (the set the run snapshot will
    // reference) via `testSuites:getSuiteRunServerSelection`, so the
    // manager connects exactly what the run needs.
    serverIds: RunEvalsRequestSchema.shape.serverIds.optional(),
    // The PUBLIC match-option vocabulary (`any|in-order|exact`,
    // `extraToolCalls`, `arguments`) alongside the internal one this route
    // already accepted. A union rather than a replacement, because the
    // internal shape is what existing callers send and the two enums are
    // disjoint — a body can only satisfy one. Normalized to the internal shape
    // before `prepareEvalRun`, so nothing downstream learns there were two.
    matchOptionsOverride: z
      .union([publicMatchOptionsSchema, matchOptionsSchema])
      .optional(),
  })
  // STRICT on the object, before the refinements: ZodEffects has no `.strict()`.
  // An unknown key is a 400, not a silently-dropped field on a spend route.
  .strict()
  .refine((body) => body.suiteId || (body.tests?.length ?? 0) > 0, {
    message: "Provide suiteId (rerun) and/or inline tests",
  })
  // An environment is only launchable through a suite that has it ATTACHED
  // (`suite.environmentIds`), and the backend rejects an unattached one. Without
  // this the schema would admit `environmentId` alone, and the rejection would
  // land AFTER inline suite/case authoring — a partial write for a request that
  // was never satisfiable. Requiring `suiteId` up front lets the handler check
  // attachment before it authors or connects anything.
  .refine((body) => !body.environmentId || Boolean(body.suiteId), {
    message:
      "suiteId is required with environmentId — an environment runs through a suite that has it attached (set the suite's environments first).",
  })
  // Mutually exclusive, and rejected rather than silently resolved one way:
  // an environment supplies a CLOSED server set, so honoring `serverIds` too
  // would make the connected servers disagree with the environment snapshot the
  // run is stamped with. The same guard lives in the SDK ops' execute bodies —
  // the CLI calls those directly and never parses this schema.
  .refine(
    (body) => !body.environmentId || (body.serverIds?.length ?? 0) === 0,
    {
      message:
        "environmentId and serverIds are mutually exclusive — an environment supplies its own closed server set.",
    },
  )
  // An environment supplies its own closed server set, so it satisfies this
  // requirement the same way a suite's saved selection does — an environment
  // run legitimately sends zero serverIds.
  .refine(
    (body) =>
      body.suiteId || body.environmentId || (body.serverIds?.length ?? 0) > 0,
    {
      message:
        "serverIds are required when creating a new suite without an environment",
    },
  );

// ── Author-only suite-create schema ──────────────────────────────────

// Ergonomic body for author-only suite creation. NOT `RunEvalsRequestSchema`:
// per-test `runs`/`model`/`provider` are optional here and filled from
// suite-level defaults by `normalizeCreateTestsToRunTests` before the strict
// run schema validates them. The case body is the public `steps` contract
// (`TestStep[]`), projected to the internal case fields by that normalizer.
const createEvalSuiteSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  serverIds: z.array(z.string()).min(1),
  serverNames: z.array(z.string()).optional(),
  model: z.string().min(1),
  provider: z.string().optional(),
  passCriteria: z.object({ minimumPassRate: z.number() }).optional(),
  // Accepted for forward-compat; the current Convex suite/case mutations do
  // not persist tags, so this is a no-op today (documented as such).
  tags: z.array(z.string()).optional(),
  tests: z
    .array(
      z.object({
        title: z.string().min(1),
        // The unified test-step model. The first `prompt` step is the case
        // query; `toolCalledWith` asserts are the expected tool calls; a
        // single model-free `toolCall` step is a render-check.
        steps: stepsSchema.min(1),
        runs: z.number().int().min(1).max(10).optional(),
        model: z.string().optional(),
        provider: z.string().optional(),
        expectedOutput: z.string().optional(),
        isNegativeTest: z.boolean().optional(),
        scenario: z.string().optional(),
        advancedConfig: z
          .object({
            system: z.string().optional(),
            temperature: z.number().optional(),
            toolChoice: z.any().optional(),
          })
          .passthrough()
          .optional(),
        matchOptions: matchOptionsSchema.optional(),
        predicates: casePredicatesSchema.optional(),
      }),
    )
    .min(1)
    .max(MAX_V1_TESTS),
});

type CreateEvalSuiteBody = z.infer<typeof createEvalSuiteSchema>;

const SOURCE_HASH_PATTERN = /^[a-f0-9]{64}$/;

const evalSuiteFileProvenanceWireSchema = z
  .object({
    sourceHash: z.string().min(1),
    sourceFormat: z.string().min(1),
    sourceFormatVersion: z.string().min(1).optional(),
    converter: z.string().min(1).optional(),
    converterVersion: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    discoverySnapshotHash: z.string().min(1).optional(),
    reportHash: z.string().min(1),
    importedAt: z.string().optional(),
  })
  .strict();

/**
 * Body for `POST /eval-suites/from-file`: resolve or create a file-owned
 * suite by declared id. The inspector parses the suite file; this is the
 * declared identity + provenance + hosted settings, not the raw file.
 */
const syncFileOwnedSuiteSchema = z
  .object({
    declaredSuiteId: opaqueIdSchema,
    name: z.string().trim().min(1).max(200),
    description: z.string().optional(),
    sourceHash: z
      .string()
      .regex(
        SOURCE_HASH_PATTERN,
        "sourceHash must be a 64-character lowercase SHA-256 hex digest",
      ),
    provenance: evalSuiteFileProvenanceWireSchema.optional(),
    environment: z
      .object({
        servers: z.array(z.string()).optional(),
        serverBindings: z
          .array(
            z.object({
              serverName: z.string(),
              projectServerId: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    defaultConfig: z
      .object({
        modelId: z.string(),
        systemPrompt: z.string().optional(),
        temperature: z.number().optional(),
      })
      .optional(),
    verdictPolicyVersion: z.literal(2).optional(),
    verdictPolicyDefaults: z
      .object({
        repetitions: z.number().int().min(1).max(100),
        passThreshold: z.number().min(0).max(1),
        validity: z
          .object({
            minEligibleTrials: z.number().int().min(0).optional(),
            minCompletionRate: z.number().min(0).max(1).optional(),
            maxEvaluatorErrorRate: z.number().min(0).max(1).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    minIterations: z.number().int().min(1).max(10).optional(),
    defaultPassCriteria: z
      .object({
        minimumPassRate: z.number(),
      })
      .optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const hasVersion = body.verdictPolicyVersion !== undefined;
    const hasDefaults = body.verdictPolicyDefaults !== undefined;
    if (hasVersion !== hasDefaults) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasVersion ? "verdictPolicyDefaults" : "verdictPolicyVersion"],
        message:
          "verdictPolicyVersion and verdictPolicyDefaults must be supplied together.",
      });
    }
  });

/**
 * Expand the ergonomic authoring tests into the full
 * `RunEvalsRequestSchema.shape.tests` element shape: fill `runs`, resolve
 * model/provider from suite defaults (deriving provider from a `provider/model`
 * id when neither is given), preserve each case's public `steps` array, and
 * project denormalized `query` / `expectedToolCalls` display fields from it.
 */
function normalizeCreateTestsToRunTests(
  tests: CreateEvalSuiteBody["tests"],
  suite: { model: string; provider?: string },
): RunEvalsRequest["tests"] {
  return tests.map((test) => {
    const runs = test.runs ?? 1;
    // Trimmed — and rejected when blank — for the same reason as
    // `toPersistedModelEntry`: this id is what gets stored on the case and
    // handed to the provider, and an explicit `provider` would otherwise carry
    // a blank model past validation.
    const model = requireNonBlankModelId(test.model ?? suite.model);
    // The CANONICAL resolver, not a prefix split. Splitting derived
    // "meta-llama" and "mistralai" as providers (they are aliases for `meta`
    // and `mistral`) and refused every `custom:<slug>:<model>` id outright,
    // because it has no slash. It is total for a non-blank id, so there is no
    // "couldn't derive it" case left to raise here.
    const provider = deriveProvider(model, test.provider ?? suite.provider);
    const derived = stepsToInternalCaseFields(test.steps as TestStep[]);
    return {
      title: test.title,
      steps: withImplicitRenderAssertForSingleToolCall(
        test.steps as TestStep[],
      ),
      query: derived.query,
      runs,
      model,
      provider,
      expectedToolCalls: derived.expectedToolCalls ?? [],
      ...(test.expectedOutput !== undefined
        ? { expectedOutput: test.expectedOutput }
        : {}),
      ...(test.isNegativeTest !== undefined
        ? { isNegativeTest: test.isNegativeTest }
        : {}),
      ...(test.scenario !== undefined ? { scenario: test.scenario } : {}),
      ...(test.advancedConfig !== undefined
        ? { advancedConfig: test.advancedConfig }
        : {}),
      ...(test.matchOptions !== undefined
        ? { matchOptions: test.matchOptions }
        : {}),
      ...(test.predicates !== undefined ? { predicates: test.predicates } : {}),
    };
  });
}

// ── Model validation ─────────────────────────────────────────────────

/**
 * Providers whose model namespace we cannot enumerate (local/self-hosted
 * runtimes). Tests targeting them skip catalog validation entirely.
 */
const OPEN_MODEL_PROVIDERS = new Set(["custom", "ollama"]);

/**
 * Reject inline tests whose model can never execute BEFORE creating the run.
 * Without this, an unknown model id (e.g. a raw Anthropic API id like
 * "claude-sonnet-4-6" instead of the catalog's hosted
 * "anthropic/claude-haiku-4.5") is accepted with a 202, and the run
 * "completes" as failed with zero tokens and an opaque stream error — the
 * caller has no signal that the request itself was wrong.
 *
 * A test is admitted when any of these hold:
 *  - it resolves to an MCPJam-provided (hosted) model — runs on org credits;
 *  - the caller supplied a `modelApiKeys` entry for its provider — BYOK, the
 *    provider validates the id itself;
 *  - its provider's namespace is open (custom/ollama) — not enumerable;
 *  - the id is in the shared catalog — org-level BYOK keys may cover it
 *    (the runner resolves those; we can't see them at create time).
 * Everything else is a VALIDATION_ERROR naming the test and suggesting the
 * hosted ids for that provider.
 */
export function assertInlineTestModelsValid(
  tests: ReadonlyArray<{ title: string; model: string; provider: string }>,
  modelApiKeys: Record<string, string> | undefined,
): void {
  for (const test of tests) {
    const provider = test.provider.trim().toLowerCase();
    if (OPEN_MODEL_PROVIDERS.has(provider)) continue;
    const canonical = getCanonicalModelId(test.model, test.provider);
    if (isHostedCatalogModel(canonical, test.provider)) continue;
    if (modelApiKeys?.[test.provider] ?? modelApiKeys?.[provider]) continue;
    if (MODEL_LOOKUP.some((model) => String(model.id) === canonical)) continue;

    const hostedIds = MODEL_LOOKUP.filter(
      (m) =>
        String(m.provider).toLowerCase() === provider &&
        isHostedCatalogModel(String(m.id), m.provider),
    ).map((m) => String(m.id));
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Unknown model "${test.model}" (provider "${test.provider}") in test "${test.title}". ` +
        `Use a hosted model id, or pass modelApiKeys["${test.provider}"] to bring your own key.`,
      {
        model: test.model,
        provider: test.provider,
        ...(hostedIds.length > 0 ? { hostedModels: hostedIds } : {}),
      },
    );
  }
}

// ── Concurrency gate ─────────────────────────────────────────────────

// Per-org cap on detached runs in THIS process. Railway runs a single
// Inspector instance today; if that changes this becomes per-instance,
// which is acceptable (the backend run/iteration quotas remain global).
//
// Exported for tests. A malformed env value (`Number("bad")` → NaN) must
// fall back to the default rather than disabling the gate: every `>=`
// comparison against NaN is false, which would admit unlimited runs.
export function parseMaxConcurrentRuns(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 2;
}
const MAX_CONCURRENT_RUNS = parseMaxConcurrentRuns(
  process.env.V1_MAX_CONCURRENT_EVAL_RUNS,
);
const activeRunsByOrg = new Map<string, number>();

function orgConcurrencyKey(c: any): string {
  const orgOrUser = c.get("mcpjamOrganizationId") ?? c.get("workosUserId");
  if (orgOrUser) {
    return orgOrUser;
  }
  // Only the API-key middleware sets WorkOS/org context; JWT callers would
  // otherwise all share one "anonymous" bucket. Key them by a digest of the
  // bearer instead — per-caller, without holding the raw token in the map.
  const authHeader = c.req.header("authorization");
  return authHeader
    ? createHash("sha256").update(authHeader).digest("hex")
    : "anonymous";
}

function tryAcquireRunSlot(key: string): boolean {
  const active = activeRunsByOrg.get(key) ?? 0;
  if (active >= MAX_CONCURRENT_RUNS) {
    return false;
  }
  activeRunsByOrg.set(key, active + 1);
  return true;
}

function releaseRunSlot(key: string): void {
  const active = activeRunsByOrg.get(key) ?? 0;
  if (active <= 1) {
    activeRunsByOrg.delete(key);
  } else {
    activeRunsByOrg.set(key, active - 1);
  }
}

/**
 * ONE slot for a whole fan-out, refcounted across its sibling runs.
 *
 * A grouped launch is one intent, so it costs one slot. Charging N would make
 * a 3-target fan-out unlaunchable under the default cap of 2; charging ZERO
 * would let a caller run unbounded work by wrapping it in a group. The slot is
 * held until the LAST sibling settles, so a group can never release it while it
 * still has runs in flight.
 *
 * `remaining` starts at the target count and every target decrements it EXACTLY
 * ONCE, through one of two paths: a target that reaches background execution
 * decrements in its `.finally`; a target whose launch throws before that never
 * gets a `.finally`, so the launch loop's catch decrements for it. Missing the
 * second path is how an all-failed group leaks its slot and bricks the
 * organization's quota until the process restarts.
 */
interface RunGroupSlot {
  key: string;
  remaining: number;
  released: boolean;
}

function tryAcquireRunGroupSlot(
  key: string,
  targetCount: number,
): RunGroupSlot | null {
  if (!tryAcquireRunSlot(key)) return null;
  return { key, remaining: targetCount, released: false };
}

/** Drop one reference; release the org slot when the last one goes. */
function releaseRunGroupSlotRef(slot: RunGroupSlot): void {
  if (slot.released) return;
  slot.remaining -= 1;
  if (slot.remaining > 0) return;
  slot.released = true;
  releaseRunSlot(slot.key);
}

/**
 * Upper bound on a single fan-out. Deliberately the same number as a suite's
 * environment cap: the attachments ARE the targets, so a larger bound could
 * never be reached by the axis it exists to bound, and a smaller one would
 * refuse a fan-out over a legal set of attachments.
 */
export const MAX_RUN_GROUP_TARGETS = 10;

// ── Convex read client ───────────────────────────────────────────────

function createConvexReadClient(convexAuthToken: string): ConvexHttpClient {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_URL configuration",
    );
  }
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(convexAuthToken);
  return client;
}

/**
 * Convex throws generic Errors from queries; the common authorization
 * failures ("not found", "unauthorized", "Not a member") all mean the same
 * thing to a v1 caller: this run/suite is not visible to you.
 */
function isConvexNotVisibleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|unauthorized|not a member/i.test(message);
}

/**
 * Map a launch-resolution failure onto the public envelope. The environment
 * exists and is readable, but cannot currently produce a runnable
 * configuration (a pinned plugin was disabled, the host was deleted, the
 * closed server set came out empty) — that is a 409 conflict, not bad input,
 * and the machine-readable `ENV_*` code rides along in `details` so callers can
 * branch on the reason. Mirrors `/v1/projects/:p/environments/:e/resolve`.
 */
function translateEnvironmentResolveError(error: unknown): unknown {
  if (error instanceof WebRouteError) return error;
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const code = (data as { code?: unknown }).code;
    const message = (data as { message?: unknown }).message;
    if (typeof code === "string" && code.startsWith("ENV_")) {
      if (code === "ENV_NOT_FOUND" || code === "ENV_CROSS_PROJECT") {
        return new WebRouteError(
          404,
          ErrorCode.NOT_FOUND,
          "Environment not found",
        );
      }
      return new WebRouteError(
        409,
        ErrorCode.CONFLICT,
        typeof message === "string"
          ? message
          : "Environment cannot be launched right now.",
        { code },
      );
    }
  }
  return error;
}

function requireProjectMatch(
  resource: { projectId?: unknown } | null | undefined,
  projectId: string,
  what: string,
): void {
  if (!resource || String(resource.projectId ?? "") !== projectId) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, `${what} not found`);
  }
}

/**
 * Read a suite and assert it belongs to the path's project. Convex enforces
 * membership; the project cross-check makes a valid id from ANOTHER of the
 * caller's projects read as NOT_FOUND rather than leaking across the scope the
 * path declares.
 */
async function readSuiteInProject(
  convexAuthToken: string,
  projectId: string,
  suiteId: string,
): Promise<SuiteDoc> {
  let suite: SuiteDoc | null;
  try {
    suite = await createConvexReadClient(convexAuthToken).query(
      "testSuites:getTestSuite" as any,
      { suiteId },
    );
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval suite not found");
    }
    throw error;
  }
  requireProjectMatch(suite, projectId, "Eval suite");
  return suite!;
}

/** A suite's attached project environments, in attach order. */
function suiteEnvironmentIds(suite: SuiteDoc | null | undefined): string[] {
  return Array.isArray(suite?.environmentIds)
    ? suite!.environmentIds.map(String)
    : [];
}

/**
 * `"name" (id)` labels for the suite's attached environments, so an
 * environment 400 tells the caller which values ARE acceptable instead of
 * making them go look. Best-effort by design: a failed listing degrades to
 * bare ids rather than turning a clean 400 into a 500.
 */
async function describeAttachedEnvironments(
  convexAuthToken: string,
  projectId: string,
  environmentIds: string[],
): Promise<string> {
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows =
      ((await createConvexReadClient(convexAuthToken).query(
        "projectEnvironments:listEnvironments" as any,
        { projectId, includeArchived: true },
      )) as Array<Record<string, unknown>> | null) ?? [];
  } catch {
    rows = [];
  }
  const nameById = new Map(
    rows.map((row) => [
      String(row.environmentId ?? ""),
      String(row.name ?? ""),
    ]),
  );
  return environmentIds
    .map((id) => {
      const name = nameById.get(id);
      return name ? `"${name}" (${id})` : id;
    })
    .join(", ");
}

/**
 * Decide which project environment an eval operation on `suite` targets, and
 * reject every configuration the backend would refuse — HERE, at the route,
 * before any side effect (suite/case authoring, MCP connections, credit spend).
 *
 * SDK-side prevalidation would not protect a raw API caller and could not close
 * the race with a concurrent attachment edit, so this is the authoritative gate.
 * These messages are the route's own, so they survive Convex's production error
 * redaction — which is why the backend's equivalent rejections are not enough.
 *
 * Returns the environment id to launch with, or `undefined` for a legacy
 * (saved-server-selection) launch.
 *
 *  - explicit id      → must be attached to the suite, else 400;
 *  - omitted, 0 attached → legacy;
 *  - omitted, 1 attached → auto-selected. The backend resolves the sole
 *    attached environment for the run REGARDLESS, so deriving legacy servers
 *    here would connect one server set while stamping another into the run's
 *    `configSnapshot.environmentRef`;
 *  - omitted, >1 attached → 400 naming the candidates (the backend's own
 *    ambiguity rejection, surfaced before the work).
 *
 * Explicit servers on an environment-based suite are likewise a 400 rather than
 * a silent no-op: environment resolution wins outright in `startTestSuiteRun`,
 * so the override would be accepted and then ignored.
 */
async function assertEphemeralEnvironmentLaunchable(
  convexAuthToken: string,
  projectId: string,
  environmentId: string,
): Promise<void> {
  const convex = createConvexReadClient(convexAuthToken);
  let row: {
    environmentId?: string;
    projectId?: string;
    archivedAt?: number;
    name?: string;
  } | null;
  try {
    row = (await convex.query(
      "projectEnvironments:getEnvironment" as any,
      { projectId, environmentId } as any,
    )) as typeof row;
  } catch (error) {
    throw translateConvexError(error);
  }
  if (!row) {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      `Environment ${environmentId} was not found in this project.`,
      { reason: "ENVIRONMENT_NOT_FOUND", environmentId },
    );
  }
  if (row.archivedAt !== undefined) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Environment ${row.name ?? environmentId} is archived and cannot be launched.`,
      { reason: "ENVIRONMENT_ARCHIVED", environmentId },
    );
  }
}

async function selectSuiteEnvironmentId(params: {
  convexAuthToken: string;
  projectId: string;
  suite: SuiteDoc;
  requestedEnvironmentId?: string;
  /** Whether the caller supplied a non-empty server override. */
  hasServerOverride: boolean;
  /** The request field that carries that override, for the 400 message. */
  serverField: string;
  /**
   * Compose-and-run: skip suite membership for a project-scoped, live env.
   * Still requires an explicit `requestedEnvironmentId`.
   */
  ephemeralEnvironment?: boolean;
}): Promise<string | undefined> {
  const {
    convexAuthToken,
    projectId,
    suite,
    requestedEnvironmentId,
    hasServerOverride,
    serverField,
    ephemeralEnvironment,
  } = params;
  const attached = suiteEnvironmentIds(suite);
  const describe = () =>
    describeAttachedEnvironments(convexAuthToken, projectId, attached);

  if (attached.length > 0 && hasServerOverride) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `This suite runs against project environments, which supply a closed server set that ${serverField} cannot override. Remove ${serverField}, or detach the suite's environments first.`,
      {
        reason: "ENVIRONMENT_SERVERS_NOT_OVERRIDABLE",
        environmentIds: attached,
      },
    );
  }

  if (requestedEnvironmentId) {
    if (ephemeralEnvironment === true) {
      await assertEphemeralEnvironmentLaunchable(
        convexAuthToken,
        projectId,
        requestedEnvironmentId,
      );
      return requestedEnvironmentId;
    }
    if (!attached.includes(requestedEnvironmentId)) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        attached.length === 0
          ? `Environment ${requestedEnvironmentId} is not attached to this suite, which has no environments at all. Attach it first (PATCH the suite with environmentIds), then retry.`
          : `Environment ${requestedEnvironmentId} is not attached to this suite. Attached environments: ${await describe()}.`,
        {
          reason: "ENVIRONMENT_NOT_ATTACHED",
          environmentId: requestedEnvironmentId,
          environmentIds: attached,
        },
      );
    }
    return requestedEnvironmentId;
  }

  if (attached.length === 0) return undefined;
  if (attached.length === 1) return attached[0];
  throw new WebRouteError(
    400,
    ErrorCode.VALIDATION_ERROR,
    `This suite has multiple environments; name the one to use. Attached environments: ${await describe()}.`,
    { reason: "ENVIRONMENT_REQUIRED", environmentIds: attached },
  );
}

/**
 * Reject an `environmentIds` change that would strand the suite's schedule,
 * BEFORE the PATCH applies anything else.
 *
 * `setSuiteEnvironments` enforces this itself, but it runs last in a handler
 * that has already committed the name/description/hosts/executionConfig edits
 * by then — so a rejection there would return 400 with those edits persisted.
 * Prechecking here makes the common case ("you'd strand the schedule") leave
 * the suite untouched. The backend check remains the authority: it is the one
 * inside the transaction, and it is what closes the race with a concurrent
 * schedule edit between this read and that write.
 *
 * Mirrors `enforceScheduleUnpinOnEnvChange`: a DISABLED schedule's dangling pin
 * is not an error — the mutation strips it in the same transaction.
 */
function assertScheduleSurvivesEnvironmentChange(
  suite: SuiteDoc,
  nextEnvironmentIds: string[],
): void {
  const schedule = suite.schedule;
  if (!schedule) return;
  const pinned = schedule.environmentId
    ? String(schedule.environmentId)
    : undefined;
  const pinSurvives =
    pinned !== undefined && nextEnvironmentIds.includes(pinned);

  // A multi-environment result needs a surviving pin, because a scheduled run
  // launches ONE environment and the launch check rejects an unpinned
  // multi-environment suite — every scheduled run would fail until the
  // schedule paused itself on consecutive failures.
  if (
    schedule.enabled === true &&
    nextEnvironmentIds.length > 1 &&
    !pinSurvives
  ) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "This suite's schedule is enabled but would not be pinned to any of the selected environments. Pin one (PATCH the schedule with environmentId) or disable the schedule first.",
      { reason: "SCHEDULE_ENVIRONMENT_PIN_REQUIRED" },
    );
  }
  if (pinned === undefined || pinSurvives) return;
  if (schedule.enabled === true) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Environment ${pinned} is pinned by this suite's enabled schedule. Point the schedule at an environment you are keeping, or disable it, before removing it.`,
      { reason: "SCHEDULE_ENVIRONMENT_PINNED", environmentId: pinned },
    );
  }
}

/**
 * The server set a fresh run of the suite will snapshot — what the manager
 * must connect for a rerun that omits `serverIds`. Mirrors the resolution
 * `startTestSuiteRun` performs (suite attachments / host config /
 * environment bindings); the backend query owns that logic so this surface
 * can never drift from what the run actually references.
 */
export async function fetchSuiteRunServerSelection(
  convexAuthToken: string,
  suiteId: string,
  namedHostId: string | undefined,
): Promise<{ serverIds: string[]; serverNames: string[] }> {
  const convex = createConvexReadClient(convexAuthToken);
  let selection: {
    serverIds?: unknown;
    serverNames?: unknown;
  } | null;
  try {
    selection = await convex.query(
      "testSuites:getSuiteRunServerSelection" as any,
      { suiteId, ...(namedHostId ? { namedHostId } : {}) },
    );
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval suite not found");
    }
    // Deploy-order skew: a backend without the query yet. Keep the surface
    // usable with the explicit-serverIds escape hatch instead of a 500.
    const message = error instanceof Error ? error.message : String(error);
    if (/could not find public function/i.test(message)) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "This deployment cannot derive the suite's saved servers yet. Pass serverIds explicitly.",
      );
    }
    throw error;
  }

  // A null read means the suite itself wasn't found — match the file's other
  // Convex read-not-found semantics instead of misreporting it as a
  // saved-selection validation problem.
  if (selection == null) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval suite not found");
  }

  const serverIds = Array.isArray(selection.serverIds)
    ? selection.serverIds.map(String)
    : [];
  const serverNames = Array.isArray(selection.serverNames)
    ? selection.serverNames.map(String)
    : [];
  if (serverIds.length === 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Suite has no saved server selection to rerun against. Pass serverIds explicitly.",
      { suiteId, reason: "NO_SAVED_SERVER_SELECTION" },
    );
  }
  return { serverIds, serverNames };
}

/**
 * Whether the run record already reached a terminal status. Used by the
 * detached-execution catch: `runEvalSuiteWithAiSdk` finalizes a failed run
 * itself before rethrowing, so a rejected `execute()` usually means the
 * terminal write already happened — re-finalizing would restamp
 * `completedAt` and overwrite the runner's notes.
 */
async function isRunAlreadyTerminal(
  convexAuthToken: string,
  runId: string,
): Promise<boolean> {
  try {
    const run: RunDoc | null = await createConvexReadClient(
      convexAuthToken,
    ).query("testSuites:getTestSuiteRun" as any, { runId });
    return TERMINAL_RUN_STATUSES.has(String(run?.status));
  } catch {
    // Can't tell — let the defensive finalize proceed. recorder.finalize
    // tolerates deleted/unauthorized runs, so the worst case is the
    // duplicate terminal write we'd have done unconditionally before.
    return false;
  }
}

// ── DTO mapping ──────────────────────────────────────────────────────

type RunDoc = Record<string, any>;
type IterationDoc = Record<string, any>;

/**
 * Which project environment a run actually executed against, read from the
 * IMMUTABLE snapshot the run was stamped with — not from the suite's current
 * attachments, which may have been edited since. `null` for a legacy
 * (saved-server-selection) run. This is the audit half of environment-scoped
 * runs: without it a caller can launch into an environment but never confirm
 * which one, or at which revision, a finished run used.
 */
function toRunEnvironmentDto(run: RunDoc) {
  const ref = run.configSnapshot?.environmentRef;
  if (!ref || !ref.environmentId) return null;
  return {
    id: String(ref.environmentId),
    name: typeof ref.name === "string" ? ref.name : null,
    revision: typeof ref.revision === "number" ? ref.revision : null,
  };
}

/**
 * One advisory judge's persisted result, projected onto the public model.
 *
 * `goalCompletion` is one of SEVERAL judges on the run row — `groundedness`
 * sits beside it under the same four-fields-per-judge pattern — so the DTO
 * carries a `judges` envelope rather than a bare `judge` field, and a third
 * judge is a key here rather than a reshaped response.
 *
 * `status: null` means the judge was NEVER requested for this run, which is a
 * different answer from "requested and produced nothing". A `pending` or
 * `failed` judge carries no cases: `cases` is `[]` and `status` carries the
 * meaning, so a caller never has to distinguish "graded nothing" from "has not
 * graded yet" by the emptiness of a list.
 *
 * `caseKey` keeps its persisted name. It is the stable AUTHORED-case identity,
 * not a Convex row id; calling it `caseId` at this boundary would invite
 * callers to join it against the case ids the case routes take.
 */
function toRunJudgeDto(
  status: unknown,
  errorCode: unknown,
  result: Record<string, any> | undefined,
  toCase: (row: Record<string, any>) => Record<string, unknown>,
) {
  const terminal = status === "completed";
  return {
    status:
      status === "pending" || status === "completed" || status === "failed"
        ? status
        : null,
    errorCode: typeof errorCode === "string" ? errorCode : null,
    summary: typeof result?.summary === "string" ? result.summary : null,
    generatedAt:
      typeof result?.generatedAt === "number" ? result.generatedAt : null,
    modelUsed: typeof result?.modelUsed === "string" ? result.modelUsed : null,
    threshold: typeof result?.threshold === "number" ? result.threshold : null,
    cases:
      terminal && Array.isArray(result?.cases) ? result.cases.map(toCase) : [],
  };
}

/** Advisory graders on a run, keyed by judge. See `toRunJudgeDto`. */
function toRunJudgesDto(run: RunDoc) {
  return {
    goalCompletion: toRunJudgeDto(
      run.goalCompletionStatus,
      run.goalCompletionErrorCode,
      run.goalCompletion,
      (row) => ({
        caseKey: String(row.caseKey ?? ""),
        score: typeof row.score === "number" ? row.score : null,
        passed: row.passed === true,
        reason: typeof row.reason === "string" ? row.reason : null,
        rubricHits: Array.isArray(row.rubricHits)
          ? row.rubricHits.map(String)
          : [],
      }),
    ),
    groundedness: toRunJudgeDto(
      run.groundednessStatus,
      run.groundednessErrorCode,
      run.groundedness,
      // Groundedness grades whether an answer is SUPPORTED by its trajectory,
      // so its per-case evidence is `unsupportedClaims`, not `rubricHits`.
      // Projected off the persisted fields rather than forced into one shape.
      (row) => ({
        caseKey: String(row.caseKey ?? ""),
        score: typeof row.score === "number" ? row.score : null,
        passed: row.passed === true,
        reason: typeof row.reason === "string" ? row.reason : null,
        unsupportedClaims: Array.isArray(row.unsupportedClaims)
          ? row.unsupportedClaims.map(String)
          : [],
      }),
    ),
  };
}

function toRunDto(run: RunDoc) {
  return {
    id: String(run._id),
    suiteId: String(run.suiteId),
    runNumber: run.runNumber ?? null,
    status: run.status,
    result: run.result,
    summary: run.summary ?? null,
    source: run.source ?? "ui",
    notes: run.notes ?? null,
    environment: toRunEnvironmentDto(run),
    ...(typeof run.runGroupId === "string" ? { runGroupId: run.runGroupId } : {}),
    ...(typeof run.effectiveModelId === "string"
      ? { effectiveModelId: run.effectiveModelId }
      : {}),
    ...(run.modelSource === "client_default" || run.modelSource === "override"
      ? { modelSource: run.modelSource }
      : {}),
    // Which engine the run actually executed on: `"emulated"` (the inspector's
    // own turn loop) or `"harness:<id>"` (a real agent runtime). Read from the
    // run's IMMUTABLE snapshot, where the platform derives it from the run's
    // own host config.
    //
    // OMITTED, never defaulted, when the snapshot has none: a run predating
    // the field recorded nothing, and rendering that as "emulated" would put a
    // claim on exactly the runs whose engine was never verified — the same
    // false-green this attribution exists to make impossible.
    ...(typeof run.configSnapshot?.executionEngine === "string"
      ? { executionEngine: run.configSnapshot.executionEngine }
      : {}),
    // Whether the run's score evidence verified at ingest. ABSENT means no
    // verdict was produced — a deployment that does not yet check integrity —
    // and a score gate must treat that exactly like `"invalid"`: absent
    // evidence is not valid evidence. Omitted rather than nulled so the DTO is
    // unchanged for every run predating integrity checking.
    ...toRunScoreIntegrity(run.scoreIntegrity),
    // The v2 verdict policy evidence: which policy decided this run, the
    // decision itself (validity first, then the task verdict, with the
    // denominators and reasons it was taken on), and the integrity error when
    // the run's own evidence could not be decided under it. ALL THREE ARE
    // ABSENT for a legacy percent-threshold run — see `toRunVerdictProjection`.
    //
    // A caller gating on `result` must read `verdictPolicyVersion` first: only
    // under v2 can `result` be `"inconclusive"`, and only then does
    // `verdictSummary` explain the decision.
    ...toRunVerdictProjection(run),
    // The waiver in force over this run's gate, or `null`.
    //
    // ON THE RUN, not behind a separate fetch, because `eval gate` already
    // GETs this run and computes its verdict client-side: carrying the waiver
    // here is what lets it fold one in and NAME it in every artifact it
    // writes, instead of flipping an exit code with nothing explaining why.
    //
    // `null` rather than omitted so a caller can distinguish "no waiver" from
    // "an older deployment that does not report one" — the same convention
    // `insights` and `judges` use. The platform gates it on being able to VIEW
    // the run rather than to grant a waiver; a waiver its readers cannot see
    // is not a visible waiver.
    gateWaiver: toGateWaiverDto(run.gateWaiver),
    // Whether this run's imported cases carry evidence a gate may rely on.
    //
    // OMITTED, not defaulted, when the platform did not report one: absence
    // says "this deployment has no opinion", and `{status: "legacy"}` says
    // "there were no imported cases". A gate that read the second where the
    // first was true would vouch for a run nobody had checked.
    ...toImportEligibilityProjection(run.importEligibility),
    createdAt: run.createdAt,
    completedAt: run.completedAt ?? null,
  };
}

/**
 * The eligibility projection, field by field, or nothing.
 *
 * Explicit rather than a spread of whatever the platform sent. This object
 * decides whether a run may gate a deploy, so its shape is part of the public
 * contract in a way a passthrough could not keep: an internal field added
 * upstream would be published here without anyone deciding to, and a MALFORMED
 * one would be republished as though it had been checked.
 *
 * A payload that fails these checks is dropped entirely rather than
 * partially projected. A gate cannot tell a missing field from a satisfied
 * one, so half a projection is worse than none — and none is already handled
 * correctly downstream as "older deployment, behave as before".
 */
function toImportEligibilityProjection(
  raw: unknown,
): { importEligibility?: Record<string, unknown> } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const status = source.status;
  if (
    status !== "legacy" &&
    status !== "eligible" &&
    status !== "incomplete"
  ) {
    return {};
  }
  if (typeof source.gateable !== "boolean") return {};
  if (typeof source.importedCaseCount !== "number") return {};

  // A required list is validated WHOLE, exactly like the scalars above.
  //
  // Coercing an absent or malformed list to `[]` would publish a projection
  // that reads as complete: an `eligible` run whose frozen approval receipts
  // silently became an empty array still says "imported cases ran with a
  // recorded decision", while the audit that made them runnable is simply
  // gone, and nothing on the wire distinguishes "approved by nobody" from
  // "we could not read who approved". `undefined` is the ONLY way this
  // function reports "no opinion", and a payload that is present but wrong
  // must not borrow it.
  const stringList = (value: unknown): string[] | undefined =>
    Array.isArray(value) &&
    value.every((entry): entry is string => typeof entry === "string")
      ? (value as string[])
      : undefined;

  const claimedExactCaseIds = stringList(source.claimedExactCaseIds);
  if (claimedExactCaseIds === undefined) return {};
  const approvedApproximationCaseIds = stringList(
    source.approvedApproximationCaseIds,
  );
  if (approvedApproximationCaseIds === undefined) return {};

  if (!Array.isArray(source.approvedApproximationReceipts)) return {};
  const receipts: Array<Record<string, unknown>> = [];
  for (const entry of source.approvedApproximationReceipts) {
    if (!entry || typeof entry !== "object") return {};
    const receipt = entry as Record<string, unknown>;
    // Every field of a receipt is load-bearing — who, when, why, and for which
    // case. A receipt missing any of them is not a weaker receipt; it is one a
    // reader would have to guess at. Dropping just that ENTRY would leave
    // `approvedApproximationCaseIds` naming a case with no receipt to explain
    // it, so the whole projection goes instead of a self-contradicting one.
    if (
      typeof receipt.testCaseId !== "string" ||
      typeof receipt.approvedBy !== "string" ||
      typeof receipt.approvedAt !== "number" ||
      typeof receipt.reason !== "string"
    ) {
      return {};
    }
    receipts.push({
      testCaseId: receipt.testCaseId,
      ...(typeof receipt.caseKey === "string"
        ? { caseKey: receipt.caseKey }
        : {}),
      ...(typeof receipt.sourceCaseKey === "string"
        ? { sourceCaseKey: receipt.sourceCaseKey }
        : {}),
      approvedBy: receipt.approvedBy,
      approvedAt: receipt.approvedAt,
      reason: receipt.reason,
    });
  }

  if (!Array.isArray(source.issues)) return {};
  const issues: Array<Record<string, unknown>> = [];
  for (const entry of source.issues) {
    if (!entry || typeof entry !== "object") return {};
    const issue = entry as Record<string, unknown>;
    // `code` is what names the problem. An issue without one explains nothing,
    // and a partial issue list understates how much is wrong with the run.
    if (typeof issue.code !== "string") return {};
    issues.push({
      code: issue.code,
      ...(typeof issue.testCaseId === "string"
        ? { testCaseId: issue.testCaseId }
        : {}),
      ...(typeof issue.caseKey === "string" ? { caseKey: issue.caseKey } : {}),
      ...(typeof issue.toolName === "string"
        ? { toolName: issue.toolName }
        : {}),
    });
  }

  return {
    importEligibility: {
      status,
      gateable: source.gateable,
      importedCaseCount: source.importedCaseCount,
      claimedExactCaseIds,
      approvedApproximationCaseIds,
      approvedApproximationReceipts: receipts,
      issues,
    },
  };
}

function toIterationDto(iteration: IterationDoc) {
  const snapshot = iteration.testCaseSnapshot ?? {};
  const startedAt =
    typeof iteration.startedAt === "number" ? iteration.startedAt : null;
  // Every lifecycle status that ENDS an iteration. `setup_failed` and
  // `skipped` are terminal exactly like the other four: the harness is done
  // with the trial, so its duration is measurable (a setup failure has a real
  // elapsed time) and withholding it would report `durationMs: null` for the
  // one class of failure an operator is trying to time.
  const isTerminal = TERMINAL_ITERATION_STATUSES.has(iteration.status);
  const durationMs =
    isTerminal && startedAt !== null && typeof iteration.updatedAt === "number"
      ? Math.max(iteration.updatedAt - startedAt, 0)
      : null;
  return {
    id: String(iteration._id),
    testCaseId: iteration.testCaseId ? String(iteration.testCaseId) : null,
    // The case's SDK-DECLARED id, from the iteration's FROZEN snapshot — the
    // identity the suite declared when the run started, which survives the case
    // row being recreated. Kept beside `testCaseId` and never merged into it:
    // one is the author's durable name for the case and the other is this
    // deployment's row id, and a reader that cannot tell them apart cannot tell
    // a re-created case from a renamed one.
    //
    // OMITTED, never nulled, when the snapshot has none — a UI-authored case
    // declares no id, and every iteration predating declared ids has none — so
    // this is additive for every existing row.
    ...(typeof snapshot.caseId === "string" && snapshot.caseId.length > 0
      ? { caseId: snapshot.caseId }
      : {}),
    title: snapshot.title ?? null,
    iterationNumber: iteration.iterationNumber,
    status: iteration.status,
    result: iteration.result,
    model: snapshot.model ?? null,
    provider: snapshot.provider ?? null,
    startedAt,
    durationMs,
    tokensUsed: iteration.tokensUsed ?? null,
    usage: iteration.usage ?? null,
    actualToolCalls: iteration.actualToolCalls ?? [],
    expectedToolCalls: snapshot.expectedToolCalls ?? [],
    error: iteration.error ?? null,
    ...toScoreProjection(iteration.metadata),
    ...toStageProjection(iteration.metadata),
  };
}

// Public per-authored-step result. Explicit projection (not a passthrough) so no
// internal/blob field — `metadata`, `predicates`, `screenshotBlobId`,
// `authoredStepId`, `stepResults` raw rows — can ever leak past this boundary.
// `evidence` is omitted entirely when the step produced none.
function toStepResultDto(step: EvalStepReplay) {
  const ev = step.evidence;
  const evidence = ev
    ? {
        ...(ev.toolCalls?.length ? { toolCalls: ev.toolCalls } : {}),
        ...(ev.screenshotUrl ? { screenshotUrl: ev.screenshotUrl } : {}),
        ...(ev.videoUrl ? { videoUrl: ev.videoUrl } : {}),
        ...(typeof ev.videoOffsetMs === "number"
          ? { videoOffsetMs: ev.videoOffsetMs }
          : {}),
        ...(ev.source ? { source: ev.source } : {}),
        ...(ev.locatorLabel ? { locatorLabel: ev.locatorLabel } : {}),
      }
    : undefined;
  return {
    stepId: step.stepId,
    stepIndex: step.stepIndex,
    kind: step.kind,
    status: step.status,
    reason: step.reason ?? null,
    ...(evidence && Object.keys(evidence).length > 0 ? { evidence } : {}),
  };
}

// ── Public eval-edit surface: schemas, translation, DTOs ─────────────
//
// The public model speaks the eval vocabulary (settings, checks, judge, match
// options, environment, hosts, execution config). These helpers translate it
// to/from the internal Convex suite/case model. No internal field name (Convex
// mutation names, defaultPredicates, namedHostId, …) crosses this boundary.

/**
 * Merge a partial public match-options patch onto the stored (internal) object.
 * `updateTestSuite`/`updateTestCase` replace the field wholesale, so a partial
 * patch must layer onto current values. When the patch sets the extra-call
 * bound, drop the legacy `allowExtraToolCalls` so it can't shadow the modern
 * `maxExtraToolCalls` on read.
 */
function mergeMatchOptions(
  current: any,
  patch: PublicMatchOptions,
): Record<string, unknown> {
  const partial = toInternalMatchOptions(patch);
  const merged: Record<string, unknown> = {
    ...(current && typeof current === "object" ? current : {}),
    ...partial,
  };
  if ("maxExtraToolCalls" in partial) delete merged.allowExtraToolCalls;
  return merged;
}

function toPublicMatchOptions(internal: any): PublicMatchOptions | null {
  if (!internal || typeof internal !== "object") return null;
  // `maxExtraToolCalls` is the current field and is authoritative whenever the
  // key is PRESENT — including an explicit `null`, which means unlimited. Only
  // fall back to the legacy boolean `allowExtraToolCalls` when the modern field
  // is entirely absent (the SDK matcher shims true→null, false→0).
  let extraToolCalls: "unlimited" | number;
  if (internal.maxExtraToolCalls !== undefined) {
    extraToolCalls =
      internal.maxExtraToolCalls === null
        ? "unlimited"
        : Number(internal.maxExtraToolCalls);
  } else if (typeof internal.allowExtraToolCalls === "boolean") {
    extraToolCalls = internal.allowExtraToolCalls ? "unlimited" : 0;
  } else {
    extraToolCalls = "unlimited";
  }
  return {
    toolCallOrder: ORDER_TO_PUBLIC[String(internal.toolCallOrder)] ?? "any",
    extraToolCalls,
    arguments: ["ignore", "partial", "exact"].includes(
      String(internal.argumentMatching),
    )
      ? (internal.argumentMatching as "ignore" | "partial" | "exact")
      : "partial",
  };
}

// Public "checks" are whole-run global gates (`defaultPredicates` / case
// `predicates` envelope). Scenario checks belong in `steps` as assert steps.
const publicCheckSchema = z.object({ type: z.string().min(1) }).passthrough();

// ── Case DTO ─────────────────────────────────────────────────────────

type CaseDoc = Record<string, any>;

/**
 * Project an internal case doc onto the public `steps` array (`TestStep[]`) —
 * the inverse of `stepsToInternalCaseFields`. Reuses the shared adapters so the
 * round-trip matches the authoring contract:
 *   - `widget_probe` + `probeConfig` → a single `toolCall` step;
 *   - multi-turn `promptTurns`        → `promptTurnsToSteps` (prompt + asserts);
 *   - single-turn prompt case         → one `prompt` step + `toolCalledWith`
 *                                       asserts from top-level `expectedToolCalls`.
 */
function internalCaseToSteps(testCase: CaseDoc): TestStep[] {
  const storedSteps = normalizeSteps(testCase.steps);
  if (storedSteps.length > 0) {
    return storedSteps;
  }

  if (testCase.caseType === "widget_probe" && testCase.probeConfig) {
    return [
      probeConfigToToolCallStep(
        `${String(testCase._id)}-call`,
        testCase.probeConfig as ProbeConfig,
      ),
    ];
  }

  const turns = Array.isArray(testCase.promptTurns)
    ? (testCase.promptTurns as PromptTurn[])
    : [];
  if (turns.length > 0) {
    return promptTurnsToSteps(turns);
  }

  // Single-turn prompt case: synthesize a prompt step + its expected-call asserts.
  const steps: TestStep[] = [
    {
      id: `${String(testCase._id)}-prompt`,
      kind: "prompt",
      prompt: typeof testCase.query === "string" ? testCase.query : "",
    },
  ];
  const expected = Array.isArray(testCase.expectedToolCalls)
    ? testCase.expectedToolCalls
    : [];
  expected.forEach((c: any, i: number) => {
    steps.push({
      id: `${String(testCase._id)}-expect-${i}`,
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName: String(c?.toolName ?? ""),
        args: { args: c?.arguments ?? {} },
      },
    });
  });
  return steps;
}

/**
 * The three CLAIM fields of a stored import record, and nothing else.
 *
 * The persisted row is a superset: alongside the claim it can carry acceptance
 * bookkeeping the platform wrote (`acceptedBy`, `acceptedAt`, and friends).
 * Spreading the stored object would publish internal fields the public contract
 * never promised and cannot take back, so this picks the three fields by name
 * and validates the status against the closed vocabulary rather than trusting
 * whatever the row happens to hold.
 *
 * Returns `undefined` for a native case and for a row whose status is not one
 * we know — an unreadable claim is reported as no claim rather than as a claim
 * whose meaning the caller has to guess.
 */
function toPublicCaseImportClaim(
  raw: unknown,
): { status: string; sourceCaseKey?: string; note?: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const status = record.status;
  if (
    typeof status !== "string" ||
    !(IMPORT_MAPPING_STATUSES as readonly string[]).includes(status)
  ) {
    return undefined;
  }
  return {
    status,
    ...(typeof record.sourceCaseKey === "string" && record.sourceCaseKey
      ? { sourceCaseKey: record.sourceCaseKey }
      : {}),
    ...(typeof record.note === "string" && record.note
      ? { note: record.note }
      : {}),
  };
}

function toCaseDto(testCase: CaseDoc) {
  const importClaim = toPublicCaseImportClaim(testCase.import);
  return {
    id: String(testCase._id),
    // The EFFECTIVE declared identity — what the case answers to in a suite
    // file, an import, or a CLI argument — so a caller can read back the id it
    // authored (and see which id won when a retry replayed onto a stored row).
    //
    // Deliberately not folded into `id`. That field is the platform row id
    // every case route takes as its path parameter and every selector resolves
    // against; giving one name two meanings would break each of them. Absent on
    // cases authored before declared identity existed.
    ...(typeof testCase.declaredCaseId === "string"
      ? { declaredId: testCase.declaredCaseId }
      : {}),
    title: testCase.title ?? "",
    steps: internalCaseToSteps(testCase),
    ...(testCase.expectedOutput !== undefined
      ? { expectedOutput: testCase.expectedOutput }
      : {}),
    iterations: typeof testCase.runs === "number" ? testCase.runs : 1,
    // The v2 per-case OVERRIDES, projected under their canonical names and
    // omitted when the case inherits the suite default.
    //
    // `repetitions` is not a second spelling of `iterations` above: that field
    // is the legacy `runs` count, which a v2 case keeps as its
    // legacy-compatible projection, and the legacy resolver reads it as a floor
    // (`max(runs, minimumIterations)`). This one is "the case's value, else the
    // suite's". `passThreshold` is a FRACTION in [0,1] and is never derived
    // from `settings.minimumAccuracy`, which is a suite-wide percent.
    ...(typeof testCase.repetitions === "number"
      ? { repetitions: testCase.repetitions }
      : {}),
    ...(typeof testCase.passThreshold === "number"
      ? { passThreshold: testCase.passThreshold }
      : {}),
    isNegative: testCase.isNegativeTest === true,
    ...(testCase.scenario !== undefined ? { scenario: testCase.scenario } : {}),
    models: Array.isArray(testCase.models)
      ? testCase.models.map((m: any) => ({
          model: String(m.model),
          ...(m.provider ? { provider: String(m.provider) } : {}),
        }))
      : [],
    ...(testCase.matchOptions
      ? { matchOptions: toPublicMatchOptions(testCase.matchOptions) }
      : {}),
    ...(testCase.predicates
      ? {
          checks: {
            mode: testCase.predicates.mode,
            list: testCase.predicates.list ?? [],
          },
        }
      : {}),
    ...(importClaim ? { import: importClaim } : {}),
    createdAt: testCase.createdAt ?? null,
    updatedAt: testCase.updatedAt ?? null,
  };
}

// ── Suite-detail DTO ─────────────────────────────────────────────────

type SuiteDoc = Record<string, any>;

function toSuiteDetailDto(
  suite: SuiteDoc,
  execConfig: any,
  resolved: { computerEnvironmentName?: string | null } = {},
) {
  const goal = suite.judgeConfig?.goalCompletion;
  return {
    id: String(suite._id),
    ...(typeof suite.declaredSuiteId === "string"
      ? { declaredId: suite.declaredSuiteId }
      : {}),
    name: suite.name ?? null,
    description: suite.description ?? null,
    projectId: suite.projectId ? String(suite.projectId) : null,
    environment: {
      servers: Array.isArray(suite.environment?.servers)
        ? suite.environment.servers.map(String)
        : [],
      // The sandbox image this suite's eval runs boot from. `null` = the
      // provider's default base image. The NAME rides along beside the id so a
      // caller can echo back what it set without a second lookup — it is what
      // the picker shows and what a person recognizes.
      computerEnvironment: suite.environment?.computerEnvironmentId
        ? {
            id: String(suite.environment.computerEnvironmentId),
            name: resolved.computerEnvironmentName ?? null,
          }
        : null,
    },
    executionConfig: execConfig
      ? {
          model: execConfig.modelId,
          systemPrompt: execConfig.systemPrompt,
          temperature: execConfig.temperature,
        }
      : null,
    hosts: Array.isArray(suite.hostAttachments)
      ? suite.hostAttachments.map((h: any) => ({
          id: String(h.namedHostId),
          name: h.hostName ?? "",
          ...(Array.isArray(h.resolvedServerNames)
            ? { servers: h.resolvedServerNames.map(String) }
            : {}),
        }))
      : [],
    // Attach-ordered project environments. Writable via PATCH
    // (`environmentIds`: non-empty array sets/replaces, `null` clears).
    environmentIds: Array.isArray(suite.environmentIds)
      ? suite.environmentIds.map(String)
      : [],
    settings: {
      minimumAccuracy:
        typeof suite.defaultPassCriteria?.minimumPassRate === "number"
          ? suite.defaultPassCriteria.minimumPassRate
          : null,
      // `null` = no floor, which is the suite's real state rather than a
      // stand-in for 1: a floor of 1 and no floor at all produce the same
      // runs today, but only one of them is something the user chose.
      minimumIterations:
        typeof suite.minIterations === "number" ? suite.minIterations : null,
      matchOptions: toPublicMatchOptions(suite.defaultMatchOptions),
      checks: Array.isArray(suite.defaultPredicates)
        ? suite.defaultPredicates
        : [],
      // FULLY RESOLVED, every field layered over GOAL_COMPLETION_DEFAULTS —
      // the same resolution the backend's `resolveGoalCompletionConfig`
      // performs before grading. Reporting a raw field next to a resolved one
      // (the old `enabled: true` beside `model: null`) described a suite state
      // that never exists at run time, and left a caller unable to echo back
      // what its own PATCH will grade with.
      judge: {
        enabled: goal?.enabled ?? GOAL_COMPLETION_DEFAULTS.enabled,
        model: goal?.judgeModel ?? GOAL_COMPLETION_DEFAULTS.judgeModel,
        // `autoRun` is the flag that makes grading HAPPEN; `enabled` alone only
        // makes the judge available to a manual request.
        autoRun: goal?.autoRun ?? GOAL_COMPLETION_DEFAULTS.autoRun,
        threshold:
          typeof goal?.threshold === "number"
            ? goal.threshold
            : GOAL_COMPLETION_DEFAULTS.threshold,
      },
      // The v2 verdict policy this suite's runs are decided under, with the
      // defaults a case inherits. ABSENT for a legacy suite — its runs are
      // decided by `minimumAccuracy` (a suite-wide percent) against
      // `max(case.iterations, minimumIterations)`, which is a different
      // resolver and not expressible here.
      ...toSuiteVerdictPolicyDto(suite),
    },
    schedule: {
      enabled: suite.schedule?.enabled === true,
      intervalMinutes:
        typeof suite.schedule?.intervalMinutes === "number"
          ? suite.schedule.intervalMinutes
          : null,
      environmentId: suite.schedule?.environmentId
        ? String(suite.schedule.environmentId)
        : null,
    },
    createdAt: suite.createdAt ?? null,
    updatedAt: suite.updatedAt ?? null,
  };
}

/** Map a HostConfigDtoV2 (from getSuiteConfig) back to a HostConfigInputV2. */
function hostConfigDtoToInput(dto: any): Record<string, unknown> {
  const opt = (key: string) =>
    dto[key] !== undefined ? { [key]: dto[key] } : {};
  return {
    hostStyle: dto.hostStyle,
    modelId: dto.modelId,
    systemPrompt: dto.systemPrompt,
    temperature: dto.temperature,
    requireToolApproval: dto.requireToolApproval,
    connectionDefaults: dto.connectionDefaults,
    clientCapabilities: dto.clientCapabilities,
    hostContext: dto.hostContext,
    ...opt("progressiveToolDiscovery"),
    ...opt("respectToolVisibility"),
    ...opt("modelVisibleMcpToolResults"),
    ...opt("mcpToolResultImageRendering"),
    ...opt("harness"),
    ...opt("computer"),
    ...opt("serverIds"),
    ...opt("optionalServerIds"),
    ...opt("builtInToolIds"),
    ...opt("hostCapabilitiesOverride"),
    ...opt("chatUiOverride"),
    ...opt("mcpProfile"),
    ...opt("serverConnectionOverrides"),
  };
}

/**
 * The provider for `id` when it can be ATTRIBUTED, else undefined.
 *
 * Three sources, most specific first:
 *
 *  1. the shared catalog, for BOTH bare and qualified ids. The catalog carries
 *     more vendors than the classifier's prefix map does, so gating this lookup
 *     on "no slash" would answer `cohere/command-a` from the map's catch-all
 *     (Ollama) while the catalog is sitting right there knowing it is Cohere;
 *  2. the shared classifier, so this route agrees with
 *     `buildSyntheticModelDefinition`, the chat-session fallback, and the
 *     backend mirror on prefixes and aliases — `meta-llama/...` is `meta`, not
 *     `meta-llama`, and `mistralai/...` is `mistral`;
 *  3. the id's own vendor prefix, for a qualified id neither of the first two
 *     recognizes. The classifier's final answer for those is its bare-id
 *     catch-all (`ollama`), which is right for `llama3` and wrong for
 *     `newvendor/some-model` — a literal prefix is the vendor the author wrote.
 *
 * Undefined ONLY for a bare id nothing recognizes, where `ollama` is the
 * classifier's guess rather than knowledge. Callers that must store a provider
 * take that guess (`providerForModelId`); callers that can defer instead defer.
 */
function attributedProvider(id: string): string | undefined {
  const match = MODEL_LOOKUP.find(
    (m) => String(m.id) === id || String(m.id).endsWith(`/${id}`),
  );
  if (match) return String(match.provider);
  const classified = classifyModelIdProvider(id)?.provider;
  if (classified && classified !== "ollama") return classified;
  // `> 0`, not `>= 0`: a leading slash makes the prefix empty, and an empty
  // provider is worse than the catch-all it would replace.
  const slash = id.indexOf("/");
  if (slash > 0) return id.slice(0, slash);
  // A bare id nothing above recognized. `classified` is `ollama` here — the
  // classifier's catch-all — and returning it would make this function total,
  // which is the whole distinction it exists to draw.
  return undefined;
}

/**
 * Resolve a model id's provider, for a caller that must persist one.
 *
 * TOTAL for any non-blank id: an unattributable BARE id falls back to the
 * classifier's `ollama` catch-all, since the open-namespace providers are the
 * only ones where an id we cannot place is still plausibly runnable. Blank ids
 * are rejected up front, as a 400, rather than reported as an unresolvable
 * provider — so callers never need a "couldn't derive it" branch.
 */
function providerForModelId(modelId: string): string {
  // Trim FIRST, exactly as `classifyModelIdProvider` does. Without it a padded
  // bare catalog id misses the lookup and falls through to the classifier's
  // bare-id catch-all, so `" claude-sonnet-4-5 "` would be attributed to
  // Ollama rather than to its real vendor.
  const id = requireNonBlankModelId(modelId);
  return attributedProvider(id) ?? "ollama";
}

/**
 * A persisted `{ model, provider }` entry from an authored one.
 *
 * The id is TRIMMED for the value we STORE, not merely for the provider lookup.
 * It is persisted verbatim, sent to the provider verbatim, and compared
 * verbatim against environment and host model ids downstream, so keeping
 * `" gpt-4o "` would mint a model that resolves to the right provider and then
 * matches nothing. Same normalization as `withTrimmedModelId` on the host write
 * boundary and the backend's `normalizeModelId`; only ever a trim.
 */
function toPersistedModelEntry(entry: { model: string; provider?: string }): {
  model: string;
  provider: string;
} {
  return {
    model: requireNonBlankModelId(entry.model),
    provider: deriveProvider(entry.model, entry.provider),
  };
}

/**
 * The trimmed id, or a 400.
 *
 * `z.string().min(1)` accepts `"   "`, and an EXPLICIT provider makes
 * {@link deriveProvider} return without ever inspecting the model — so a
 * whitespace-only id paired with `provider: "openai"` would otherwise persist
 * as `{ model: "", provider: "openai" }`: a case that passes validation and
 * then has no model to run. Blank is rejected here rather than silently
 * normalized, because there is no id to fall back to.
 */
function requireNonBlankModelId(model: string): string {
  const id = model.trim();
  if (!id) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Model id cannot be blank.",
    );
  }
  return id;
}

function deriveProvider(model: string, explicit: string | undefined): string {
  return explicit || providerForModelId(model);
}

// Public case body (create + update share this; create requires title).
// The case body is the `steps` contract (`TestStep[]`); it REPLACES the old
// `kind` / `prompt` / `turns` / `expectedToolCalls` / `renderCheck` vocabulary.
const publicCaseBodyShape = {
  title: z.string().min(1).optional(),
  // Replaces the case test definition wholesale when provided. A `prompt` step
  // is a model turn; a single model-free `toolCall` step is a render-check;
  // `assert` steps (e.g. `toolCalledWith`) hold the expectations.
  steps: stepsSchema.min(1).optional(),
  expectedOutput: z.string().optional(),
  iterations: z.number().int().min(1).max(10).optional(),
  repetitions: z.number().int().min(1).max(100).optional(),
  passThreshold: z.number().min(0).max(1).optional(),
  isNegative: z.boolean().optional(),
  scenario: z.string().optional(),
  models: z
    .array(
      z.object({
        model: z.string().min(1),
        provider: z.string().min(1).optional(),
      }),
    )
    .optional(),
  matchOptions: publicMatchOptionsSchema.nullable().optional(),
  checks: z
    .object({
      mode: z.enum(["inherit", "replace", "extend"]),
      list: z.array(publicCheckSchema),
    })
    .nullable()
    .optional(),
} as const;

/**
 * The per-case IMPORT CLAIM, as the public API accepts it.
 *
 * Reused verbatim from the suite-file contract rather than restated: a claim a
 * converter can write into a YAML file is exactly a claim it can POST, and two
 * spellings of the same object is how the file loader and the API end up
 * disagreeing about whether a 512-character source key is legal.
 *
 * CLAIM-ONLY, and the closed object is the enforcement. `exact` here means
 * CONVERTER-CLAIMED exact — MCPJam has verified nothing — so the acceptance
 * side of the record (who approved, when, and why) is deliberately
 * unrepresentable in a request body: approvals are per-run decisions the
 * platform derives from the authenticated launcher, and a caller-supplied
 * `approvedBy` would file one person's approval under another's name. A body
 * that carries one is a 400, never a silently-stripped field.
 */
const publicCaseImportSchema = evalSuiteFileCaseImportSchema;

const createCaseSchema = z.strictObject({
  ...publicCaseBodyShape,
  /**
   * The case's DECLARED identity. Callers mint it (`mintCaseId` from
   * `@mcpjam/sdk/contract`) so the id a suite file commits is the id the
   * platform stores; when omitted, this first-party server mints one rather
   * than leaving the case without an identity.
   *
   * Create only. It is absent from `updateCaseSchema` on purpose: a case's
   * identity is not one of the fields a PATCH may edit, and accepting it there
   * would make "change this case" and "point this id at a different case" the
   * same request.
   */
  id: opaqueIdSchema.optional(),
  /** The converter's claim for this case. See {@link publicCaseImportSchema}. */
  import: publicCaseImportSchema.optional(),
});
const updateCaseSchema = z.strictObject({
  ...publicCaseBodyShape,
  /**
   * The converter's CLAIM about this case, or `null` to remove one.
   *
   * Omitted means unchanged; `null` means the case no longer carries a claim.
   * The two are different requests and a PATCH that conflated them would erase
   * provenance on every unrelated edit.
   */
  import: z.union([publicCaseImportSchema, z.null()]).optional(),
});

/**
 * A case inside a `POST …/cases/batch` body. Same shape as a single create —
 * the batch surface is the single surface repeated, not a second contract.
 */
const batchCaseSchema = createCaseSchema;

const createCasesBatchSchema = z.strictObject({
  cases: z
    .array(batchCaseSchema)
    .min(1, "cases must contain at least one case.")
    .max(
      MAX_CASES_PER_BATCH,
      `cases accepts at most ${MAX_CASES_PER_BATCH} entries per call; split larger writes into chunks.`,
    ),
  /**
   * `block` (default) refuses a case whose definition already exists in the
   * suite. Left as a plain string so an unrecognized value COERCES to `block`
   * and reports the coercion, exactly as the platform does — validating it to
   * an enum here would turn a typo into a rejected batch and hide the
   * platform's own audit field.
   */
  duplicatePolicy: z.string().optional(),
  overrideReason: z.string().optional(),
});

/**
 * Exported for the settings-parity test
 * (`__tests__/eval-suite-settings-parity.test.ts`), which asserts that every
 * settings-sheet row the shared manifest marks `api:` is genuinely accepted
 * here. Nothing else should import it — the route is the only writer.
 */
export const updateSuiteSchema = z.strictObject({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  // The LEGACY server bag (kept as rollback/compat data). Unrelated to
  // `environmentIds` below, which is the project-environment attachment list.
  environment: z
    .object({
      // Optional so a caller can set the computer image WITHOUT restating the
      // server list. Omitting it preserves the suite's current servers (and
      // their bindings) rather than clearing them.
      servers: z.array(z.string().min(1)).optional(),
      // Sandbox-image name or id; `null` clears the pin (runs fall back to the
      // provider's default base image). Enumerate the choices with
      // `list_sandbox_images`.
      computerEnvironment: z.union([z.string().min(1), z.null()]).optional(),
    })
    .optional(),
  // Project-environment attachments, in attach order: a non-empty array
  // sets/replaces, `null` clears (reverts the suite to legacy config), and `[]`
  // is rejected rather than silently treated as a clear — mirroring the
  // `testSuites:setSuiteEnvironments` contract exactly, so the API can't grow a
  // second, subtly different meaning for the same value.
  environmentIds: z
    .union([
      z
        .array(z.string().min(1))
        .min(
          1,
          "environmentIds must be non-empty — pass null to clear the suite's environments.",
        ),
      z.null(),
    ])
    .optional(),
  executionConfig: z
    .object({
      model: z.string().min(1).optional(),
      systemPrompt: z.string().optional(),
      temperature: z.number().optional(),
    })
    .optional(),
  hosts: z
    .array(
      z.object({
        host: z.string().min(1),
        servers: z.array(z.string().min(1)).optional(),
      }),
    )
    .optional(),
  settings: z
    .object({
      minimumAccuracy: z.number().min(0).max(100).optional(),
      // Suite-level FLOOR on per-case iterations: every case runs at least
      // this many times (`max(case.iterations, minimumIterations)`). `null`
      // clears it — the platform's `minIterations` has exactly that contract,
      // so the public field does not invent a second way to say "no floor".
      minimumIterations: z
        .union([z.number().int().min(1).max(10), z.null()])
        .optional(),
      matchOptions: publicMatchOptionsSchema.nullable().optional(),
      checks: z.array(publicCheckSchema).nullable().optional(),
      judge: z
        .object({
          enabled: z.boolean().optional(),
          model: z.string().min(1).optional(),
          // The flag the grader actually gates on. Without it a suite can be
          // `enabled` forever and never grade a run.
          autoRun: z.boolean().optional(),
          threshold: z.number().min(0).max(1).optional(),
        })
        .optional(),
    })
    .optional(),
});

/**
 * Body for `POST …/eval-runs/:runId/judge`. STRICT: this endpoint spends, so an
 * unknown or mistyped key is a 400 rather than a silently-ignored field that
 * bills anyway.
 *
 * `enable` is the per-RUN answer to "grade this?", not a suite edit. Grading
 * resolves from the run's config snapshot, pinned when the run was created, so
 * a run recorded while the judge was off cannot be rescued by turning the judge
 * on for the suite — `enable: true` is what grades it, and it touches nothing
 * beyond this run. Requires a platform new enough to accept the field; older
 * deployments refuse the override rather than grading with the judge off.
 */
const requestRunJudgeSchema = z
  .object({
    /** Re-grade a run that already has a result. */
    force: z.boolean().optional(),
    enable: z.boolean().optional(),
    /** Judge model for THIS run only. */
    model: z.string().min(1).optional(),
    /** Pass threshold for THIS run only, 0–1. */
    threshold: z.number().min(0).max(1).optional(),
  })
  .strict();

const scheduleSchema = z.strictObject({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(5).max(10080).optional(),
  // A schedule fires exactly ONE run, so an environment-based suite must pin
  // exactly one of its attached environments. Omitted on a single-environment
  // suite means that environment; omitted on a multi-environment suite is a
  // 400. Only meaningful when enabling — see the handler.
  environmentId: z.string().min(1).optional(),
});

const generateCasesSchema = z
  .object({
    mode: z.enum(["normal", "negative"]).optional(),
    servers: z.array(z.string().min(1)).optional(),
    // Discover tools from this attached environment's closed server set instead
    // of the suite's saved selection, so generated cases are written against
    // the tools the suite's runs will actually see.
    environmentId: z.string().min(1).optional(),
    caseModels: z
      .array(
        z.object({
          model: z.string().min(1),
          provider: z.string().min(1).optional(),
        }),
      )
      .optional(),
    // Per-bucket case counts. Omitted buckets inherit the default mix; the
    // backend bounds each bucket and the total. `caseMix` supersedes `mode`.
    caseMix: z
      .object({
        simple: z.number().int().min(0).max(10).optional(),
        multiTool: z.number().int().min(0).max(10).optional(),
        multiTurn: z.number().int().min(0).max(10).optional(),
        complex: z.number().int().min(0).max(10).optional(),
        negative: z.number().int().min(0).max(10).optional(),
      })
      .optional(),
    // Condition the generated cases on a realistic range of user styles so the
    // queries read like different users wrote them.
    varyUserStyles: z.boolean().optional(),
    // Body channel for the idempotency key, matching `run_eval_suite` and
    // `run_eval_case` — the two closest siblings, which also spend. The agent
    // surfaces set the prefixed header and win the merge below; every other
    // caller can reach the ledger from here without controlling headers at
    // all, which is what the CLI, the MCP plugin, and direct SDK callers
    // could not do before.
    idempotencyKey: z.string().min(1).max(256).optional(),
  })
  // STRICT on the object, before the refinement: ZodEffects has no `.strict()`.
  .strict()
  // Same mutual exclusion the run-create schema enforces: an environment's
  // closed server set is the point, so a `servers` override alongside it would
  // have to be silently dropped.
  .refine((body) => !body.environmentId || (body.servers?.length ?? 0) === 0, {
    message:
      "environmentId and servers are mutually exclusive — an environment supplies its own closed server set.",
  });

/**
 * Build createTestCase / updateTestCase mutation args from the public case
 * body. `defaultModels` (resolved from the suite when the body omits models)
 * is only used for create — update leaves models untouched when omitted.
 */
/**
 * The case body either write path may hand to {@link buildCaseMutationArgs}.
 *
 * Create's `import` is a claim; PATCH's is a claim OR `null` (remove it), so
 * the two schemas do not infer to one type. Widened here rather than casting at
 * the PATCH call site, which would lose exactly the `null` this has to carry.
 */
type CaseMutationBody = Omit<z.infer<typeof createCaseSchema>, "import"> & {
  import?: z.infer<typeof publicCaseImportSchema> | null;
};

function buildCaseMutationArgs(
  body: CaseMutationBody,
  opts: {
    forCreate: boolean;
    defaultModels?: Array<{ model: string; provider: string }>;
    /** The persisted case's caseType, so a kind-less PATCH keeps its kind. */
    existingCaseType?: string;
    /**
     * The persisted case's `steps`, so a step-native render-check row (a single
     * model-free `toolCall` step) created WITHOUT a legacy `caseType` is still
     * recognized as render-check — otherwise a same-kind PATCH is wrongly
     * rejected as an immutable kind change.
     */
    existingSteps?: unknown;
    /** The persisted case's match options, to merge a partial PATCH onto. */
    existingMatchOptions?: unknown;
    /** The persisted case's probeConfig, to merge a partial renderCheck PATCH onto. */
    existingProbeConfig?: any;
  },
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  let isModelFreeStepsCase = false;
  // The public field is `id` (what a caller reads back on the case DTO); the
  // storage argument is `caseId`, which lands in `declaredCaseId`. It is never
  // the `caseKey` — that stays the platform's own random `ui_*` storage key.
  // Only create carries one; `updateCaseSchema` has no `id` to forward.
  if ("id" in body && body.id !== undefined) args.caseId = body.id;
  if (body.title !== undefined) args.title = body.title;
  if (body.iterations !== undefined) args.runs = body.iterations;
  if (body.repetitions !== undefined) args.repetitions = body.repetitions;
  if (body.passThreshold !== undefined) args.passThreshold = body.passThreshold;
  if (body.isNegative !== undefined) args.isNegativeTest = body.isNegative;
  if (body.scenario !== undefined) args.scenario = body.scenario;
  if (body.expectedOutput !== undefined)
    args.expectedOutput = body.expectedOutput;

  // The case body is the `steps` contract. Project it onto the internal case
  // fields. The derived kind (render-check ⇔ a single model-free `toolCall`
  // step) is IMMUTABLE after create — updateTestCase doesn't accept caseType,
  // so reject a real change on update and never forward caseType there.
  if (body.steps !== undefined) {
    const steps = withImplicitRenderAssertForSingleToolCall(
      body.steps as TestStep[],
    );
    args.steps = steps;
    const derived = stepsToInternalCaseFields(steps);
    isModelFreeStepsCase = derived.caseType === "widget_probe";
    const derivedKind =
      derived.caseType === "widget_probe" ? "render-check" : "prompt";
    // Recognize the persisted kind from EITHER the legacy `caseType` OR the
    // shape of the stored `steps` (a model-free case is render-check), so
    // step-native render-checks without a `caseType` aren't misread as prompt.
    const existingIsRenderCheck =
      opts.existingCaseType === "widget_probe" ||
      isModelFree(normalizeSteps(opts.existingSteps));
    const existingKind = existingIsRenderCheck ? "render-check" : "prompt";

    if (!opts.forCreate && derivedKind !== existingKind) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        `Case kind is immutable (this case is "${existingKind}"); create a new case to change it.`,
      );
    }

    if (derived.caseType === "widget_probe") {
      args.query = "";
    } else {
      args.query = derived.query;
      if (derived.expectedToolCalls !== undefined) {
        args.expectedToolCalls = derived.expectedToolCalls;
      }
    }
  }

  if (body.models !== undefined) {
    args.models = body.models.map(toPersistedModelEntry);
  } else if (opts.forCreate) {
    args.models = isModelFreeStepsCase ? [] : opts.defaultModels ?? [];
  }

  // On create, a null override is meaningless (nothing to clear) — omit it so
  // the create mutation, which doesn't accept null, never sees it.
  if (
    body.matchOptions !== undefined &&
    !(opts.forCreate && body.matchOptions === null)
  )
    args.matchOptions =
      body.matchOptions === null
        ? null
        : // Create sets a fresh override from the provided fields; update merges
        // the partial patch onto the case's existing override so unmentioned
        // fields aren't reset.
        opts.forCreate
        ? toInternalMatchOptions(body.matchOptions)
        : mergeMatchOptions(opts.existingMatchOptions, body.matchOptions);
  if (body.checks !== undefined && !(opts.forCreate && body.checks === null))
    args.predicates =
      body.checks === null
        ? null
        : { mode: body.checks.mode, list: body.checks.list };

  // The import CLAIM, forwarded by name.
  //
  // Explicit rather than spread through, because `args` is built key by key
  // from a strict schema: a field nobody names here never reaches Convex, and
  // "the claim silently didn't persist" is indistinguishable from "the case was
  // authored natively" once the write has landed.
  //
  // `null` is a real value on PATCH (remove the claim) and is unrepresentable
  // on create, where `createCaseSchema` rejects it before this runs — so
  // `undefined` is the only "leave it alone", exactly as the mutation reads it.
  if (body.import !== undefined) args.import = body.import;

  return args;
}

/**
 * Assert a case body can be CREATED, and hand back its narrowed title.
 *
 * `steps` is optional on the shared case shape so PATCH can be a partial
 * update, but a create must carry the steps-first contract — otherwise the case
 * is persisted with no executable steps. Shared by the single and batch routes
 * so the two cannot disagree about what "creatable" means; `label` names the
 * offending case when one call carries many.
 */
function assertCreatableCase(
  body: { title?: string; steps?: unknown },
  label = "",
): string {
  if (!body.title) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `${label}title is required.`,
    );
  }
  if (!Array.isArray(body.steps) || body.steps.length === 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `${label}steps is required and must be a non-empty array when creating a case.`,
    );
  }
  return body.title;
}

/**
 * Turn one batch item's failure into the v1 error a single-case caller expects.
 *
 * The batch mutation reports per-item problems as data rather than throwing, so
 * a caller that authored exactly one case would otherwise get a 201 carrying a
 * failure. Identity and duplicate collisions are 409 (the request was
 * well-formed; the suite is not in a state that accepts it); everything else is
 * the caller's payload, so 400.
 */
function caseBatchFailureToWebError(
  entry: CaseBatchFailedEntry,
): WebRouteError {
  const conflict =
    entry.code === "DUPLICATE_CASE_ID" ||
    entry.code === "DUPLICATE_IDEMPOTENCY_KEY" ||
    entry.code === "IDEMPOTENCY_CONFLICT" ||
    entry.code === "DUPLICATE_CONTENT";
  return new WebRouteError(
    conflict ? 409 : 400,
    conflict ? ErrorCode.CONFLICT : ErrorCode.VALIDATION_ERROR,
    entry.message,
    // The stable code is what a program branches on; the message is prose and
    // may be reworded.
    { reason: entry.code },
  );
}

/**
 * Map an error thrown by a Convex suite/case write mutation onto a v1 error.
 * Convex surfaces validation failures as plain Errors; the common cases (not
 * found / unauthorized, and the suite/case invariant guards like "Positive
 * test cases must include at least one assertion") are caller mistakes (404 /
 * 400), not 500s.
 */
function translateConvexWriteError(error: unknown): WebRouteError {
  return translateConvexError(error, {
    resource: "Resource",
    // Eval writes span suites, cases, runs and schedules, and Convex collapses
    // "missing" and "not visible to you" into one error — naming the specific
    // resource would leak which link in that chain the caller cannot see.
    notFoundMessage: "Resource not found",
    fallbackMessage: "Eval write rejected by the platform",
  });
}

/**
 * Resolve public host attachments (`{ host, servers? }`) to the internal
 * `{ namedHostId, selectedServerIds? }` shape. Host names resolve via the
 * project's host catalog; per-host server names resolve against the suite's
 * own environment bindings (no live connection, no extra catalog query).
 */
/**
 * Resolve a sandbox-image selector (name or id) to the `computerEnvironments`
 * row a suite's eval runs boot from.
 *
 * Name-or-id, matching every other selector on this surface — an agent that
 * just read `list_sandbox_images` has the name in hand, and making it round
 * trip for an id would be the only place we ask that. Ambiguous names are a
 * 400 rather than a silent first-match: two images called "playwright" is a
 * situation only the caller can resolve.
 *
 * Returns the row so callers can report the resolved NAME back — a caller must
 * be able to echo what it just set without a second read.
 */
async function resolveComputerEnvironment(
  readClient: ReturnType<typeof createConvexReadClient>,
  projectId: string,
  selector: string,
): Promise<{ id: string; name: string }> {
  const trimmed = selector.trim();
  let rows: any[] | null | undefined;
  try {
    rows = await readClient.query(
      "computerEnvironments:listEnvironments" as any,
      { projectId },
    );
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  const list = rows ?? [];
  const byId = list.find((row: any) => String(row.environmentId) === trimmed);
  if (byId) {
    return { id: String(byId.environmentId), name: String(byId.name ?? "") };
  }
  const matches = list.filter(
    (row: any) =>
      String(row.name ?? "").toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
  );
  if (matches.length > 1) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Computer image name "${trimmed}" is ambiguous; use the image id.`,
    );
  }
  if (matches.length === 0) {
    // Enumerate the real choices: a typo is then one round trip to fix rather
    // than a bare not-found, and the picker's contents are not otherwise
    // visible from a shell.
    const available = list
      .map((row: any) => `${row.name} (id: ${row.environmentId})`)
      .join(", ");
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      `Computer image "${trimmed}" was not found in this project.${
        available ? ` Available: ${available}.` : ""
      }`,
    );
  }
  return {
    id: String(matches[0].environmentId),
    name: String(matches[0].name ?? ""),
  };
}

async function resolveHostAttachments(
  convexClient: ReturnType<typeof createConvexClients>["convexClient"],
  projectId: string,
  suite: SuiteDoc,
  hosts: Array<{ host: string; servers?: string[] }>,
): Promise<Array<Record<string, unknown>>> {
  if (hosts.length === 0) return [];
  let hostList: any[];
  try {
    hostList = await convexClient.query("hosts:listHosts" as any, {
      projectId,
    });
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  const byId = new Map<string, any>();
  const byName = new Map<string, any[]>();
  for (const h of hostList ?? []) {
    byId.set(String(h.hostId), h);
    const key = String(h.name ?? "").toLocaleLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), h]);
  }
  const bindingByName = new Map<string, string>();
  const bindingIds = new Set<string>();
  for (const b of suite.environment?.serverBindings ?? []) {
    if (b?.projectServerId) {
      const id = String(b.projectServerId);
      bindingIds.add(id);
      bindingByName.set(String(b.serverName).toLocaleLowerCase(), id);
    }
  }

  return hosts.map(({ host, servers }) => {
    const trimmed = host.trim();
    let resolved = byId.get(trimmed);
    if (!resolved) {
      const matches = byName.get(trimmed.toLocaleLowerCase()) ?? [];
      if (matches.length > 1) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          `Host name "${trimmed}" is ambiguous; use the host id.`,
        );
      }
      resolved = matches[0];
    }
    if (!resolved) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        `Host "${trimmed}" not found in this project.`,
      );
    }
    const attachment: Record<string, unknown> = {
      namedHostId: String(resolved.hostId),
    };
    if (servers !== undefined) {
      attachment.selectedServerIds = servers.map((entry) => {
        const trimmed = entry.trim();
        const byName = bindingByName.get(trimmed.toLocaleLowerCase());
        if (byName) return byName;
        if (bindingIds.has(trimmed)) return trimmed;
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          `Server "${entry}" is not in the suite's environment by name (as bound) or id; add it via environment.servers first.`,
        );
      });
    }
    return attachment;
  });
}

// ── Run launch: the core both run routes share ───────────────────────

/** What a successful launch produced, in the shape both 202 receipts echo. */
interface LaunchedEvalRun {
  runId: string;
  suiteId: string;
  /**
   * What the run IS, not what a launch would make it. `running` for a fresh
   * start; on an idempotent replay, the existing run's own status — which may
   * already be terminal.
   */
  status: string;
  /** This request replayed an existing run instead of starting one. */
  deduped: boolean;
  caseUpsert: unknown;
  servers: Array<{ id: string; name?: string }>;
  environment: {
    id: string;
    name: string | undefined;
    revision: number | undefined;
  } | null;
}

/**
 * Connect the servers, prepare the run, and DETACH its execution.
 *
 * EXTRACTED rather than forked: the batch route launches N of these, and a
 * second copy of manager lifecycle + prepare + detach + finalize-on-failure is
 * exactly the kind of duplicate that drifts silently — one route gains a
 * cleanup path the other never learns about, and the symptom is a stranded
 * `running` row nobody can explain.
 *
 * `onSettled` fires EXACTLY ONCE, when the detached execution finishes. It does
 * NOT fire when this function throws: a synchronous launch failure never
 * reaches background execution, so its caller owns that accounting. That split
 * is the whole reason release is a callback here rather than done inline — a
 * group holds one slot across N siblings and must release it only after the
 * last of them settles, however each of them ended.
 */
async function launchEvalRun(params: {
  callerContext: ReturnType<typeof callerContextFromHono>;
  xaaIssuer: ReturnType<typeof resolveXaaIssuer>;
  projectId: string;
  convexAuthToken: string;
  body: Record<string, unknown> & {
    tests: PublicInlineTest[];
    suiteId?: string;
    matchOptionsOverride?: unknown;
  };
  suiteRerun: boolean;
  environmentId: string | undefined;
  environmentLaunch: ResolvedEnvironmentForLaunch | undefined;
  serverIds: string[];
  serverNames: string[] | undefined;
  onSettled: () => void;
}): Promise<LaunchedEvalRun> {
  const {
    projectId,
    convexAuthToken,
    body,
    suiteRerun,
    environmentId,
    environmentLaunch,
    serverIds,
    serverNames,
    onSettled,
  } = params;

  // Manual connection lifecycle (mirrors the web stream-test-case route):
  // the manager must outlive this request — it is the background task's MCP
  // transport — so `withManager`'s request-scoped teardown can't be used.
  const { manager } = await createAuthorizedManager(
    params.callerContext,
    convexAuthToken,
    projectId,
    serverIds,
    WEB_CALL_TIMEOUT_MS,
    undefined,
    undefined,
    {
      serverNames,
      // v1 eval API has no host-persona input — no enterprise policy to
      // enforce; the issuer makes per-server XAA servers mint instead of
      // failing with 'Missing XAA issuer'.
      xaaIssuer: params.xaaIssuer,
    },
  );

  let prepared: PreparedEvalRun;
  try {
    prepared = await prepareEvalRun(manager, {
      ...(body as any),
      // Public → internal match-option vocabulary, resolved at the boundary so
      // nothing downstream learns there were ever two.
      ...(body.matchOptionsOverride !== undefined
        ? {
            matchOptionsOverride: normalizeRunMatchOptionsOverride(
              body.matchOptionsOverride,
            ),
          }
        : {}),
      // Project the public `steps`-based inline tests onto the internal
      // run-schema test shape the pipeline still consumes.
      tests: body.tests.map(publicInlineTestToRunTest),
      serverIds,
      serverNames,
      // The SELECTED id, which may have been auto-derived from a
      // single-environment suite — not `body.environmentId`. Passing it makes
      // the shared path pin the run to the revision resolved above
      // (`expectedEnvironmentRevision`), instead of letting the backend
      // re-select the same environment unpinned.
      environmentId,
      projectId,
      suiteRerun,
      convexAuthToken,
      source: "api",
      // Reuse this exact resolution (and its revision) rather than letting
      // the shared path resolve again — the run must be pinned to the
      // revision whose servers the manager just connected.
      ...(environmentLaunch ? { resolvedEnvironment: environmentLaunch } : {}),
    });
  } catch (error) {
    await manager.disconnectAllServers().catch(() => {});
    throw error;
  }

  // Detach: the runner owns terminal run status (it finalizes a failed
  // run itself, then rethrows). The catch is defense for errors thrown
  // outside the runner's own try (provider construction, etc.) — it only
  // finalizes when the run record is still non-terminal, so the runner's
  // completedAt/notes are never restamped by a second terminal write.
  // A REPLAY of a finished run executes nothing. `prepared.execute()` would
  // re-run every case and bill for it, writing over results that are already
  // final — the exact double-spend the caller sent an idempotency key to
  // prevent. The slot and the manager still have to be settled here, because
  // the `.finally` that normally does it belongs to an execution that is not
  // going to happen.
  if (shouldSkipExecution(prepared)) {
    logger.info("[v1 evals] idempotent replay — not re-executing", {
      runId: prepared.runId,
      suiteId: prepared.suiteId,
      status: prepared.status,
      projectId,
    });
    onSettled();
    void manager.disconnectAllServers().catch(() => {});
    return {
      runId: prepared.runId,
      suiteId: prepared.suiteId,
      status: prepared.status ?? "running",
      deduped: true,
      caseUpsert: prepared.caseUpsert,
      servers: serverIds.map((serverId, index) => ({
        id: serverId,
        ...(serverNames?.[index] ? { name: serverNames[index] } : {}),
      })),
      environment: environmentLaunch
        ? {
            id: environmentLaunch.environmentRef.environmentId,
            name: environmentLaunch.environmentRef.name,
            revision: environmentLaunch.environmentRef.revision,
          }
        : null,
    };
  }

  void prepared
    .execute()
    .catch(async (error) => {
      logger.error("[v1 evals] background eval run failed", error, {
        runId: prepared.runId,
        suiteId: prepared.suiteId,
        projectId,
      });
      if (await isRunAlreadyTerminal(convexAuthToken, prepared.runId)) {
        return;
      }
      await prepared.recorder
        .finalize({
          status: "failed",
          notes:
            error instanceof Error
              ? error.message.slice(0, 500)
              : String(error).slice(0, 500),
        })
        .catch(() => {});
    })
    .finally(() => {
      onSettled();
      void manager.disconnectAllServers().catch(() => {});
    });

  return {
    runId: prepared.runId,
    suiteId: prepared.suiteId,
    // Executing now. A replay of a run still IN FLIGHT lands here too and is
    // reported as running, which is what it is.
    status: prepared.status ?? "running",
    deduped: prepared.deduped === true,
    caseUpsert: prepared.caseUpsert,
    // The servers the run connects to — explicit or derived from the
    // suite's saved selection — so callers that omitted serverIds can
    // see what the run targets. Names are present when known (always,
    // on the derived path).
    servers: serverIds.map((serverId, index) => ({
      id: serverId,
      ...(serverNames?.[index] ? { name: serverNames[index] } : {}),
    })),
    // The environment this run is pinned to, at the revision whose servers
    // were just connected. Echoed even when the caller omitted it, because
    // a single-environment suite auto-selects — the caller would otherwise
    // have no way to know an environment was applied. `null` on a legacy run.
    environment: environmentLaunch
      ? {
          id: environmentLaunch.environmentRef.environmentId,
          name: environmentLaunch.environmentRef.name,
          revision: environmentLaunch.environmentRef.revision,
        }
      : null,
  };
}

/**
 * Resolve the server set — and, when applicable, the environment — that one
 * launch connects. The decision that must happen BEFORE a manager is built and
 * before anything spends.
 *
 * Shared by both routes for the reason the launcher is: the environment rules
 * here (attachment, override exclusivity, ambiguity) are the ones a caller
 * hits, and they have to be the same rules on both surfaces.
 */
async function resolveLaunchServers(params: {
  convexAuthToken: string;
  projectId: string;
  suiteId: string | undefined;
  requestedEnvironmentId: string | undefined;
  namedHostId: string | undefined;
  requestedServerIds: string[];
  requestedServerNames: string[] | undefined;
  ephemeralEnvironment?: boolean;
}): Promise<{
  environmentId: string | undefined;
  environmentLaunch: ResolvedEnvironmentForLaunch | undefined;
  serverIds: string[];
  serverNames: string[] | undefined;
}> {
  const { convexAuthToken, projectId, suiteId, namedHostId } = params;

  // WHICH environment this run uses is decided from the suite's attachments,
  // not from the caller's word — and decided HERE, before `prepareEvalRun`
  // authors a suite or a case and before the manager opens a connection, so an
  // unattached environment, an ambiguous multi-environment suite, or a server
  // override on an environment-based suite all fail with nothing written. See
  // `selectSuiteEnvironmentId` for the full rule. Inline-only runs (no suiteId)
  // have no attachments to consult, and the schema already forbids
  // `environmentId` without a `suiteId`.
  const environmentId = suiteId
    ? await selectSuiteEnvironmentId({
        convexAuthToken,
        projectId,
        suite: await readSuiteInProject(convexAuthToken, projectId, suiteId),
        requestedEnvironmentId: params.requestedEnvironmentId,
        hasServerOverride: params.requestedServerIds.length > 0,
        serverField: "serverIds",
        ...(params.ephemeralEnvironment === true
          ? { ephemeralEnvironment: true }
          : {}),
      })
    : undefined;

  // The environment owns its server set, so resolve it before the manager is
  // built: the manager must connect the environment's closed set (including the
  // servers its pinned plugin versions contribute), not the suite's saved
  // selection — connecting the wrong set would make the tool snapshot disagree
  // with what the run executes. The resolved value is handed to
  // `prepareEvalRun` as `resolvedEnvironment` so it doesn't resolve a second
  // time and risk a different revision.
  let environmentLaunch: ResolvedEnvironmentForLaunch | undefined;
  let serverIds = params.requestedServerIds;
  let serverNames = params.requestedServerNames;
  if (environmentId) {
    const convex = createConvexReadClient(convexAuthToken);
    try {
      environmentLaunch = await resolveEnvironmentForLaunch(convex, {
        projectId,
        environmentId,
      });
    } catch (error) {
      throw translateEnvironmentResolveError(error);
    }
    serverIds = environmentServerIds(environmentLaunch);
    serverNames = environmentServerNames(environmentLaunch);
  } else if (serverIds.length === 0) {
    // Omitted serverIds on a rerun (the schema guarantees suiteId here):
    // connect the suite's saved server selection — the exact set the run
    // snapshot will reference — instead of making the caller guess it.
    const selection = await fetchSuiteRunServerSelection(
      convexAuthToken,
      suiteId!,
      namedHostId,
    );
    serverIds = selection.serverIds;
    serverNames = selection.serverNames;
  }

  return { environmentId, environmentLaunch, serverIds, serverNames };
}

/** A target in the caller's own words, for a per-target error message. */
function describeRunGroupTarget(target: {
  environmentId?: string;
  namedHostId?: string;
  name?: string;
}): string {
  if (target.namedHostId) {
    return target.name
      ? `Host "${target.name}" (${target.namedHostId})`
      : `Host ${target.namedHostId}`;
  }
  return `Environment ${target.environmentId}`;
}

/**
 * Flatten one target's launch failure into the receipt's `{code, message}`.
 *
 * The CODE is preserved when the error carries one, because a per-target entry
 * is the only place a caller learns why THAT target failed — collapsing an
 * `ENVIRONMENT_REVISION_CONFLICT` (retry this target) and a genuine internal
 * error (do not) into one opaque string would make the receipt unactionable.
 */
function describeLaunchFailure(error: unknown): {
  code: string;
  message: string;
} {
  if (error instanceof WebRouteError) {
    return {
      code: String(error.code ?? ErrorCode.INTERNAL_ERROR),
      message: error.message.slice(0, 500),
    };
  }
  return {
    code: ErrorCode.INTERNAL_ERROR,
    message: (error instanceof Error ? error.message : String(error)).slice(
      0,
      500,
    ),
  };
}

// ── Routes ───────────────────────────────────────────────────────────

// POST /v1/projects/:projectId/eval-runs
// Create a suite run (existing suiteId rerun and/or inline tests) and start
// executing it in the background. Responds 202 with the runId immediately;
// poll GET /eval-runs/:runId for progress.
evals.post("/projects/:projectId/eval-runs", async (c) => {
  const projectId = c.req.param("projectId");
  // Read WITHOUT injecting path params, so the strict schema sees only the
  // caller's fields. `projectId` is a declared key and is merged back in —
  // path wins over a body value, same as before.
  const rawBody = await readJsonObjectBody(c);
  const headerIdempotencyKey = readIdempotencyKey(c);
  const body = parseWithSchema(createEvalRunSchema, {
    ...rawBody,
    projectId,
    // The HEADER wins over any body value. Both are caller-supplied, but the
    // header is the transport-level channel unattended clients use, and it is
    // the one the agent adapter controls — a body key could otherwise be
    // shaped by model output.
    ...(headerIdempotencyKey ? { idempotencyKey: headerIdempotencyKey } : {}),
  });

  // `suiteRerun` semantics from the web surface: a bare `suiteId` rerun has
  // no inline tests to upsert, so it is ALWAYS a rerun — forcing true here
  // (even over an explicit `suiteRerun: false`) keeps a caller from baking
  // suite defaults into per-case overrides on a plain rerun.
  const suiteRerun =
    Boolean(body.suiteId) && body.tests.length === 0
      ? true
      : body.suiteRerun ?? false;

  // Fail unknown models now, with a pointer to valid ids, rather than
  // letting the detached run die later with an opaque stream error.
  assertInlineTestModelsValid(body.tests, body.modelApiKeys);

  // Resolved once, synchronously: the background task captures this token
  // in its closure (its TTL covers a capped run; see v1-convex-token.ts).
  // It is ALSO the bearer handed to the manager: the manager's
  // bearer-forwarding paths (hosted OAuth force-refresh, secret reveal)
  // hit Convex's JWT-only surfaces, where an `sk_` API key is useless —
  // same swap `runEphemeralConnection` does for the synchronous routes.
  const convexAuthToken = await getConvexBearerForRequest(c);

  const { environmentId, environmentLaunch, serverIds, serverNames } =
    await resolveLaunchServers({
      convexAuthToken,
      projectId,
      suiteId: body.suiteId,
      requestedEnvironmentId: body.environmentId,
      namedHostId: body.namedHostId,
      requestedServerIds: body.serverIds ?? [],
      requestedServerNames: body.serverNames,
      ...(body.ephemeralEnvironment === true
        ? { ephemeralEnvironment: true }
        : {}),
    });

  const slotKey = orgConcurrencyKey(c);
  if (!tryAcquireRunSlot(slotKey)) {
    return v1Error(
      c,
      "RATE_LIMITED",
      `Too many concurrent eval runs (max ${MAX_CONCURRENT_RUNS}). Wait for an active run to finish.`,
      {
        reason: "CONCURRENT_RUN_LIMIT",
        maxConcurrentRuns: MAX_CONCURRENT_RUNS,
      },
    );
  }

  // Manual connection lifecycle (mirrors the web stream-test-case route):
  // the manager must outlive this request — it is the background task's MCP
  // transport — so `withManager`'s request-scoped teardown can't be used.
  let released = false;
  const releaseSlotOnce = () => {
    if (!released) {
      released = true;
      releaseRunSlot(slotKey);
    }
  };

  try {
    const launched = await launchEvalRun({
      callerContext: callerContextFromHono(c),
      xaaIssuer: resolveXaaIssuer(c, HOSTED_MODE),
      projectId,
      convexAuthToken,
      body,
      suiteRerun,
      environmentId,
      environmentLaunch,
      serverIds,
      serverNames,
      onSettled: releaseSlotOnce,
    });

    return v1Resource(
      c,
      {
        runId: launched.runId,
        suiteId: launched.suiteId,
        // The run's REAL status. A replay of a finished run reports what it
        // finished as; only a launch reports `running`.
        status: launched.status,
        // Present so a caller can tell "I started this" from "this already
        // existed and I got it back" without diffing run ids across retries.
        ...(launched.deduped ? { deduped: true } : {}),
        caseUpsert: launched.caseUpsert,
        servers: launched.servers,
        environment: launched.environment,
        // Echoed as a LABEL, never as quota: a caller-supplied group id groups
        // rows for display and does nothing else. Grouped-launch semantics —
        // one org slot for a whole fan-out, validate-all-then-launch — live
        // exclusively on POST /eval-run-groups, where the server mints the id
        // itself. Honouring a client id here would let a caller claim group
        // treatment for N independent single launches.
        ...(body.runGroupId ? { runGroupId: body.runGroupId } : {}),
      },
      202,
    );
  } catch (error) {
    releaseSlotOnce();
    throw error;
  }
});

// ── POST /v1/projects/:projectId/eval-run-groups ─────────────────────
//
// Launch ONE run per target (attached environments, or attached named hosts)
// under a single server-minted group id.
//
// THE ONLY SURFACE WITH GROUPED-LAUNCH QUOTA SEMANTICS. `POST /eval-runs`
// accepts a `runGroupId` as a display label and gives it no quota treatment
// whatsoever, because a caller-supplied id is a claim about intent and this
// route is the only place the server can verify one: it mints the id, bounds
// the fan-out, validates every target before launching any of them, and holds
// exactly one concurrency slot for the whole group.
const evalRunGroupTargetSchema = z.union([
  z.object({ environmentId: z.string().min(1) }).strict(),
  z.object({ namedHostId: z.string().min(1) }).strict(),
]);

// STRICT, and the body is read without the path params merged in so it can be.
// The published spec says `additionalProperties: false` here; a non-strict
// schema would make that a lie in the one direction that costs a caller
// something — `refreshSnapshot` (valid on the single-run route, and a PERSISTED
// suite mutation there) would be accepted, dropped, and reported as success,
// leaving the caller believing a snapshot refreshed that never did.
const createEvalRunGroupSchema = z.object({
  suiteId: z.string().min(1),
  targets: z
    .array(evalRunGroupTargetSchema)
    .min(1)
    .max(MAX_RUN_GROUP_TARGETS),
  iterationOverride: z.number().int().min(1).max(10).optional(),
  caseIds: z.array(z.string().min(1)).min(1).optional(),
  // Both vocabularies, same union and same normalization as the single-run
  // route — a knob that works on one launch shape and not the other is a knob
  // callers have to remember two rules for.
  matchOptionsOverride: z
    .union([publicMatchOptionsSchema, matchOptionsSchema])
    .optional(),
  skillsOverride: z.literal("exclude").optional(),
  notes: z.string().optional(),
  passCriteria: z.object({ minimumPassRate: z.number() }).optional(),
  idempotencyKey: z.string().min(1).max(256).optional(),
  ephemeralEnvironment: z.boolean().optional(),
  /**
   * Per-run approval of `approximated` imported cases, by hosted case id.
   *
   * The SAME approvals go to every target. A case's approximation is
   * approximated the same way on each of them, so approving per target would
   * make one human decision into N, and the caller who approved it once meant
   * it once.
   */
  importApprovals: z
    .array(
      z
        .object({
          testCaseId: z.string().min(1),
          reason: z.string().trim().min(1).max(500),
        })
        .strict(),
    )
    .min(1)
    .optional(),
})
  // STRICT, like every other v1 write body: the published contract says an
  // unknown key is invalid, and the two knobs this route deliberately omits
  // (`serverIds`, `refreshSnapshot`) are exactly the ones a caller is most
  // likely to try. Stripping them would answer 202 while silently discarding
  // the knob the caller asked for.
  .strict();

/**
 * Deterministic group id for a keyed launch.
 *
 * DERIVED from the caller's key rather than minted and then recorded: a
 * recorded mapping has to survive the crash it exists to protect against, and
 * a derivation cannot be lost. A replay after a crash mid-launch re-enters the
 * loop with the SAME group id and the same per-target run keys, so every
 * target that already started dedupes at the run level instead of launching a
 * second paid run — and the rebuilt receipt names the original run ids.
 *
 * An UNKEYED launch gets a random id, which is the honest answer: a request
 * with no replay identity has no replay semantics to offer.
 */
function deriveRunGroupId(
  suiteId: string,
  idempotencyKey: string | undefined,
): string {
  if (!idempotencyKey) return randomUUID();
  return createHash("sha256")
    .update(`eval-run-group:${suiteId}:${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32);
}

evals.post("/projects/:projectId/eval-run-groups", async (c) => {
  const projectId = c.req.param("projectId");
  const headerIdempotencyKey = readIdempotencyKey(c);
  // Read WITHOUT the path params merged in, so the strict schema above sees
  // only the caller's fields and an unsupported knob is refused rather than
  // silently dropped. `projectId` comes from the path either way — merging it
  // in and destructuring it back out would only give `.strict()` two keys the
  // caller never sent.
  const body = parseWithSchema(createEvalRunGroupSchema, {
    ...(await readJsonObjectBody(c)),
    // Same precedence as the single-run route: the header is the
    // transport-level channel unattended clients control, and a body key could
    // be shaped by model output.
    ...(headerIdempotencyKey ? { idempotencyKey: headerIdempotencyKey } : {}),
  });

  // ONE AXIS PER GROUP, mirroring the rule the web fan-out already follows.
  // A mixed group would have to answer "does this host run inside that
  // environment, or beside it?", and every answer to that is a cross product
  // nobody asked for.
  const environmentTargets = body.targets.filter(
    (target): target is { environmentId: string } => "environmentId" in target,
  );
  const hostTargets = body.targets.filter(
    (target): target is { namedHostId: string } => "namedHostId" in target,
  );
  if (environmentTargets.length > 0 && hostTargets.length > 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Targets must be all environments or all hosts, not a mix — a group fans out along ONE axis.",
      { reason: "HETEROGENEOUS_TARGETS" },
    );
  }

  const convexAuthToken = await getConvexBearerForRequest(c);
  const suite = await readSuiteInProject(
    convexAuthToken,
    projectId,
    body.suiteId,
  );

  // Deduplicate by resolved id, preserving the caller's order. Two entries for
  // the same target are one target, not two paid runs.
  const attachedEnvironmentIds = suiteEnvironmentIds(suite);
  const attachedHosts: Array<{ id: string; name: string }> = Array.isArray(
    suite.hostAttachments,
  )
    ? suite.hostAttachments.map((host: any) => ({
        id: String(host.namedHostId),
        name: String(host.hostName ?? ""),
      }))
    : [];

  const seen = new Set<string>();
  const targets: Array<{
    environmentId?: string;
    namedHostId?: string;
    name?: string;
  }> = [];
  for (const target of body.targets) {
    const id =
      "environmentId" in target ? target.environmentId : target.namedHostId;
    if (seen.has(id)) continue;
    seen.add(id);
    if ("environmentId" in target) {
      // VALIDATE EVERY TARGET BEFORE LAUNCHING ANY: a group that starts target
      // 1 and then rejects target 2 has already spent on a request that was
      // never satisfiable, and there is no refund for a started run.
      if (body.ephemeralEnvironment === true) {
        await assertEphemeralEnvironmentLaunchable(
          convexAuthToken,
          projectId,
          target.environmentId,
        );
      } else if (!attachedEnvironmentIds.includes(target.environmentId)) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          `Environment ${target.environmentId} is not attached to this suite. Attached environments: ${await describeAttachedEnvironments(
            convexAuthToken,
            projectId,
            attachedEnvironmentIds,
          )}.`,
          {
            reason: "ENVIRONMENT_NOT_ATTACHED",
            environmentId: target.environmentId,
            environmentIds: attachedEnvironmentIds,
          },
        );
      }
      targets.push({ environmentId: target.environmentId });
    } else {
      const host = attachedHosts.find(
        (candidate) => candidate.id === target.namedHostId,
      );
      if (!host) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          attachedHosts.length === 0
            ? `Host ${target.namedHostId} is not attached to this suite, which has no hosts at all. Attach it first (PATCH the suite with hosts), then retry.`
            : `Host ${target.namedHostId} is not attached to this suite. Attached hosts: ${attachedHosts
                .map((candidate) => `"${candidate.name}" (${candidate.id})`)
                .join(", ")}.`,
          {
            reason: "HOST_NOT_ATTACHED",
            namedHostId: target.namedHostId,
            hostIds: attachedHosts.map((candidate) => candidate.id),
          },
        );
      }
      targets.push({ namedHostId: host.id, name: host.name });
    }
  }

  // DRY RUN, still before anything spends: resolve each target's servers and
  // run the static admission checks that need no run row — most importantly
  // the harness gate, so a suite pinned to a runtime this server cannot drive
  // is refused as a whole instead of after its first sibling has started.
  const resolved: Array<{
    target: (typeof targets)[number];
    servers: Awaited<ReturnType<typeof resolveLaunchServers>>;
  }> = [];
  for (const target of targets) {
    const servers = await resolveLaunchServers({
      convexAuthToken,
      projectId,
      suiteId: body.suiteId,
      requestedEnvironmentId: target.environmentId,
      namedHostId: target.namedHostId,
      requestedServerIds: [],
      requestedServerNames: undefined,
      ...(body.ephemeralEnvironment === true
        ? { ephemeralEnvironment: true }
        : {}),
    });
    // The host config THIS target executes under. An environment pins its own
    // host, so an environment target must be judged on that host's config —
    // reading the suite's instead would gate the wrong thing in both
    // directions: a harness-hosted environment would slip the dry run (and
    // fail at prepare, after its siblings had already started, which is the
    // exact sequencing this dry run exists to prevent), and a legacy suite
    // config carrying a harness would refuse a group of environments that
    // never referenced it.
    const hostConfig = await loadSuiteHostConfig(
      createConvexReadClient(convexAuthToken),
      body.suiteId,
      // `ResolvedEnvironmentForLaunch.hostId` is the same host the run row will
      // freeze, so the dry run and the launch judge one configuration.
      target.namedHostId ?? servers.environmentLaunch?.hostId,
    );
    const admission = checkEvalHarnessStaticAdmission({
      hostConfig,
      serverIds: servers.serverIds,
    });
    if (!admission.ok) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        `${describeRunGroupTarget(target)}: ${admission.reason}`,
        { reason: "HARNESS_UNAVAILABLE", harness: admission.harness },
      );
    }
    resolved.push({ target, servers });
  }

  const slotKey = orgConcurrencyKey(c);
  const slot = tryAcquireRunGroupSlot(slotKey, resolved.length);
  if (!slot) {
    return v1Error(
      c,
      "RATE_LIMITED",
      `Too many concurrent eval runs (max ${MAX_CONCURRENT_RUNS}). Wait for an active run to finish.`,
      {
        reason: "CONCURRENT_RUN_LIMIT",
        maxConcurrentRuns: MAX_CONCURRENT_RUNS,
      },
    );
  }

  const runGroupId = deriveRunGroupId(body.suiteId, body.idempotencyKey);
  const callerContext = callerContextFromHono(c);
  const xaaIssuer = resolveXaaIssuer(c, HOSTED_MODE);
  const matchOptionsOverride = normalizeRunMatchOptionsOverride(
    body.matchOptionsOverride,
  );

  const entries: Array<Record<string, unknown>> = [];
  let startedCount = 0;
  let failedCount = 0;

  for (const { target, servers } of resolved) {
    const targetDto = {
      ...(target.environmentId ? { environmentId: target.environmentId } : {}),
      ...(target.namedHostId ? { namedHostId: target.namedHostId } : {}),
      ...(target.name ? { name: target.name } : {}),
    };
    try {
      const launched = await launchEvalRun({
        callerContext,
        xaaIssuer,
        projectId,
        convexAuthToken,
        body: {
          suiteId: body.suiteId,
          tests: [],
          runGroupId,
          ...(body.iterationOverride !== undefined
            ? { iterationOverride: body.iterationOverride }
            : {}),
          ...(body.caseIds ? { caseIds: body.caseIds } : {}),
          ...(matchOptionsOverride ? { matchOptionsOverride } : {}),
          ...(body.skillsOverride
            ? { skillsOverride: body.skillsOverride }
            : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          ...(body.passCriteria ? { passCriteria: body.passCriteria } : {}),
          ...(target.namedHostId
            ? { namedHostId: target.namedHostId }
            : {}),
          ...(body.ephemeralEnvironment === true
            ? { ephemeralEnvironment: true }
            : {}),
          ...(body.importApprovals
            ? { importApprovals: body.importApprovals }
            : {}),
          // PER-TARGET run key derived from the group key. This is what makes a
          // replay after a crash mid-launch safe: each target dedupes at the
          // RUN level against the run the first attempt created, instead of
          // every sibling colliding on one key (which would return target 1's
          // run for every target) or sharing none (which would double-launch).
          ...(body.idempotencyKey
            ? {
                idempotencyKey: deriveItemIdempotencyKey(
                  `eval-run-group:${runGroupId}`,
                  target.environmentId ?? target.namedHostId ?? "",
                ),
              }
            : {}),
        },
        // A group launches persisted suites only — there are no inline tests to
        // upsert, so every target is a rerun.
        suiteRerun: true,
        environmentId: servers.environmentId,
        environmentLaunch: servers.environmentLaunch,
        serverIds: servers.serverIds,
        serverNames: servers.serverNames,
        onSettled: () => releaseRunGroupSlotRef(slot),
      });
      startedCount += 1;
      entries.push({
        target: targetDto,
        status: "started",
        runId: launched.runId,
        // `runStatus`, not a second `status`: the entry's own `status` is the
        // started/failed discriminant, and two fields with one name is how a
        // reader ends up branching on the wrong one.
        //
        // The run's REAL status, so a target that replayed a finished run says
        // so instead of claiming to be running.
        runStatus: launched.status,
        ...(launched.deduped ? { deduped: true } : {}),
        servers: launched.servers,
        environment: launched.environment,
        caseUpsert: launched.caseUpsert,
      });
    } catch (error) {
      // This target never reached background execution, so its `.finally`
      // will never run — decrement HERE or the group's slot outlives it.
      releaseRunGroupSlotRef(slot);
      failedCount += 1;
      const failure = describeLaunchFailure(error);
      logger.warn("[v1 evals] eval run group target failed to launch", {
        projectId,
        suiteId: body.suiteId,
        runGroupId,
        target: targetDto,
        error: failure.message,
      });
      entries.push({
        target: targetDto,
        status: "failed",
        error: failure,
      });
    }
  }

  return v1Resource(
    c,
    {
      runGroupId,
      suiteId: body.suiteId,
      // DISCRIMINATED, not an optional-field soup: a caller decides severity
      // from one field instead of comparing counts and guessing.
      outcome:
        startedCount === 0
          ? "failed"
          : failedCount > 0
            ? "partial"
            : "started",
      startedCount,
      failedCount,
      targets: entries,
      // Deprecated mirrors of the FIRST started run, so scripts and readers
      // written against the single-run receipt keep working. Absent when
      // nothing started — there is no first run to mirror, and inventing one
      // would be worse than the field being missing.
      ...(entries.find((entry) => entry.status === "started")
        ? (() => {
            const first = entries.find((entry) => entry.status === "started")!;
            return {
              runId: first.runId,
              status: first.runStatus,
              servers: first.servers,
              environment: first.environment,
              caseUpsert: first.caseUpsert,
            };
          })()
        : {}),
    },
    202,
  );
});

// POST /v1/projects/:projectId/eval-suites
// Author-only: CREATE a runnable eval suite (suite + test cases) WITHOUT
// running it. Synchronous — validation/persistence errors surface here.
// Responds 201 with the suiteId. Distinct from POST /eval-runs (which creates
// AND detaches execution, responding 202 with a runId). No concurrency slot,
// no recorder, no execution.
evals.post("/projects/:projectId/eval-suites", async (c) => {
  const projectId = c.req.param("projectId");
  const rawBody = await readJsonObjectBody(c);
  const body = parseWithSchema(createEvalSuiteSchema, rawBody);
  const idempotencyKey = readIdempotencyKey(c);

  // Expand ergonomic tests into the strict run-schema element shape, then
  // re-validate against the source-of-truth schema. Use parseWithSchema so a
  // second-stage failure (for example, an invalid advancedConfig.toolChoice)
  // surfaces as a 400 VALIDATION_ERROR rather than an uncaught ZodError → 500.
  const normalizedTests = parseWithSchema(
    RunEvalsRequestSchema.shape.tests,
    normalizeCreateTestsToRunTests(body.tests, {
      model: body.model,
      provider: body.provider,
    }),
  );

  // Reject unrunnable models up front, with a pointer to valid ids — same
  // gate the async run path applies.
  assertInlineTestModelsValid(normalizedTests, undefined);

  const convexAuthToken = await getConvexBearerForRequest(c);
  const serverIds = body.serverIds;
  const serverNames = body.serverNames;

  const { manager } = await createAuthorizedManager(
    callerContextFromHono(c),
    convexAuthToken,
    projectId,
    serverIds,
    WEB_CALL_TIMEOUT_MS,
    undefined,
    undefined,
    {
      serverNames,
      // v1 eval API has no host-persona input — no enterprise policy to
      // enforce; the issuer makes per-server XAA servers mint instead of
      // failing with 'Missing XAA issuer'.
      xaaIssuer: resolveXaaIssuer(c, HOSTED_MODE),
    },
  );

  // Author-only is fully synchronous: the manager is only needed to resolve
  // and validate the server selection, so disconnect it before responding.
  try {
    const resolvedServerIds = resolveServerIdsOrThrow(serverIds, manager);
    const { convexClient } = createConvexClients(convexAuthToken);
    const { suiteId, caseUpsert } = await authorEvalSuite({
      convexClient,
      tests: normalizedTests,
      resolvedServerIds,
      persistedServerRefs: resolvedServerIds,
      serverNames,
      projectId,
      suiteId: null,
      suiteName: body.name,
      suiteDescription: body.description,
      passCriteria: body.passCriteria,
      suiteRerun: false,
      refreshSnapshot: false,
      // Unattended callers (the Slack bot) send this so a retried turn
      // re-authors the same suite instead of a second one.
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return v1Resource(
      c,
      {
        suiteId,
        name: body.name,
        servers: serverIds.map((id, index) => ({
          id,
          ...(serverNames?.[index] ? { name: serverNames[index] } : {}),
        })),
        caseUpsert,
      },
      201,
    );
  } finally {
    await manager.disconnectAllServers().catch(() => {});
  }
});

// POST /v1/projects/:projectId/eval-suites/from-file
//
// Resolve or create a FILE-OWNED suite by declared id. Lookup is by
// `(projectId, declaredSuiteId)` and never by name. A UI-authored suite has
// no declared id, so this cannot claim it. Must be registered before
// `/:suiteId` so "from-file" is not captured as a suite id.
evals.post("/projects/:projectId/eval-suites/from-file", async (c) => {
  const projectId = c.req.param("projectId");
  const body = parseWithSchema(
    syncFileOwnedSuiteSchema,
    await readJsonObjectBody(c),
  );
  const token = await getConvexBearerForRequest(c);
  const { convexClient } = createConvexClients(token);
  let result: { created: boolean; suite: SuiteDoc | null };
  try {
    result = (await convexClient.mutation(
      "testSuites:resolveOrCreateFileOwnedSuite" as any,
      {
        projectId,
        declaredSuiteId: body.declaredSuiteId,
        name: body.name,
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        sourceHash: body.sourceHash,
        ...(body.provenance ? { provenance: body.provenance } : {}),
        ...(body.environment ? { environment: body.environment } : {}),
        ...(body.defaultConfig ? { defaultConfig: body.defaultConfig } : {}),
        ...(body.verdictPolicyVersion !== undefined
          ? { verdictPolicyVersion: body.verdictPolicyVersion }
          : {}),
        ...(body.verdictPolicyDefaults
          ? { verdictPolicyDefaults: body.verdictPolicyDefaults }
          : {}),
        ...(body.minIterations !== undefined
          ? { minIterations: body.minIterations }
          : {}),
        ...(body.defaultPassCriteria
          ? { defaultPassCriteria: body.defaultPassCriteria }
          : {}),
      },
    )) as { created: boolean; suite: SuiteDoc | null };
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  if (!result.suite) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "File-owned suite resolve returned no suite",
    );
  }
  const detail = await readSuiteDetail(
    token,
    projectId,
    String(result.suite._id),
  );
  return v1Resource(
    c,
    { created: result.created, suite: detail },
    result.created ? 201 : 200,
  );
});

// GET /v1/projects/:projectId/eval-runs/:runId
// Run status + summary. Poll this until status is terminal
// (completed | failed | cancelled).
evals.get("/projects/:projectId/eval-runs/:runId", async (c) => {
  const projectId = c.req.param("projectId");
  const runId = c.req.param("runId");
  const convex = createConvexReadClient(await getConvexBearerForRequest(c));

  let run: RunDoc | null;
  try {
    run = await convex.query("testSuites:getTestSuiteRun" as any, { runId });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval run not found");
    }
    throw error;
  }
  requireProjectMatch(run, projectId, "Eval run");

  // The common insights envelope, DETAIL only (lists stay compact). Failure
  // to load it — including an authorization refusal for a caller who can see
  // the run but not its insights — omits the field rather than failing the
  // read: the run itself is the resource here.
  const insights = await loadInsightsEnvelope("v1.evals", () =>
    convex.query("serverQuality:getEvalRunInsightsEnvelope" as any, {
      suiteRunId: runId,
    }),
  );

  return v1Resource(c, {
    ...toRunDto(run!),
    ...(insights ? { insights } : {}),
    // DETAIL only, like `insights` — a suite's run list stays compact. Always
    // present, so a caller can read `judges.goalCompletion.status` without
    // first proving the field exists; `null` there means never requested.
    judges: toRunJudgesDto(run!),
  });
});

// GET /v1/projects/:projectId/eval-runs/:runId/compare
// This run against a baseline. `?baseRunId=` names one explicitly; omitting it
// selects the nearest earlier COMPLETED run in the same suite.
//
// Baseline resolution is server-side: `listEvalSuiteRuns` has no cursor, so a
// client walk cannot be bounded-correct, and the policy belongs beside the
// backend's other baseline resolvers.
//
// This calls an ACTION rather than a query — the diff hydrates trace blobs
// from storage, which a Convex query cannot do. Same reason
// `getTestSuiteRunDiff` is an action.
evals.get("/projects/:projectId/eval-runs/:runId/compare", async (c) => {
  const projectId = c.req.param("projectId");
  const runId = c.req.param("runId");
  const baseRunId = c.req.query("baseRunId");
  // The backend's OWN argument name, not a synonym, so the wire, this route
  // and the Convex call all read the same. Trimmed here because the backend
  // refuses a blank-after-trim SHA with `EVAL_COMPARE_BASELINE_INVALID`, and
  // a caller that interpolated an unset CI variable (`--baseline-sha
  // "$SHA"`) deserves that answer without a round trip.
  const rawBaseCommitSha = c.req.query("baseCommitSha");
  const baseCommitSha =
    rawBaseCommitSha === undefined ? undefined : rawBaseCommitSha.trim();

  // Guarded HERE **in addition to** the backend's own guard, not instead of
  // it. The backend guards because the Convex action is reachable directly;
  // this route guards so an HTTP caller gets the usage error without paying
  // for a round trip. Neither is allowed to win silently — they answer the
  // same 400 with the same meaning.
  if (baseRunId !== undefined && baseCommitSha !== undefined) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Pass either baseRunId or baseCommitSha, not both.",
    );
  }
  if (baseCommitSha !== undefined && baseCommitSha === "") {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "baseCommitSha must not be blank.",
    );
  }
  // Forwarded, not dropped: the SDK client sends it, and a silently ignored
  // knob is worse than an absent one. Parsed defensively — the action clamps
  // the range, so this only has to refuse non-numbers.
  const rawPreviewChars = c.req.query("previewChars");
  const previewChars =
    rawPreviewChars === undefined ? undefined : Number(rawPreviewChars);
  if (previewChars !== undefined && !Number.isFinite(previewChars)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "previewChars must be a number",
    );
  }
  const convex = createConvexReadClient(await getConvexBearerForRequest(c));

  // Fetch the compare run FIRST so an unauthorized or cross-project caller
  // gets a 404 from the cheap read, before the action does any work.
  let run: RunDoc | null;
  try {
    run = await convex.query("testSuites:getTestSuiteRun" as any, { runId });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval run not found");
    }
    throw error;
  }
  requireProjectMatch(run, projectId, "Eval run");

  let result: unknown;
  try {
    result = await convex.action("testSuites:compareTestSuiteRuns" as any, {
      compareRunId: runId,
      ...(baseRunId ? { baseRunId } : {}),
      ...(baseCommitSha ? { baseCommitSha } : {}),
      ...(previewChars !== undefined ? { previewChars } : {}),
    });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval run not found");
    }
    // Translated rather than rethrown. The action refuses a malformed
    // baseline selection with a structured `ConvexError` code, and a raw
    // rethrow would land on the v1 error boundary as a 500 + INTERNAL_ERROR
    // with the backend's message dropped — reporting the caller's usage error
    // as our outage, and paging for it. The translator maps both baseline
    // codes to 400 and keeps the message; anything it does not recognize
    // still answers 500, which is the honest outcome for a code we do not
    // know about.
    throw translateConvexWriteError(error);
  }

  const envelope = (result ?? {}) as Record<string, unknown>;
  if (envelope.status === "baseline_not_found") {
    // 404 + a `details.reason`, following the CONCURRENT_RUN_LIMIT idiom.
    //
    // NOT 422: the pinned error-status fixture maps 422 to
    // FEATURE_NOT_SUPPORTED, and minting a new error code is a cross-repo
    // contract change this route does not get to make. The CLI keys on
    // `details.reason` and maps it to exit 3 (incomplete) — never exit 1,
    // which would report a regression nobody observed.
    return v1Error(
      c,
      "NOT_FOUND",
      baseRunId
        ? "The requested baseline run was not found, is not completed, or belongs to another suite."
        : baseCommitSha
          ? "No completed run in this suite was recorded against that commit SHA."
          : "No earlier completed run in this suite to compare against.",
      // A SHA that resolved to nothing is deliberately THIS, not one of the
      // two 400 baseline codes: exit 3 must keep meaning "we looked and
      // established nothing", distinct from "you asked for something
      // impossible". The requested SHA rides along so an archived CI log says
      // WHICH commit found no run.
      {
        reason: "BASELINE_NOT_FOUND",
        ...(baseRunId ? { baseRunId } : {}),
        ...(baseCommitSha ? { baseCommitSha } : {}),
      },
    );
  }

  const baselineSource = (envelope.baseline ?? {}) as Record<string, unknown>;
  const baseline: RunCompareBaseline = {
    // Falls back to what the REQUEST asked for, not to a literal. `baseline`
    // is an audit field — a caller reads it to learn HOW the baseline was
    // chosen — so publishing an explicitly named run as `previous_completed`
    // (which a deploy-order skew could cause) is worse than saying nothing.
    policy:
      baselineSource.policy === "commit_sha" ||
      (baselineSource.policy === undefined && Boolean(baseCommitSha))
        ? "commit_sha"
        : baselineSource.policy === "run" ||
            (baselineSource.policy === undefined && Boolean(baseRunId))
          ? "run"
          : baselineSource.policy === "previous_completed_same_environment"
            ? "previous_completed_same_environment"
            : "previous_completed",
    baseRunId: String(baselineSource.baseRunId ?? ""),
    // Echoed for `commit_sha` only. Read from the BACKEND's answer, falling
    // back to what the request asked for, so a mixed-version deployment that
    // resolved the SHA without echoing it still records which SHA was pinned
    // — the pinned contract requires a gate to record the source SHA, and an
    // audit trail that drops it on a version skew is not one.
    ...(baseCommitSha
      ? {
          baseCommitSha: String(
            baselineSource.baseCommitSha ?? baseCommitSha,
          ),
        }
      : {}),
    // `matchCount` is present ONLY when uniqueness could not be established;
    // absent means unambiguous. `matchCountTruncated` says the count is a
    // FLOOR rather than a total — including when it reads 1. They travel
    // together or not at all: publishing a truncated count without its flag
    // asserts a uniqueness nobody checked.
    ...(typeof baselineSource.matchCount === "number"
      ? { matchCount: baselineSource.matchCount }
      : {}),
    ...(typeof baselineSource.matchCount === "number" &&
    baselineSource.matchCountTruncated === true
      ? { matchCountTruncated: true }
      : {}),
  };

  return v1Resource(c, toRunCompareDto(envelope.diff, baseline));
});

// POST /v1/projects/:projectId/eval-runs/:runId/insights
// Request (or with force, regenerate) the run's insights — serverQuality
// behind the common envelope. SPENDS the org's model budget; 202 receipt,
// poll the detail's `insights` envelope rather than re-requesting. Same
// Convex mutation the in-app button uses, so role/limit/billing checks are
// identical.
evals.post("/projects/:projectId/eval-runs/:runId/insights", async (c) => {
  const projectId = c.req.param("projectId");
  const runId = c.req.param("runId");
  const convex = createConvexReadClient(await getConvexBearerForRequest(c));

  let run: RunDoc | null;
  try {
    run = await convex.query("testSuites:getTestSuiteRun" as any, { runId });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval run not found");
    }
    throw error;
  }
  requireProjectMatch(run, projectId, "Eval run");

  // This endpoint SPENDS, so the body is validated rather than coerced. A
  // bodyless POST is the common case and stays valid; malformed JSON is a 400
  // rather than a silently-empty body that bills anyway, and `force` must be
  // a real boolean — `{"force":"false"}` is a truthy string, and treating it
  // as consent would charge for a regeneration nobody asked for.
  const raw = await c.req.text();
  // Only an ACTUALLY empty body is bodyless. Whitespace is malformed JSON,
  // and a literal `null` is a value the schema should reject — treating
  // either as "no body" would bill for a request nobody wrote.
  let body: unknown = {};
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Request body must be valid JSON.",
      );
    }
  }
  const force = parseWithSchema(
    z.object({ force: z.boolean().optional() }).strict(),
    body,
  ).force;

  try {
    await convex.mutation("serverQuality:requestServerQuality" as any, {
      suiteRunId: runId,
      ...(force === true ? { force: true } : {}),
    });
  } catch (error) {
    throw translateConvexError(error, { resource: "Eval run insights" });
  }
  return v1Resource(c, { runId, projectId, status: "pending" }, 202);
});

// POST /v1/projects/:projectId/eval-runs/:runId/judge
// Request (or with force, re-request) LLM-as-judge grading of a finished run.
// SPENDS the org's model budget; 202 receipt, then poll the run detail's
// `judges.goalCompletion` rather than re-requesting. Same Convex mutation the
// in-app "Run judge" button uses, so role/limit/billing checks are identical.
evals.post("/projects/:projectId/eval-runs/:runId/judge", async (c) => {
  const projectId = c.req.param("projectId");
  const runId = c.req.param("runId");
  const convex = createConvexReadClient(await getConvexBearerForRequest(c));

  let run: RunDoc | null;
  try {
    run = await convex.query("testSuites:getTestSuiteRun" as any, { runId });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval run not found");
    }
    throw error;
  }
  requireProjectMatch(run, projectId, "Eval run");

  // Like the insights endpoint: this SPENDS, so the body is VALIDATED rather
  // than coerced. A bodyless POST is the common case and stays valid; anything
  // else must parse and typecheck, because `{"force":"false"}` is a truthy
  // string and charging for a regeneration nobody asked for is the failure.
  const raw = await c.req.text();
  let body: unknown = {};
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Request body must be valid JSON.",
      );
    }
  }
  const parsed = parseWithSchema(requestRunJudgeSchema, body);

  // The per-run override envelope. Sent ONLY when the caller asked for one:
  // `requestGoalCompletion` clears any previously persisted override when the
  // arg is absent, which is the semantic we want — re-grading without
  // re-stating an override returns to suite-config grading on its own.
  const override: Record<string, unknown> = {};
  if (parsed.enable !== undefined) override.enabled = parsed.enable;
  if (parsed.model !== undefined) override.judgeModel = parsed.model;
  if (parsed.threshold !== undefined) override.threshold = parsed.threshold;

  try {
    await convex.mutation("goalCompletion:requestGoalCompletion" as any, {
      suiteRunId: runId,
      ...(parsed.force === true ? { force: true } : {}),
      ...(Object.keys(override).length > 0 ? { runOverride: override } : {}),
    });
  } catch (error) {
    throw translateConvexError(error, { resource: "Eval run judge" });
  }
  return v1Resource(c, { runId, projectId, status: "pending" }, 202);
});

// POST /v1/projects/:projectId/eval-runs/:runId/cancel
// Cancel an in-flight run. Reuses the existing `cancelTestSuiteRun` mutation
// (marks the run + its pending/running iterations cancelled); the runner polls
// run status every ~2s and aborts in-flight requests on its own. Idempotent on
// an already-cancelled run; 409 on a run that already finished.
evals.post("/projects/:projectId/eval-runs/:runId/cancel", async (c) => {
  const projectId = c.req.param("projectId");
  const runId = c.req.param("runId");
  const token = await getConvexBearerForRequest(c);
  const readClient = createConvexReadClient(token);

  let run: RunDoc | null;
  try {
    run = await readClient.query("testSuites:getTestSuiteRun" as any, {
      runId,
    });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval run not found");
    }
    throw error;
  }
  requireProjectMatch(run, projectId, "Eval run");

  const status = String(run!.status);
  // Already cancelled → no-op success (safe to retry a cancel).
  if (status === "cancelled") {
    return v1Resource(c, toRunDto(run!));
  }
  // Completed/failed runs can't be cancelled — surface a clear 409.
  if (TERMINAL_RUN_STATUSES.has(status)) {
    throw new WebRouteError(
      409,
      ErrorCode.VALIDATION_ERROR,
      `Cannot cancel a run that already ${status}`,
    );
  }

  const { convexClient } = createConvexClients(token);
  try {
    await convexClient.mutation("testSuites:cancelTestSuiteRun" as any, {
      runId,
    });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval run not found");
    }
    throw error;
  }

  // Re-read so the response reflects the cancelled terminal state.
  const updated = await readClient
    .query("testSuites:getTestSuiteRun" as any, { runId })
    .catch(() => null);
  return v1Resource(c, toRunDto((updated ?? run)!));
});

// ── Gate waivers ────────────────────────────────────────────────────────────
//
// An audited, time-boxed override of a run's release gate. Three routes, and
// the shape of each is decided by one rule from the Lane E charter: "no silent
// or permanent waiver."
//
// NOTHING HERE TOUCHES `run.result`. The run keeps its honest verdict and the
// waiver is a separate record, because two independent computations read that
// verdict — the backend derives a GitHub Check Run conclusion from the
// persisted run, and the CLI recomputes its own gate client-side from these
// same public GETs. Flipping the persisted result would green both with no
// trace of why, which is the definition of a silent waiver.
//
// AUTHORIZATION IS THE CONVEX MUTATION'S, not these handlers'. There is no
// tier check in this file on purpose: a second copy of the rule here would be
// a second thing to keep correct, and the one that matters is the one that
// runs closest to the data.

/**
 * Body for `POST …/eval-runs/:runId/gate-waivers`.
 *
 * STRICT, like every other v1 write body: a non-strict object silently strips
 * unknown keys and answers 200 for a request that did something other than
 * what the caller wrote — a known bug class in this router, and a bad one on a
 * route whose whole job is to be an auditable record.
 *
 * Deliberately NOT semantically validated beyond the types. A blank reason, a
 * 501-character one, an expiry in the past, an expiry a year out — all five are
 * refusals the platform raises with `gate_waiver_*` codes and customer-facing
 * copy it wrote, and a zod rule firing first would replace that copy with a
 * generic validation error on exactly the boundary cases where the specific
 * message is the useful part. Type errors are still ours: `expiresAt` must be
 * a finite number before it can mean an instant at all.
 */
const gateWaiverCreateSchema = z.strictObject({
  reason: z.string(),
  expiresAt: z.number().finite(),
});

/** The waiver DTO, projected field by field. */
function toGateWaiverDto(waiver: Record<string, any> | null | undefined) {
  if (!waiver) return null;
  return {
    id: String(waiver.id),
    suiteId: String(waiver.suiteId),
    runId: waiver.runId ? String(waiver.runId) : null,
    reason: String(waiver.reason ?? ""),
    expiresAt: waiver.expiresAt,
    createdAt: waiver.createdAt,
    createdBy: String(waiver.createdBy ?? ""),
    // `null`, never absent: a deleted user must not make a waiver look
    // authorless, and a caller reading "who waived this" needs to be able to
    // tell "we could not resolve them" from "the field is missing".
    createdByEmail:
      typeof waiver.createdByEmail === "string" ? waiver.createdByEmail : null,
    revokedAt: typeof waiver.revokedAt === "number" ? waiver.revokedAt : null,
    revokedBy: waiver.revokedBy ? String(waiver.revokedBy) : null,
    active: waiver.active === true,
    policySnapshot:
      waiver.policySnapshot &&
      typeof waiver.policySnapshot.minimumPassRate === "number"
        ? { minimumPassRate: waiver.policySnapshot.minimumPassRate }
        : null,
  };
}

/** The shared `{ status, republishedChecks, waiver }` write envelope. */
function toGateWaiverWriteDto(result: Record<string, any>) {
  return {
    status: String(result.status),
    republishedChecks:
      typeof result.republishedChecks === "number"
        ? result.republishedChecks
        : 0,
    waiver: toGateWaiverDto(result.waiver),
  };
}

/**
 * `notFoundMessage` names BOTH addressable things on purpose. The platform
 * deliberately answers a missing waiver with the same string as a missing run,
 * so these endpoints cannot become an existence oracle over waiver ids —
 * naming only one of them here would undo that by telling a caller which of
 * the two they got wrong.
 */
const GATE_WAIVER_TRANSLATE_OPTIONS = {
  resource: "Gate waiver",
  notFoundMessage: "Eval run or gate waiver not found",
  fallbackMessage: "Gate waiver rejected by the platform",
} as const;

// POST /v1/projects/:projectId/eval-runs/:runId/gate-waivers
// Grant a waiver. 201 on a new one; 409 when one is already in force.
evals.post("/projects/:projectId/eval-runs/:runId/gate-waivers", async (c) => {
  const projectId = c.req.param("projectId");
  const runId = c.req.param("runId");
  const body = parseWithSchema(
    gateWaiverCreateSchema,
    await readJsonObjectBody(c),
  );
  const token = await getConvexBearerForRequest(c);
  const readClient = createConvexReadClient(token);

  let run: RunDoc | null;
  try {
    run = await readClient.query("testSuites:getTestSuiteRun" as any, {
      runId,
    });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval run not found");
    }
    throw error;
  }
  requireProjectMatch(run, projectId, "Eval run");

  let result: Record<string, any>;
  try {
    result = await createConvexClients(token).convexClient.mutation(
      "gateWaivers:createGateWaiver" as any,
      { runId, reason: body.reason, expiresAt: body.expiresAt },
    );
  } catch (error) {
    throw translateConvexError(error, GATE_WAIVER_TRANSLATE_OPTIONS);
  }

  const dto = toGateWaiverWriteDto(result);
  // A CONFLICT, not a failure — the platform reports the EXISTING waiver
  // rather than granting a second one, because two active waivers over one run
  // would make "which reason is on the check" a race. 409 so a caller can tell
  // "yours was recorded" from "someone else's already was", and the body
  // carries the one in force so they can read whose it is.
  if (dto.status === "conflict") {
    return v1Resource(c, dto, 409);
  }
  return v1Resource(c, dto, 201);
});

// GET /v1/projects/:projectId/eval-runs/:runId/gate-waivers
// The waiver in force over this run, or null.
//
// `run.view`, not the manage tier: a waiver only its grantors can see is not a
// visible waiver, and visibility is half of what the charter asks for.
//
// `eval gate` does NOT call this. The run projection already carries
// `gateWaiver`, so the gating path folds a waiver in without a second round
// trip; this is the explicit read, for asking the question on its own.
evals.get("/projects/:projectId/eval-runs/:runId/gate-waivers", async (c) => {
  const projectId = c.req.param("projectId");
  const runId = c.req.param("runId");
  const convex = createConvexReadClient(await getConvexBearerForRequest(c));

  let run: RunDoc | null;
  try {
    run = await convex.query("testSuites:getTestSuiteRun" as any, { runId });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval run not found");
    }
    throw error;
  }
  requireProjectMatch(run, projectId, "Eval run");

  let waiver: Record<string, any> | null;
  try {
    waiver = await convex.query("gateWaivers:getActiveWaiverForRun" as any, {
      runId,
    });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval run not found");
    }
    // A tier denial here still has to keep its 403 rather than becoming a 500,
    // and the write translator is the only thing that knows how to read the
    // backend's `kind: 'forbidden'` shape. Nothing is written on this path;
    // the name is about which error vocabulary it speaks, not about the verb.
    throw translateConvexError(error, GATE_WAIVER_TRANSLATE_OPTIONS);
  }

  return v1Resource(c, { waiver: toGateWaiverDto(waiver) });
});

// DELETE /v1/projects/:projectId/eval-runs/:runId/gate-waivers/:waiverId
// Revoke a waiver, putting the gate back.
//
// IDEMPOTENT and 200 either way: `already_revoked` is the SUCCESS answer for a
// second call, and it reports the original revocation rather than restamping
// it — turning that into an error would push callers toward a retry loop that
// can only ever overwrite the record of who actually ended the waiver.
evals.delete(
  "/projects/:projectId/eval-runs/:runId/gate-waivers/:waiverId",
  async (c) => {
    const projectId = c.req.param("projectId");
    const runId = c.req.param("runId");
    const waiverId = c.req.param("waiverId");
    const token = await getConvexBearerForRequest(c);
    const readClient = createConvexReadClient(token);

    let run: RunDoc | null;
    try {
      run = await readClient.query("testSuites:getTestSuiteRun" as any, {
        runId,
      });
    } catch (error) {
      if (isConvexNotVisibleError(error)) {
        throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval run not found");
      }
      throw error;
    }
    requireProjectMatch(run, projectId, "Eval run");

    // A PRE-WRITE consistency check, and only where it can be decided.
    //
    // The path names a run and a waiver, but the mutation authorizes against
    // the WAIVER's suite — the run is scope context. So when the run's own
    // active waiver is known and is a DIFFERENT one, the caller has addressed
    // this waiver through the wrong run and the answer is a refusal.
    //
    // Deliberately before the write. The obvious shape — revoke, then notice
    // the mismatch, then answer 404 — performs the destructive act it is
    // refusing and reports it as not-found, which is worse than not checking
    // at all.
    //
    // It is a partial check and that is stated rather than hidden: when the
    // run carries no active waiver, the named one may be an expired or already
    // revoked waiver of THIS run (both legitimate to revoke — the audit trail
    // distinguishes "this was wrong" from "this ran out") or one belonging
    // elsewhere, and nothing readable here separates the two. That case goes
    // to the mutation, which is the component that owns the decision.
    const activeWaiverId = run?.gateWaiver?.id
      ? String(run.gateWaiver.id)
      : null;
    if (activeWaiverId !== null && activeWaiverId !== waiverId) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "Gate waiver not found for this run",
      );
    }

    let result: Record<string, any>;
    try {
      result = await createConvexClients(token).convexClient.mutation(
        "gateWaivers:revokeGateWaiver" as any,
        { waiverId },
      );
    } catch (error) {
      throw translateConvexError(error, GATE_WAIVER_TRANSLATE_OPTIONS);
    }

    return v1Resource(c, toGateWaiverWriteDto(result));
  },
);

// GET /v1/projects/:projectId/eval-runs/:runId/decision-summary?cursor=&limit=
//
// THE FIRST THING TO READ ABOUT A FINISHED RUN. One versioned object: the
// verdict, the population its counts are in, the run's own authoritative
// `EvalVerdictDecision` when it has one, and one page of per-trial diagnostics
// with the user-value chain, the first failed stage, the failure category and a
// typed pointer at the evidence.
//
// ADDITIVE. Every existing run/iteration field is untouched — this composes the
// same two reads a caller would otherwise make by hand, and the composing is
// the point: doing it in three clients produced three readings of one run.
//
// The verdict is COPIED from the run, never recomputed here. Under policy v2
// `verdictSummary` is the only authority for the verdict, the rates, the
// validity phase and the per-case aggregation; the iterations below are
// evidence UNDER that decision and are never counted as cases.
evals.get("/projects/:projectId/eval-runs/:runId/decision-summary", async (c) => {
  const projectId = c.req.param("projectId");
  const runId = c.req.param("runId");
  const limit = parseDecisionSummaryLimit(c.req.query("limit"));
  // `null`, not `undefined`, and the difference is the completeness claim: a
  // request that carried a cursor has already skipped rows, so whatever it gets
  // back cannot be the run's complete failure list however short it is.
  const cursor = c.req.query("cursor") ?? null;
  const convex = createConvexReadClient(await getConvexBearerForRequest(c));

  let run: RunDoc | null;
  let page: { page: IterationDoc[]; isDone: boolean; continueCursor: string };
  try {
    run = await convex.query("testSuites:getTestSuiteRun" as any, { runId });
    requireProjectMatch(run, projectId, "Eval run");
    page = await convex.query("testSuites:listTestSuiteRunIterations" as any, {
      runId,
      paginationOpts: { numItems: limit, cursor },
    });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval run not found");
    }
    throw error;
  }

  const complete = decisionSummaryPageIsComplete({
    requestCursor: cursor,
    isDone: page.isDone,
  });
  return v1Resource(
    c,
    buildEvalRunDecisionSummaryResponse({
      projectId,
      // The PUBLIC projections, not the documents: `toRunDto` has already
      // refused a verdict decision that does not validate and `toIterationDto`
      // has already quarantined an unverifiable stage chain. Assembling from
      // the raw rows would route around both.
      run: toRunDto(run!),
      iterations: (page.page ?? []).map(toIterationDto),
      page: {
        complete,
        ...(page.isDone ? {} : { nextCursor: page.continueCursor }),
      },
    }),
  );
});

// GET /v1/projects/:projectId/eval-runs/:runId/iterations?cursor=&limit=
// Per-iteration results: tool calls, structured token usage, latency.
evals.get("/projects/:projectId/eval-runs/:runId/iterations", async (c) => {
  const projectId = c.req.param("projectId");
  const runId = c.req.param("runId");
  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? 50) || 50, 1),
    200,
  );
  const cursor = c.req.query("cursor") ?? null;
  const convex = createConvexReadClient(await getConvexBearerForRequest(c));

  let run: RunDoc | null;
  let page: { page: IterationDoc[]; isDone: boolean; continueCursor: string };
  try {
    run = await convex.query("testSuites:getTestSuiteRun" as any, { runId });
    requireProjectMatch(run, projectId, "Eval run");
    page = await convex.query("testSuites:listTestSuiteRunIterations" as any, {
      runId,
      paginationOpts: { numItems: limit, cursor },
    });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval run not found");
    }
    throw error;
  }
  return v1PageJson(
    c,
    (page.page ?? []).map(toIterationDto),
    page.isDone ? undefined : page.continueCursor,
  );
});

// GET /v1/projects/:projectId/eval-runs/:runId/iterations/:iterationId/trace
// Full trace envelope (messages + spans) for one iteration.
evals.get(
  "/projects/:projectId/eval-runs/:runId/iterations/:iterationId/trace",
  async (c) => {
    const projectId = c.req.param("projectId");
    const runId = c.req.param("runId");
    const iterationId = c.req.param("iterationId");
    // Held rather than inlined: the same bearer authorizes the read AND names
    // the human in the audit row below (see services/eval-trace-access-audit).
    const convexAuthToken = await getConvexBearerForRequest(c);
    const convex = createConvexReadClient(convexAuthToken);

    let trace: unknown;
    try {
      const [run, iteration] = await Promise.all([
        convex.query("testSuites:getTestSuiteRun" as any, { runId }),
        convex.query("testSuites:getTestIteration" as any, { iterationId }),
      ]);
      requireProjectMatch(run, projectId, "Eval run");
      if (
        !iteration ||
        String((iteration as IterationDoc).suiteRunId ?? "") !== runId
      ) {
        throw new WebRouteError(
          404,
          ErrorCode.NOT_FOUND,
          "Eval iteration not found",
        );
      }
      trace = await convex.action("testSuites:getTestIterationBlob" as any, {
        iterationId,
      });
    } catch (error) {
      if (isConvexNotVisibleError(error)) {
        throw new WebRouteError(
          404,
          ErrorCode.NOT_FOUND,
          "Eval iteration not found",
        );
      }
      throw error;
    }
    if (trace === null || trace === undefined) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "Trace is not available for this iteration",
        { reason: "TRACE_NOT_AVAILABLE" },
      );
    }
    // AFTER the read resolves and after the 404s, so a row means a transcript
    // actually left the product.
    //
    // DETACHED, not awaited: bookkeeping must not sit on the critical path of
    // a read that already succeeded, or a stalled audit backend shows up as a
    // slow `/trace`. Safe to float because `recordEvalIterationRead` swallows
    // its own failures — there is no rejection to go unhandled — and it bounds
    // its own request.
    void recordEvalIterationRead({
      convexAuthToken,
      iterationId,
      mode: "trace",
      traceBytes: measureTraceBytes(trace),
    });
    return v1Resource(c, trace);
  },
);

// GET /v1/projects/:projectId/eval-runs/:runId/iterations/:iterationId/steps
// One row per authored step, in order, with status + reason + evidence — the
// public mirror of the fail-fast step engine. Verdicts come from the persisted
// `metadata.stepResults`; evidence (screenshots/video/widget tool calls) from
// the resolved trace envelope. Unlike `/trace`, a missing trace is NOT a 404:
// step verdicts still return, just without evidence.
evals.get(
  "/projects/:projectId/eval-runs/:runId/iterations/:iterationId/steps",
  async (c) => {
    const projectId = c.req.param("projectId");
    const runId = c.req.param("runId");
    const iterationId = c.req.param("iterationId");
    const convexAuthToken = await getConvexBearerForRequest(c);
    const convex = createConvexReadClient(convexAuthToken);

    let iteration: IterationDoc | null;
    try {
      const [run, iter] = await Promise.all([
        convex.query("testSuites:getTestSuiteRun" as any, { runId }),
        convex.query("testSuites:getTestIteration" as any, { iterationId }),
      ]);
      requireProjectMatch(run, projectId, "Eval run");
      iteration = iter as IterationDoc | null;
      if (!iteration || String(iteration.suiteRunId ?? "") !== runId) {
        throw new WebRouteError(
          404,
          ErrorCode.NOT_FOUND,
          "Eval iteration not found",
        );
      }
    } catch (error) {
      if (isConvexNotVisibleError(error)) {
        throw new WebRouteError(
          404,
          ErrorCode.NOT_FOUND,
          "Eval iteration not found",
        );
      }
      throw error;
    }

    const snapshot = (iteration.testCaseSnapshot ?? {}) as Record<string, any>;
    // Reconstruct legacy snapshots (promptTurns / query / probeConfig with no
    // persisted steps) via the shared helper so the Steps view isn't empty for
    // pre-migration iterations. internalCaseToSteps no-ops when steps exist.
    const steps: TestStep[] = internalCaseToSteps(snapshot as CaseDoc);

    // Evidence is best-effort: the trace blob may be absent (still-running or
    // never-persisted iteration). Verdicts from metadata still return.
    let envelope: Record<string, unknown> | undefined;
    try {
      const trace = await convex.action(
        "testSuites:getTestIterationBlob" as any,
        { iterationId },
      );
      if (trace && typeof trace === "object") {
        envelope = trace as Record<string, unknown>;
      }
    } catch (error) {
      if (!isConvexNotVisibleError(error)) throw error;
    }

    const assembled = assembleStepResults(
      steps,
      iteration.metadata as
        | { stepResults?: any[]; skippedSteps?: any[] }
        | undefined,
      envelope as Parameters<typeof assembleStepResults>[2],
    );
    // Unlike `/trace`, a missing envelope is not a 404 here — verdicts still
    // return — so `traceBytes` is present only when evidence was actually
    // resolved, and its absence is how the row says "verdicts only".
    // Detached for the same reason as the `/trace` site above.
    void recordEvalIterationRead({
      convexAuthToken,
      iterationId,
      mode: "steps",
      stepCount: assembled.length,
      traceBytes: measureTraceBytes(envelope),
    });
    return v1PageJson(c, assembled.map(toStepResultDto));
  },
);

// GET /v1/projects/:projectId/eval-suites/:suiteId/runs?limit=
// Recent runs for a suite, newest first.
evals.get("/projects/:projectId/eval-suites/:suiteId/runs", async (c) => {
  const projectId = c.req.param("projectId");
  const suiteId = c.req.param("suiteId");
  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? 25) || 25, 1),
    100,
  );
  const convex = createConvexReadClient(await getConvexBearerForRequest(c));

  let runs: RunDoc[];
  let suite: { projectId?: unknown } | null;
  try {
    suite = await convex.query("testSuites:getTestSuite" as any, { suiteId });
    requireProjectMatch(suite, projectId, "Eval suite");
    runs = await convex.query("testSuites:listTestSuiteRuns" as any, {
      suiteId,
      limit,
    });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval suite not found");
    }
    throw error;
  }
  return v1PageJson(c, (runs ?? []).map(toRunDto));
});

// ── Eval suite/case editing routes ───────────────────────────────────

/** Read a suite (project-scoped) + its execution config for the detail DTO. */
async function readSuiteDetail(
  convexAuthToken: string,
  projectId: string,
  suiteId: string,
) {
  const convex = createConvexReadClient(convexAuthToken);
  let suite: SuiteDoc | null;
  try {
    suite = await convex.query("testSuites:getTestSuite" as any, { suiteId });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval suite not found");
    }
    throw error;
  }
  requireProjectMatch(suite, projectId, "Eval suite");
  let execConfig: any = null;
  try {
    execConfig = await convex.query("hostConfigsV2:getSuiteConfig" as any, {
      suiteId,
    });
  } catch {
    execConfig = null;
  }
  // The suite row stores the computer-image PIN as an id only. Resolve the
  // name beside it so a caller can echo back what it set — that is what the
  // picker shows and what a person recognizes. Best-effort: a failed lookup
  // (a deleted image, a caller who can read the suite but not the image list)
  // reports the id with a null name rather than failing the whole read.
  let computerEnvironmentName: string | null = null;
  const pinnedImageId = suite!.environment?.computerEnvironmentId;
  if (pinnedImageId) {
    try {
      const image: any = await convex.query(
        "computerEnvironments:getEnvironment" as any,
        { environmentId: String(pinnedImageId) },
      );
      if (typeof image?.name === "string") computerEnvironmentName = image.name;
    } catch {
      computerEnvironmentName = null;
    }
  }
  return toSuiteDetailDto(suite!, execConfig, { computerEnvironmentName });
}

/** Default execution models for a new case: the suite's configured model. */
async function defaultCaseModels(
  convex: ReturnType<typeof createConvexReadClient>,
  suiteId: string,
): Promise<Array<{ model: string; provider: string }>> {
  try {
    const cfg: any = await convex.query("hostConfigsV2:getSuiteConfig" as any, {
      suiteId,
    });
    // Trim BEFORE the emptiness test, not after: a whitespace-only config id is
    // no id. It cannot currently reach the return (`providerForModelId` also
    // rejects blanks, so the provider lookup fails first and this falls through
    // to "no default"), but that makes the guard here correct only by way of
    // another function's behaviour. Testing the value actually returned keeps it
    // true locally.
    const modelId =
      typeof cfg?.modelId === "string" ? (cfg.modelId as string).trim() : "";
    if (modelId) {
      // Suite configs store bare ids (e.g. "claude-sonnet-4-5"); resolve the
      // provider via the catalog so the new case isn't persisted model-less.
      //
      // ATTRIBUTED, not total: pinning a case to a provider is a durable write,
      // and the classifier's `ollama` catch-all is a guess. A suite default we
      // cannot place (an org BYOK id, a catalog-only id) falls through to "no
      // default", which is not a failure — it is the case inheriting the suite
      // model at run time, where the runner can see keys this route cannot.
      const provider = attributedProvider(modelId);
      if (provider) {
        return [{ model: modelId, provider }];
      }
    }
  } catch {
    // No resolvable suite model — the case inherits the suite default at run.
  }
  return [];
}

/**
 * Resolve project-server selectors (names OR IDs) to Convex server IDs against
 * the project's server catalog — no live connection. Used by generate so the
 * public `servers` override accepts names even on direct API calls (batch
 * authorization only accepts IDs).
 */
async function resolveProjectServerSelectors(
  convex: ReturnType<typeof createConvexReadClient>,
  projectId: string,
  selectors: string[],
): Promise<{ serverIds: string[]; serverNames: string[] }> {
  let servers: any[];
  try {
    servers = await convex.query("servers:getProjectServers" as any, {
      projectId,
    });
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  const byId = new Map<string, any>();
  const byName = new Map<string, any[]>();
  for (const s of servers ?? []) {
    byId.set(String(s._id), s);
    const key = String(s.name ?? "").toLocaleLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), s]);
  }
  const serverIds: string[] = [];
  const serverNames: string[] = [];
  for (const selector of selectors) {
    const trimmed = selector.trim();
    let match = byId.get(trimmed);
    if (!match) {
      const named = byName.get(trimmed.toLocaleLowerCase()) ?? [];
      if (named.length > 1) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          `Server name "${trimmed}" is ambiguous; use the server id.`,
        );
      }
      match = named[0];
    }
    if (!match) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        `Server "${trimmed}" not found in this project.`,
      );
    }
    serverIds.push(String(match._id));
    serverNames.push(String(match.name ?? ""));
  }
  return { serverIds, serverNames };
}

// GET /v1/projects/:projectId/eval-suites/:suiteId — full suite settings.
evals.get("/projects/:projectId/eval-suites/:suiteId", async (c) => {
  const projectId = c.req.param("projectId");
  const suiteId = c.req.param("suiteId");
  const token = await getConvexBearerForRequest(c);
  return v1Resource(c, await readSuiteDetail(token, projectId, suiteId));
});

// PATCH /v1/projects/:projectId/eval-suites/:suiteId — edit suite settings.
evals.patch("/projects/:projectId/eval-suites/:suiteId", async (c) => {
  const projectId = c.req.param("projectId");
  const suiteId = c.req.param("suiteId");
  const body = parseWithSchema(
    updateSuiteSchema,
    await readJsonObjectBody(c),
  );
  const token = await getConvexBearerForRequest(c);
  const { convexClient } = createConvexClients(token);

  // Read first: project-scope guard + source for host/server-subset resolution.
  const readClient = createConvexReadClient(token);
  let suite: SuiteDoc | null;
  try {
    suite = await readClient.query("testSuites:getTestSuite" as any, {
      suiteId,
    });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval suite not found");
    }
    throw error;
  }
  requireProjectMatch(suite, projectId, "Eval suite");

  // Precheck the one environment rejection a caller is likely to hit, before
  // any of the edits below commit — this handler applies several mutations in
  // sequence, so a late failure would otherwise 400 with the earlier edits
  // already persisted.
  if (body.environmentIds !== undefined) {
    assertScheduleSurvivesEnvironmentChange(suite!, body.environmentIds ?? []);
  }

  const updateArgs: Record<string, unknown> = { suiteId };
  if (body.name !== undefined) updateArgs.name = body.name;
  if (body.description !== undefined) updateArgs.description = body.description;
  if (body.environment !== undefined) {
    // `updateTestSuite` REPLACES the environment envelope wholesale, so this
    // has to be a merge over the suite's current one. Sending `{ servers }`
    // alone — which is what this did — silently dropped the server bindings
    // and the computer-image pin on any edit that touched servers. The suite
    // settings sheet spreads the current environment for exactly this reason.
    const current = suite!.environment ?? {};
    const environment: Record<string, unknown> = {
      servers: body.environment.servers ?? current.servers ?? [],
      ...(current.serverBindings
        ? { serverBindings: current.serverBindings }
        : {}),
    };
    if (body.environment.computerEnvironment === undefined) {
      // Untouched: carry the existing pin through the rebuild.
      if (current.computerEnvironmentId) {
        environment.computerEnvironmentId = current.computerEnvironmentId;
      }
    } else if (body.environment.computerEnvironment !== null) {
      // Resolved BEFORE the write so an unknown image is a clean 404 rather
      // than a rejected mutation with the rest of the PATCH already applied.
      const image = await resolveComputerEnvironment(
        readClient,
        projectId,
        body.environment.computerEnvironment,
      );
      environment.computerEnvironmentId = image.id;
    }
    // `null` falls through with the key absent, which is how the platform
    // spells "no pin" — the environment validator has no null for it.
    updateArgs.environment = environment;
    // Only a server-list change needs the host config refreshed; a pin edit
    // does not touch which servers a host sees.
    if (body.environment.servers !== undefined) {
      updateArgs.refreshHostConfigFromEnvironment = true;
    }
  }
  if (body.settings) {
    const s = body.settings;
    if (s.minimumAccuracy !== undefined)
      updateArgs.defaultPassCriteria = { minimumPassRate: s.minimumAccuracy };
    // Forwarded verbatim, `null` INCLUDED: the platform reads null as "clear"
    // and `undefined` as "leave alone", so collapsing null to undefined here
    // would turn every attempt to remove the floor into a silent no-op.
    if (s.minimumIterations !== undefined)
      updateArgs.minIterations = s.minimumIterations;
    // PATCH is merge semantics: updateTestSuite replaces these objects
    // wholesale, so a partial public field (e.g. only matchOptions.arguments,
    // or only judge.model) must be layered onto the suite's CURRENT values —
    // otherwise unmentioned fields (toolCallOrder, judge.enabled, threshold…)
    // are dropped and silently reset on read.
    if (s.matchOptions !== undefined)
      updateArgs.defaultMatchOptions =
        s.matchOptions === null
          ? null
          : mergeMatchOptions(suite!.defaultMatchOptions, s.matchOptions);
    if (s.checks !== undefined) updateArgs.defaultPredicates = s.checks;
    if (s.judge !== undefined) {
      const goalCompletion: Record<string, unknown> = {
        ...(suite!.judgeConfig?.goalCompletion ?? {}),
      };
      if (s.judge.enabled !== undefined)
        goalCompletion.enabled = s.judge.enabled;
      if (s.judge.model !== undefined)
        goalCompletion.judgeModel = s.judge.model;
      if (s.judge.autoRun !== undefined)
        goalCompletion.autoRun = s.judge.autoRun;
      if (s.judge.threshold !== undefined)
        goalCompletion.threshold = s.judge.threshold;
      updateArgs.judgeConfig = { goalCompletion };
    }
  }
  // Only call updateTestSuite when there's something beyond the suiteId.
  if (Object.keys(updateArgs).length > 1) {
    try {
      await convexClient.mutation(
        "testSuites:updateTestSuite" as any,
        updateArgs,
      );
    } catch (error) {
      throw translateConvexWriteError(error);
    }
  }

  // Host attachments resolve their per-host server picks against the suite's
  // environment bindings — so apply them AFTER the environment update above and
  // re-read, letting one PATCH atomically add a server (environment.servers)
  // and scope a host to that newly-added server.
  if (body.hosts !== undefined) {
    const refreshed: SuiteDoc | null = updateArgs.environment
      ? await readClient.query("testSuites:getTestSuite" as any, { suiteId })
      : suite;
    try {
      await convexClient.mutation("testSuites:updateTestSuite" as any, {
        suiteId,
        hostAttachments: await resolveHostAttachments(
          convexClient,
          projectId,
          refreshed ?? suite!,
          body.hosts,
        ),
      });
    } catch (error) {
      throw translateConvexWriteError(error);
    }
  }

  // Execution config edits go through setSuiteConfig (preserves servers).
  if (body.executionConfig) {
    let current: any = null;
    try {
      current = await readClient.query("hostConfigsV2:getSuiteConfig" as any, {
        suiteId,
      });
    } catch {
      current = null;
    }
    if (!current) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Suite has no execution config to edit yet.",
      );
    }
    const input = hostConfigDtoToInput(current);
    if (body.executionConfig.model !== undefined)
      input.modelId = body.executionConfig.model;
    if (body.executionConfig.systemPrompt !== undefined)
      input.systemPrompt = body.executionConfig.systemPrompt;
    if (body.executionConfig.temperature !== undefined)
      input.temperature = body.executionConfig.temperature;
    try {
      await convexClient.mutation("hostConfigsV2:setSuiteConfig" as any, {
        suiteId,
        input,
      });
    } catch (error) {
      throw translateConvexWriteError(error);
    }
  }

  // Environment attachments go LAST. A non-empty list makes the suite
  // environment-based, and environment resolution then wins outright over every
  // legacy pointer this handler may have just edited — so applying it after
  // those edits lets one PATCH both refresh the rollback config AND switch the
  // suite onto environments, in that order. The mutation also enforces the
  // schedule-pin invariants (it refuses to strand an enabled schedule), which
  // surface here as 400s.
  if (body.environmentIds !== undefined) {
    try {
      await convexClient.mutation("testSuites:setSuiteEnvironments" as any, {
        suiteId,
        environmentIds: body.environmentIds,
      });
    } catch (error) {
      throw translateConvexWriteError(error);
    }
  }

  return v1Resource(c, await readSuiteDetail(token, projectId, suiteId));
});

// POST /v1/projects/:projectId/eval-suites/:suiteId/environments
//
// APPEND one environment to the suite's attachments, if it is not already
// there.
//
// Distinct from `PATCH /eval-suites/{id}` with `environmentIds`, which REPLACES
// the whole list. An append built on the replace door is a read-modify-write
// across two round trips, and a concurrent attach landing in between is
// silently DETACHED. The compose-and-run path attaches on every launch, which
// makes that race ordinary rather than theoretical, so the append happens
// inside one backend transaction instead.
//
// Idempotent: attaching an already-attached environment reports
// `attached: false` and changes nothing, which is what lets a retried launch
// converge instead of erroring.
evals.post(
  "/projects/:projectId/eval-suites/:suiteId/environments",
  async (c) => {
    const projectId = c.req.param("projectId");
    const suiteId = c.req.param("suiteId");
    // Strict over the caller's own body (no synthesized path params), matching
    // the `additionalProperties: false` the spec publishes for it.
    const body = parseWithSchema(
      z.object({ environmentId: z.string().min(1) }).strict(),
      await readJsonObjectBody(c)
    );
    const token = await getConvexBearerForRequest(c);
    // Scope check first: Convex enforces membership, and this makes a valid id
    // from another of the caller's projects read as NOT_FOUND rather than
    // leaking across the scope the path declares.
    await readSuiteInProject(token, projectId, suiteId);

    const { convexClient } = createConvexClients(token);
    let result: { attached?: boolean; environmentIds?: unknown };
    try {
      result = (await convexClient.mutation(
        "testSuites:attachEnvironment" as any,
        { suiteId, environmentId: body.environmentId }
      )) as { attached?: boolean; environmentIds?: unknown };
    } catch (error) {
      // Deploy skew: a backend without the atomic append. Named explicitly
      // rather than surfaced as a 500, because the caller has a real (if
      // racier) alternative in the replace door.
      const message = error instanceof Error ? error.message : String(error);
      if (/could not find public function/i.test(message)) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "This deployment cannot append a suite environment atomically yet. Set the full environment list instead (PATCH the suite with environmentIds).",
          { reason: "ATTACH_UNAVAILABLE" }
        );
      }
      throw translateConvexError(error, { resource: "Eval suite" });
    }
    return v1Resource(c, {
      suiteId,
      attached: result.attached === true,
      environmentIds: Array.isArray(result.environmentIds)
        ? result.environmentIds.map(String)
        : [],
    });
  }
);

// DELETE /v1/projects/:projectId/eval-suites/:suiteId
evals.delete("/projects/:projectId/eval-suites/:suiteId", async (c) => {
  const projectId = c.req.param("projectId");
  const suiteId = c.req.param("suiteId");
  const token = await getConvexBearerForRequest(c);
  const readClient = createConvexReadClient(token);
  let suite: SuiteDoc | null;
  try {
    suite = await readClient.query("testSuites:getTestSuite" as any, {
      suiteId,
    });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval suite not found");
    }
    throw error;
  }
  requireProjectMatch(suite, projectId, "Eval suite");
  const { convexClient } = createConvexClients(token);
  try {
    await convexClient.mutation("testSuites:deleteTestSuite" as any, {
      suiteId,
    });
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  return v1Resource(c, { id: suiteId, deleted: true });
});

// PATCH /v1/projects/:projectId/eval-suites/:suiteId/schedule
evals.patch("/projects/:projectId/eval-suites/:suiteId/schedule", async (c) => {
  const projectId = c.req.param("projectId");
  const suiteId = c.req.param("suiteId");
  const body = parseWithSchema(scheduleSchema, await readJsonObjectBody(c));
  const token = await getConvexBearerForRequest(c);
  const readClient = createConvexReadClient(token);
  let suite: SuiteDoc | null;
  try {
    suite = await readClient.query("testSuites:getTestSuite" as any, {
      suiteId,
    });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval suite not found");
    }
    throw error;
  }
  requireProjectMatch(suite, projectId, "Eval suite");
  // Enabling reuses the suite's saved interval when none is supplied (one-click
  // re-enable after a disable). Only require an interval when there's no saved
  // one to fall back to.
  if (
    body.enabled &&
    body.intervalMinutes === undefined &&
    suite?.schedule?.intervalMinutes === undefined
  ) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "intervalMinutes is required to enable scheduled runs (this suite has no saved interval).",
    );
  }
  // A scheduled run launches exactly ONE run, so an environment-based suite
  // pins one attached environment — resolved by the same authoritative rule the
  // run route uses (member, or auto-selected when the suite has exactly one).
  // Only on enable: `setSuiteSchedule` returns early on disable and would
  // silently drop a pin, so accepting one there would be a lie.
  let scheduleEnvironmentId: string | undefined;
  if (body.enabled) {
    scheduleEnvironmentId = await selectSuiteEnvironmentId({
      convexAuthToken: token,
      projectId,
      suite: suite!,
      requestedEnvironmentId: body.environmentId,
      hasServerOverride: false,
      serverField: "servers",
    });
  } else if (body.environmentId !== undefined) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "environmentId only applies when enabling a schedule. Disabling preserves the existing pin; send enabled: true with environmentId to repoint it.",
    );
  }

  const { convexClient } = createConvexClients(token);
  try {
    await convexClient.mutation("testSuites:setSuiteSchedule" as any, {
      suiteId,
      enabled: body.enabled,
      ...(body.intervalMinutes !== undefined
        ? { intervalMinutes: body.intervalMinutes }
        : {}),
      ...(scheduleEnvironmentId
        ? { environmentId: scheduleEnvironmentId }
        : {}),
    });
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  return v1Resource(c, await readSuiteDetail(token, projectId, suiteId));
});

// GET /v1/projects/:projectId/eval-suites/:suiteId/cases
evals.get("/projects/:projectId/eval-suites/:suiteId/cases", async (c) => {
  const projectId = c.req.param("projectId");
  const suiteId = c.req.param("suiteId");
  const convex = createConvexReadClient(await getConvexBearerForRequest(c));
  let suite: SuiteDoc | null;
  let cases: CaseDoc[];
  try {
    suite = await convex.query("testSuites:getTestSuite" as any, { suiteId });
    requireProjectMatch(suite, projectId, "Eval suite");
    cases = await convex.query("testSuites:listTestCases" as any, { suiteId });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval suite not found");
    }
    throw error;
  }
  return v1PageJson(c, (cases ?? []).map(toCaseDto));
});

/** Load a case and assert it belongs to the given suite + project. */
async function loadCaseInScope(
  convex: ReturnType<typeof createConvexReadClient>,
  projectId: string,
  suiteId: string,
  caseId: string,
): Promise<CaseDoc> {
  let testCase: CaseDoc | null;
  try {
    testCase = await convex.query("testSuites:getTestCase" as any, {
      testCaseId: caseId,
    });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval case not found");
    }
    throw error;
  }
  if (!testCase || String(testCase.testSuiteId ?? "") !== suiteId) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval case not found");
  }
  requireProjectMatch(testCase, projectId, "Eval case");
  return testCase;
}

// GET /v1/projects/:projectId/eval-suites/:suiteId/cases/:caseId
evals.get(
  "/projects/:projectId/eval-suites/:suiteId/cases/:caseId",
  async (c) => {
    const projectId = c.req.param("projectId");
    const suiteId = c.req.param("suiteId");
    const caseId = c.req.param("caseId");
    const convex = createConvexReadClient(await getConvexBearerForRequest(c));
    const testCase = await loadCaseInScope(convex, projectId, suiteId, caseId);
    return v1Resource(c, toCaseDto(testCase));
  },
);

// POST /v1/projects/:projectId/eval-suites/:suiteId/cases
evals.post("/projects/:projectId/eval-suites/:suiteId/cases", async (c) => {
  const projectId = c.req.param("projectId");
  const suiteId = c.req.param("suiteId");
  const body = parseWithSchema(createCaseSchema, await readJsonObjectBody(c));
  const title = assertCreatableCase(body);
  const token = await getConvexBearerForRequest(c);
  const readClient = createConvexReadClient(token);
  let suite: SuiteDoc | null;
  try {
    suite = await readClient.query("testSuites:getTestSuite" as any, {
      suiteId,
    });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval suite not found");
    }
    throw error;
  }
  requireProjectMatch(suite, projectId, "Eval suite");

  const defaultModels =
    body.models === undefined
      ? await defaultCaseModels(readClient, suiteId)
      : [];
  const args = buildCaseMutationArgs(body, { forCreate: true, defaultModels });
  const { convexClient } = createConvexClients(token);
  // A single create is a batch of one, deliberately: it is the same contract,
  // so it gets the same default duplicate policy, the same warnings, the same
  // override audit and the same identity handling. Two routes into two
  // mutations is how the single and bulk paths would drift.
  const [item] = withMintedCaseIds<EvalCaseBatchItem>([
    { ...args, title, changeSource: "manual" },
  ]);
  let result: Awaited<ReturnType<typeof createEvalCasesInBatches>>;
  try {
    result = await createEvalCasesInBatches(convexClient, {
      suiteId,
      cases: [item],
    });
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  const failure = result.failed[0];
  if (failure) throw caseBatchFailureToWebError(failure);
  const committed = result.committed[0];
  if (!committed) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Case create returned neither a committed case nor a failure.",
    );
  }
  const created = await loadCaseInScope(
    createConvexReadClient(token),
    projectId,
    suiteId,
    String(committed.testCaseId),
  );
  return v1Resource(c, toCaseDto(created), 201);
});

// POST /v1/projects/:projectId/eval-suites/:suiteId/cases/batch
//
// The bulk authoring surface: an agent converting a repo's test files, or an
// import, writes its cases in one call per chunk instead of one call per case.
// It is the SINGLE create repeated — same case body, same identity rules, same
// duplicate policy — so nothing here may grow a second meaning for a field the
// single route already defines.
evals.post(
  "/projects/:projectId/eval-suites/:suiteId/cases/batch",
  async (c) => {
    const projectId = c.req.param("projectId");
    const suiteId = c.req.param("suiteId");
    const body = parseWithSchema(
      createCasesBatchSchema,
      await readJsonObjectBody(c),
    );

    // Every case is checked before the suite is even loaded: a batch with one
    // unusable body is a caller mistake about the whole request, and reporting
    // it after 99 siblings were authored would leave the caller reconciling a
    // partial write it cannot retry cleanly.
    const titles = body.cases.map((testCase, index) =>
      assertCreatableCase(testCase, `cases[${index}]: `),
    );

    const token = await getConvexBearerForRequest(c);
    const readClient = createConvexReadClient(token);
    let suite: SuiteDoc | null;
    try {
      suite = await readClient.query("testSuites:getTestSuite" as any, {
        suiteId,
      });
    } catch (error) {
      if (isConvexNotVisibleError(error)) {
        throw new WebRouteError(
          404,
          ErrorCode.NOT_FOUND,
          "Eval suite not found",
        );
      }
      throw error;
    }
    requireProjectMatch(suite, projectId, "Eval suite");

    // Resolved at most ONCE for the whole batch, and only when some case
    // actually needs it — the single route's per-call lookup would otherwise
    // become 100 identical queries.
    const defaultModels = body.cases.some((tc) => tc.models === undefined)
      ? await defaultCaseModels(readClient, suiteId)
      : [];

    // A retry of an interrupted import must land on the same rows rather than
    // authoring the suite's cases twice. Discriminate by the caller's declared
    // id when there is one — it is stable across retries by construction — and
    // by position otherwise, which a verbatim retry also reproduces. Position
    // is an idempotency discriminator only; it never becomes an identity.
    const turnKey = readIdempotencyKey(c);
    const operationKey = turnKey
      ? deriveOperationIdempotencyKey(turnKey, "create_eval_cases", {
          projectId,
          suiteId,
        })
      : undefined;

    const items = withMintedCaseIds<EvalCaseBatchItem>(
      body.cases.map((testCase, index) => {
        const args = buildCaseMutationArgs(testCase, {
          forCreate: true,
          defaultModels,
        });
        return {
          ...args,
          title: titles[index],
          changeSource: "manual",
          ...(operationKey
            ? {
                idempotencyKey: deriveItemIdempotencyKey(
                  operationKey,
                  testCase.id ? `id:${testCase.id}` : `index:${index}`,
                ),
              }
            : {}),
        };
      }),
    );

    const { convexClient } = createConvexClients(token);
    let result: Awaited<ReturnType<typeof createEvalCasesInBatches>>;
    try {
      result = await createEvalCasesInBatches(convexClient, {
        suiteId,
        cases: items,
        ...(body.duplicatePolicy
          ? { duplicatePolicy: body.duplicatePolicy }
          : {}),
        ...(body.overrideReason
          ? { overrideReason: body.overrideReason }
          : {}),
      });
    } catch (error) {
      throw translateConvexWriteError(error);
    }

    // Committed entries are summaries, not full case DTOs. Reading back 100
    // cases to echo bodies the caller just sent is 100 queries for data it
    // already has; `id` is what it cannot know without asking, and `index` is
    // what lets it line each result up against its own list.
    return v1Resource(
      c,
      {
        created: result.committed.map((entry) => ({
          index: entry.index,
          id: String(entry.testCaseId),
          ...(entry.caseId ? { declaredId: entry.caseId } : {}),
          title: entry.title,
          // True when an idempotent retry landed on a case the first attempt
          // had already authored — nothing new was written.
          replayed: entry.replayed,
          ...(entry.warnings?.length ? { warnings: entry.warnings } : {}),
        })),
        // Per-item failures are DATA, not an error response: the siblings that
        // committed really did commit, and a 4xx for the whole call would tell
        // the caller to retry writes that already landed.
        failed: result.failed.map((entry) => ({
          index: entry.index,
          ...(entry.title ? { title: entry.title } : {}),
          ...(entry.caseId ? { declaredId: entry.caseId } : {}),
          code: entry.code,
          message: entry.message,
        })),
        // The policy audit: an unrecognized value coerces to `block`, and the
        // coercion is reported here rather than silently applied.
        duplicatePolicy: result.duplicatePolicy,
        ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      },
      201,
    );
  },
);

// PATCH /v1/projects/:projectId/eval-suites/:suiteId/cases/:caseId
evals.patch(
  "/projects/:projectId/eval-suites/:suiteId/cases/:caseId",
  async (c) => {
    const projectId = c.req.param("projectId");
    const suiteId = c.req.param("suiteId");
    const caseId = c.req.param("caseId");
    const body = parseWithSchema(
      updateCaseSchema,
      await readJsonObjectBody(c),
    );
    const token = await getConvexBearerForRequest(c);
    const existing = await loadCaseInScope(
      createConvexReadClient(token),
      projectId,
      suiteId,
      caseId,
    );
    const args = buildCaseMutationArgs(body, {
      forCreate: false,
      existingCaseType:
        typeof existing.caseType === "string" ? existing.caseType : undefined,
      existingSteps: existing.steps,
      existingMatchOptions: existing.matchOptions,
      existingProbeConfig: existing.probeConfig,
    });
    const { convexClient } = createConvexClients(token);
    let updated: CaseDoc | null | undefined;
    try {
      updated = await convexClient.mutation(
        "testSuites:updateTestCase" as any,
        {
          testCaseId: caseId,
          changeSource: "manual",
          ...args,
        },
      );
    } catch (error) {
      throw translateConvexWriteError(error);
    }
    // updateTestCase returns the updated doc, but re-read if a deploy ever
    // returns void so we never call toCaseDto on undefined (→ 500).
    if (!updated) {
      updated = await loadCaseInScope(
        createConvexReadClient(token),
        projectId,
        suiteId,
        caseId,
      );
    }
    return v1Resource(c, toCaseDto(updated));
  },
);

// DELETE /v1/projects/:projectId/eval-suites/:suiteId/cases/:caseId
evals.delete(
  "/projects/:projectId/eval-suites/:suiteId/cases/:caseId",
  async (c) => {
    const projectId = c.req.param("projectId");
    const suiteId = c.req.param("suiteId");
    const caseId = c.req.param("caseId");
    const token = await getConvexBearerForRequest(c);
    await loadCaseInScope(
      createConvexReadClient(token),
      projectId,
      suiteId,
      caseId,
    );
    const { convexClient } = createConvexClients(token);
    try {
      await convexClient.mutation("testSuites:deleteTestCase" as any, {
        testCaseId: caseId,
      });
    } catch (error) {
      throw translateConvexWriteError(error);
    }
    return v1Resource(c, { id: caseId, deleted: true });
  },
);

// POST /v1/projects/:projectId/eval-suites/:suiteId/cases/generate
// AI-generate cases from the suite's server tools and persist them. Needs a
// live MCP connection (tool discovery) — the only edit route that does. Spends
// org credits. Synchronous: connect, generate, persist, disconnect, respond.
evals.post(
  "/projects/:projectId/eval-suites/:suiteId/cases/generate",
  async (c) => {
    const projectId = c.req.param("projectId");
    const suiteId = c.req.param("suiteId");
    const body = parseWithSchema(
      generateCasesSchema,
      await readJsonObjectBody(c),
    );
    const mode = body.mode ?? "normal";
    const token = await getConvexBearerForRequest(c);
    // Generation is the one spend whose expensive step (the LLM call) happens
    // outside any mutation. With a key, the route becomes replayable: the
    // drafts are recorded in a backend ledger BEFORE cases are persisted, so a
    // retry (a proposal reclaim, a redelivered click) replays the recorded
    // drafts instead of spending credits again — and each case is persisted
    // under a derived per-item key, so the persistence loop is resumable.
    // The HEADER wins over any body value. Both are caller-supplied, but the
    // header is the transport-level channel unattended clients use, and it is
    // the one the agent adapter controls — a body key could otherwise be
    // shaped by model output.
    //
    // `readAnyIdempotencyKey` and not `readIdempotencyKey`: the SDK client
    // puts `options.idempotencyKey` on a bare `idempotency-key` header, so
    // reading only the prefixed spelling would ignore an SDK caller's key and
    // re-spend on the retry while the caller watched a key go out. This route
    // is the one with the most to lose from that.
    const idempotencyKey = readAnyIdempotencyKey(c) ?? body.idempotencyKey;

    // Project-scope guard.
    const readClient = createConvexReadClient(token);
    let suite: SuiteDoc | null;
    try {
      suite = await readClient.query("testSuites:getTestSuite" as any, {
        suiteId,
      });
    } catch (error) {
      if (isConvexNotVisibleError(error)) {
        throw new WebRouteError(
          404,
          ErrorCode.NOT_FOUND,
          "Eval suite not found",
        );
      }
      throw error;
    }
    requireProjectMatch(suite, projectId, "Eval suite");

    // Which environment (if any) this generation reads tools from — the same
    // attachment-authoritative rule the run route applies, evaluated BEFORE
    // tool discovery and before any credit is spent. An environment-based suite
    // that fell through to the legacy saved selection would generate cases
    // against the rollback server set, i.e. against tools its runs never see.
    const environmentId = await selectSuiteEnvironmentId({
      convexAuthToken: token,
      projectId,
      suite: suite!,
      requestedEnvironmentId: body.environmentId,
      hasServerOverride: (body.servers?.length ?? 0) > 0,
      serverField: "servers",
    });

    // Resolve the servers to discover tools from: the environment's closed set,
    // else an explicit override, else the suite's saved selection. An override
    // may be server names OR IDs (the API is the contract — don't assume the
    // SDK pre-resolved), so map to IDs here; batch authorization in
    // createAuthorizedManager only accepts Convex IDs.
    let serverIds = body.servers;
    let serverNames: string[] | undefined;
    if (environmentId) {
      let launch: ResolvedEnvironmentForLaunch;
      try {
        launch = await resolveEnvironmentForLaunch(readClient, {
          projectId,
          environmentId,
        });
      } catch (error) {
        throw translateEnvironmentResolveError(error);
      }
      serverIds = environmentServerIds(launch);
      serverNames = environmentServerNames(launch);
    } else if (!serverIds || serverIds.length === 0) {
      const selection = await fetchSuiteRunServerSelection(
        token,
        suiteId,
        undefined,
      );
      serverIds = selection.serverIds;
      serverNames = selection.serverNames;
    } else {
      const resolved = await resolveProjectServerSelectors(
        readClient,
        projectId,
        serverIds,
      );
      serverIds = resolved.serverIds;
      serverNames = resolved.serverNames;
    }

    const caseModels =
      body.caseModels?.map(toPersistedModelEntry) ??
      (await defaultCaseModels(readClient, suiteId));

    // A caseMix only counts when it requests at least one case (a bucket > 0).
    // An empty `{}` OR a zero-sum mix (`{ negative: 0 }`, all zeros) is treated
    // as absent — matching backend #589, which reverts a zero-sum mix to the
    // default plan, and the popover's `total >= 1` guard. Without this, a
    // truthy-but-empty mix would supersede `mode` here while the backend
    // ignored it, so e.g. `{ mode: "negative", caseMix: { negative: 0 } }`
    // would silently become normal generation.
    const hasCaseMix =
      !!body.caseMix &&
      Object.values(body.caseMix).some((v) => typeof v === "number" && v > 0);
    const generationOptions =
      hasCaseMix || body.varyUserStyles
        ? {
            ...(hasCaseMix ? { caseMix: body.caseMix } : {}),
            ...(body.varyUserStyles ? { varyUserStyles: true } : {}),
          }
        : undefined;

    // caseMix supersedes mode: a non-empty caseMix routes through the
    // plan-driven generator (which expresses negative-only via its `negative`
    // bucket and forwards generationOptions) and returns per-case
    // `isNegativeTest` flags. The legacy negative-only path — which forces every
    // draft negative — is used only when mode is "negative" AND no real caseMix
    // was given. This same flag gates persistence/counting below so a
    // `mode: "negative"` + caseMix request doesn't mislabel its positive cases.
    const legacyNegativeOnly = mode === "negative" && !hasCaseMix;

    const { convexClient } = createConvexClients(token);

    // LEDGER FIRST. A keyed retry whose first attempt already generated must
    // replay those exact drafts: regeneration is a second credit spend, and —
    // being stochastic — would produce different cases that no derived
    // per-item key could dedupe against the first attempt's.
    let drafts: any[] | null = null;
    if (idempotencyKey) {
      let ledger: { drafts: unknown } | null;
      try {
        ledger = await createConvexReadClient(token).query(
          "testSuites:getCaseGeneration" as any,
          { suiteId, idempotencyKey },
        );
      } catch (error) {
        // FAIL CLOSED, not degrade-to-generate. A caller that sent a key is
        // asking for spend idempotency; treating an unreadable ledger as a
        // cache miss would re-spend credits during exactly the kind of
        // backend blip that also lost the first attempt's response. 502 is
        // retryable and the retry presents the same key.
        logger.warn("v1.eval.generate: could not read the generation ledger", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new WebRouteError(
          502,
          ErrorCode.SERVER_UNREACHABLE,
          "Could not verify this generation's idempotency ledger. Retry with the same key.",
        );
      }
      if (ledger && Array.isArray(ledger.drafts)) {
        drafts = ledger.drafts;
      }
    }

    if (drafts === null) {
      const { manager } = await createAuthorizedManager(
        callerContextFromHono(c),
        token,
        projectId,
        serverIds,
        WEB_CALL_TIMEOUT_MS,
        undefined,
        undefined,
        {
          serverNames,
          // v1 eval API has no host-persona input — no enterprise policy to
          // enforce; the issuer makes per-server XAA servers mint instead of
          // failing with 'Missing XAA issuer'.
          xaaIssuer: resolveXaaIssuer(c, HOSTED_MODE),
        },
      );
      try {
        const request = {
          serverIds,
          serverNames,
          convexAuthToken: token,
          projectId,
          ...(generationOptions ? { generationOptions } : {}),
        } as unknown as RunEvalsRequest;
        const result = legacyNegativeOnly
          ? await generateNegativeEvalTestsWithManager(manager, request as any)
          : await generateEvalTestsWithManager(manager, request as any);
        drafts = Array.isArray((result as any).tests)
          ? (result as any).tests
          : [];
      } finally {
        await manager.disconnectAllServers().catch(() => {});
      }

      // Record the drafts BEFORE persisting any case — INCLUDING an empty
      // result: "the generator ran and produced nothing" is a spend worth
      // checkpointing too, or every keyed retry would pay for it again. From
      // this point a crash is recoverable without re-spending; before it,
      // regeneration was genuinely necessary anyway. Recording is best-effort
      // (the spend already happened, so failing the request here would strand
      // paid work), but a lost RACE is not a failure: the mutation is
      // first-writer-wins, and the loser must converge on the winner's drafts
      // so two concurrent same-key requests persist the SAME cases (the
      // per-item keys then dedupe the loop) instead of two divergent sets.
      if (idempotencyKey) {
        try {
          const outcome = (await convexClient.mutation(
            "testSuites:recordCaseGeneration" as any,
            { suiteId, idempotencyKey, drafts },
          )) as { recorded?: boolean } | null;
          if (outcome?.recorded === false) {
            const winner = await createConvexReadClient(token).query(
              "testSuites:getCaseGeneration" as any,
              { suiteId, idempotencyKey },
            );
            if (winner && Array.isArray(winner.drafts)) {
              drafts = winner.drafts;
            }
          }
        } catch (error) {
          logger.warn(
            "v1.eval.generate: could not record the generation ledger",
            { error: error instanceof Error ? error.message : String(error) },
          );
        }
      }
    }

    // Persist the generated drafts as cases under the suite.
    const created: ReturnType<typeof toCaseDto>[] = [];
    const createdCaseIds: string[] = [];
    const skipped: Array<{ title: string; error: string }> = [];
    let normal = 0;
    let negative = 0;
    // Built first, written once. Generation writes through the SAME batch
    // mutation as every other authoring path — there is no private route for
    // generated cases — so a 20-case generation is one write, not twenty.
    const pendingDrafts: Array<{
      item: EvalCaseBatchItem;
      title: string;
      isNegative: boolean;
    }> = [];
    for (const [draftIndex, draft] of drafts.entries()) {
      // The legacy negative-only path emits only negative cases; otherwise the
      // plan-driven generator flags each draft. Negative cases must carry NO
      // expected tool calls (the suite guard rejects that), so clear them on
      // both the top level and prompt turns.
      const isNeg = legacyNegativeOnly || draft.isNegativeTest === true;
      const mapCalls = (
        calls: any,
      ): Array<{ toolName: string; arguments: any }> =>
        isNeg || !Array.isArray(calls)
          ? []
          : calls.map((tc: any) =>
              typeof tc === "string"
                ? { toolName: tc, arguments: {} }
                : {
                    toolName: tc.toolName ?? tc.tool,
                    arguments: tc.arguments ?? {},
                  },
            );
      const promptTurns = Array.isArray(draft.promptTurns)
        ? draft.promptTurns.map((turn: any) => ({
            id: typeof turn.id === "string" ? turn.id : randomUUID(),
            prompt: turn.prompt ?? "",
            expectedToolCalls: mapCalls(turn.expectedToolCalls),
            ...(turn.expectedOutput !== undefined
              ? { expectedOutput: turn.expectedOutput }
              : {}),
          }))
        : [
            {
              id: randomUUID(),
              prompt: typeof draft.query === "string" ? draft.query : "",
              expectedToolCalls: mapCalls(draft.expectedToolCalls),
              ...(draft.expectedOutput !== undefined
                ? { expectedOutput: draft.expectedOutput }
                : {}),
            },
          ];
      const normalizedSteps = Array.isArray(draft.steps)
        ? normalizeSteps(draft.steps)
        : [];
      // Negative cases must carry no expected tool calls, so drop any
      // `toolCalledWith` asserts that survive inside authored steps; and fall
      // back to the promptTurns/query conversion when steps normalize to empty.
      const draftSteps = isNeg
        ? normalizedSteps.filter(
            (s) =>
              !(
                s.kind === "assert" &&
                (s.assertion as { type?: string }).type === "toolCalledWith"
              ),
          )
        : normalizedSteps;
      const steps =
        draftSteps.length > 0 ? draftSteps : promptTurnsToSteps(promptTurns);
      const item: EvalCaseBatchItem = {
        title: draft.title,
        steps,
        query: typeof draft.query === "string" ? draft.query : "",
        runs: typeof draft.runs === "number" ? draft.runs : 1,
        models: caseModels,
        expectedToolCalls: mapCalls(draft.expectedToolCalls),
        changeSource: "generated",
        ...(draft.expectedOutput !== undefined
          ? { expectedOutput: draft.expectedOutput }
          : {}),
        ...(isNeg ? { isNegativeTest: true } : {}),
        ...(draft.scenario !== undefined ? { scenario: draft.scenario } : {}),
        // Positional, not content-derived: on a keyed retry the drafts come
        // from the ledger VERBATIM, so index i names the same draft both
        // times and the re-persist lands on the first attempt's case.
        ...(idempotencyKey
          ? {
              idempotencyKey: deriveItemIdempotencyKey(
                idempotencyKey,
                String(draftIndex),
              ),
            }
          : {}),
      };
      pendingDrafts.push({
        item,
        title: String(draft.title ?? ""),
        isNegative: isNeg,
      });
    }

    if (pendingDrafts.length > 0) {
      // Minted HERE rather than in Convex: callers mint, the platform
      // validates. A generated case is authored by this server, so this is the
      // caller.
      const cases = withMintedCaseIds(pendingDrafts.map((d) => d.item));
      let result: Awaited<ReturnType<typeof createEvalCasesInBatches>>;
      let rejection: string | undefined;
      try {
        result = await createEvalCasesInBatches(convexClient, {
          suiteId,
          cases,
        });
      } catch (error) {
        // A whole-call rejection is one condition, not N. But a rejection can
        // still arrive after an earlier chunk committed, and those cases are
        // persisted — reporting them as skipped would understate what the
        // caller was billed for and invite a duplicate retry.
        rejection = error instanceof Error ? error.message : String(error);
        result = partialResultOf(error);
        logger.warn("v1.eval.generate: failed to persist the generated cases", {
          error: rejection,
          drafts: pendingDrafts.length,
          committedBeforeRejection: result.committed.length,
        });
      }

      // The platform addresses each result by the index of the item we sent.
      // An index outside that range is a bug, not an outcome — but it must not
      // throw AFTER the writes landed and take the whole report down with it.
      const draftAt = (index: number) => {
        const draft = pendingDrafts[index];
        if (!draft) {
          logger.warn(
            "v1.eval.generate: result named a draft index we never sent",
            { index, sent: pendingDrafts.length },
          );
        }
        return draft;
      };

      const reported = new Set<number>();
      for (const entry of result.failed) {
        const draft = draftAt(entry.index);
        if (!draft) continue;
        reported.add(entry.index);
        const reason = `${entry.code}: ${entry.message}`;
        logger.warn("v1.eval.generate: failed to persist a generated case", {
          error: reason,
        });
        skipped.push({ title: draft.title, error: reason });
      }
      const readClient = createConvexReadClient(token);
      // Read the committed cases in one pass. Committed entries arrive in item
      // order, and `Promise.all` preserves it, so `created` still follows the
      // order the generator produced.
      const docs = await Promise.all(
        result.committed.map((entry) =>
          readClient.query("testSuites:getTestCase" as any, {
            // The EFFECTIVE id, not the one just minted. A keyed retry replays
            // onto the case the first attempt authored, and reporting the fresh
            // proposal would name a case that was never written.
            testCaseId: entry.testCaseId,
          }),
        ),
      );
      result.committed.forEach((entry, position) => {
        const draft = draftAt(entry.index);
        if (!draft) return;
        reported.add(entry.index);
        created.push(toCaseDto(docs[position]));
        createdCaseIds.push(String(entry.testCaseId));
        if (draft.isNegative) negative += 1;
        else normal += 1;
      });
      // Drafts the rejected call never reached.
      if (rejection !== undefined) {
        pendingDrafts.forEach((draft, index) => {
          if (!reported.has(index)) {
            skipped.push({ title: draft.title, error: rejection! });
          }
        });
      }

      const entryWarnings = result.committed.flatMap((entry) =>
        (entry.warnings ?? []).map((w) => ({ title: entry.title, ...w })),
      );
      if (result.warnings.length > 0 || entryWarnings.length > 0) {
        logger.info("v1.eval.generate: case create returned warnings", {
          suiteId,
          warnings: [...result.warnings, ...entryWarnings],
        });
      }
    }

    // Best-effort bookkeeping so the ledger row also names what it produced.
    if (idempotencyKey && createdCaseIds.length > 0) {
      await convexClient
        .mutation("testSuites:markCaseGenerationPersisted" as any, {
          suiteId,
          idempotencyKey,
          createdCaseIds,
        })
        .catch(() => {});
    }

    return v1Resource(c, {
      generationModel: "anthropic/claude-haiku-4.5",
      created,
      counts: { normal, negative },
      // Surface, never silently drop, drafts that failed to persist.
      ...(skipped.length > 0 ? { skipped } : {}),
    });
  },
);

export default evals;
