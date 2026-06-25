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
import { ConvexHttpClient } from "convex/browser";
import { parseWithSchema, ErrorCode, WebRouteError } from "../web/errors.js";
import { createAuthorizedManager, callerContextFromHono } from "../web/auth.js";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
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
import { logger } from "../../utils/logger.js";
import { v1Error, v1PageJson, v1Resource } from "./envelope.js";
import { synthesizeServerBody } from "./adapter.js";
import {
  getCanonicalModelId,
  isMCPJamProvidedModel,
  isModelSupported,
  SUPPORTED_MODELS,
} from "@/shared/types";

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
  steps: TestStep[]
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
  steps: TestStep[]
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
  test: PublicInlineTest
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
// chatbox/access/storage fields are hosted-client concerns) and minus the
// internal-contract `tests` (replaced by the public `steps`-based shape).
const createEvalRunSchema = RunEvalsRequestSchema.omit({
  convexAuthToken: true,
  chatboxId: true,
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
  })
  .refine((body) => body.suiteId || (body.tests?.length ?? 0) > 0, {
    message: "Provide suiteId (rerun) and/or inline tests",
  })
  .refine((body) => body.suiteId || (body.serverIds?.length ?? 0) > 0, {
    message: "serverIds are required when creating a new suite",
  });

// ── Author-only suite-create schema ──────────────────────────────────

// Ergonomic body for author-only suite creation. NOT `RunEvalsRequestSchema`:
// per-test `runs`/`model`/`provider` are optional here and filled from
// suite-level defaults by `normalizeCreateTestsToRunTests` before the strict
// run schema validates them. The case body is the public `steps` contract
// (`TestStep[]`), projected to the internal case fields by that normalizer.
const createEvalSuiteSchema = z.object({
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
      })
    )
    .min(1)
    .max(MAX_V1_TESTS),
});

type CreateEvalSuiteBody = z.infer<typeof createEvalSuiteSchema>;

/**
 * Expand the ergonomic authoring tests into the full
 * `RunEvalsRequestSchema.shape.tests` element shape: fill `runs`, resolve
 * model/provider from suite defaults (deriving provider from a `provider/model`
 * id when neither is given), preserve each case's public `steps` array, and
 * project denormalized `query` / `expectedToolCalls` display fields from it.
 */
function normalizeCreateTestsToRunTests(
  tests: CreateEvalSuiteBody["tests"],
  suite: { model: string; provider?: string }
): RunEvalsRequest["tests"] {
  return tests.map((test) => {
    const runs = test.runs ?? 1;
    const model = test.model ?? suite.model;
    let provider = test.provider ?? suite.provider;
    if (!provider) {
      provider = model.includes("/") ? model.split("/")[0] : undefined;
    }
    if (!provider) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        `Cannot derive a provider for test "${test.title}". Pass a suite-level "provider", a per-test "provider", or a "provider/model" id.`
      );
    }
    const derived = stepsToInternalCaseFields(test.steps as TestStep[]);
    return {
      title: test.title,
      steps: withImplicitRenderAssertForSingleToolCall(
        test.steps as TestStep[]
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
  modelApiKeys: Record<string, string> | undefined
): void {
  for (const test of tests) {
    const provider = test.provider.trim().toLowerCase();
    if (OPEN_MODEL_PROVIDERS.has(provider)) continue;
    const canonical = getCanonicalModelId(test.model, test.provider);
    if (isMCPJamProvidedModel(canonical, test.provider)) continue;
    if (modelApiKeys?.[test.provider] ?? modelApiKeys?.[provider]) continue;
    if (isModelSupported(canonical)) continue;

    const hostedIds = SUPPORTED_MODELS.filter(
      (m) =>
        m.provider.toLowerCase() === provider &&
        isMCPJamProvidedModel(String(m.id), m.provider)
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
      }
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
  process.env.V1_MAX_CONCURRENT_EVAL_RUNS
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

// ── Convex read client ───────────────────────────────────────────────

function createConvexReadClient(convexAuthToken: string): ConvexHttpClient {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_URL configuration"
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

function requireProjectMatch(
  resource: { projectId?: unknown } | null | undefined,
  projectId: string,
  what: string
): void {
  if (!resource || String(resource.projectId ?? "") !== projectId) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, `${what} not found`);
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
  namedHostId: string | undefined
): Promise<{ serverIds: string[]; serverNames: string[] }> {
  const convex = createConvexReadClient(convexAuthToken);
  let selection: {
    serverIds?: unknown;
    serverNames?: unknown;
  } | null;
  try {
    selection = await convex.query(
      "testSuites:getSuiteRunServerSelection" as any,
      { suiteId, ...(namedHostId ? { namedHostId } : {}) }
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
        "This deployment cannot derive the suite's saved servers yet. Pass serverIds explicitly."
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
      { suiteId, reason: "NO_SAVED_SERVER_SELECTION" }
    );
  }
  return { serverIds, serverNames };
}

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  // The runner finalizes run/iteration timeouts as `timed_out` before
  // rethrowing into the detached catch. Treat it as terminal so the defensive
  // re-finalize can't overwrite a timeout result with `failed`.
  "timed_out",
]);

/**
 * Whether the run record already reached a terminal status. Used by the
 * detached-execution catch: `runEvalSuiteWithAiSdk` finalizes a failed run
 * itself before rethrowing, so a rejected `execute()` usually means the
 * terminal write already happened — re-finalizing would restamp
 * `completedAt` and overwrite the runner's notes.
 */
async function isRunAlreadyTerminal(
  convexAuthToken: string,
  runId: string
): Promise<boolean> {
  try {
    const run: RunDoc | null = await createConvexReadClient(
      convexAuthToken
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
    createdAt: run.createdAt,
    completedAt: run.completedAt ?? null,
  };
}

function toIterationDto(iteration: IterationDoc) {
  const snapshot = iteration.testCaseSnapshot ?? {};
  const startedAt =
    typeof iteration.startedAt === "number" ? iteration.startedAt : null;
  const isTerminal =
    iteration.status === "completed" ||
    iteration.status === "failed" ||
    iteration.status === "cancelled" ||
    iteration.status === "timed_out";
  const durationMs =
    isTerminal && startedAt !== null && typeof iteration.updatedAt === "number"
      ? Math.max(iteration.updatedAt - startedAt, 0)
      : null;
  return {
    id: String(iteration._id),
    testCaseId: iteration.testCaseId ? String(iteration.testCaseId) : null,
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
  mo: PublicMatchOptions
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
 * Merge a partial public match-options patch onto the stored (internal) object.
 * `updateTestSuite`/`updateTestCase` replace the field wholesale, so a partial
 * patch must layer onto current values. When the patch sets the extra-call
 * bound, drop the legacy `allowExtraToolCalls` so it can't shadow the modern
 * `maxExtraToolCalls` on read.
 */
function mergeMatchOptions(
  current: any,
  patch: PublicMatchOptions
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
      String(internal.argumentMatching)
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
        testCase.probeConfig as ProbeConfig
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

function toCaseDto(testCase: CaseDoc) {
  return {
    id: String(testCase._id),
    title: testCase.title ?? "",
    steps: internalCaseToSteps(testCase),
    ...(testCase.expectedOutput !== undefined
      ? { expectedOutput: testCase.expectedOutput }
      : {}),
    iterations: typeof testCase.runs === "number" ? testCase.runs : 1,
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
    createdAt: testCase.createdAt ?? null,
    updatedAt: testCase.updatedAt ?? null,
  };
}

// ── Suite-detail DTO ─────────────────────────────────────────────────

type SuiteDoc = Record<string, any>;

function toSuiteDetailDto(suite: SuiteDoc, execConfig: any) {
  const goal = suite.judgeConfig?.goalCompletion;
  return {
    id: String(suite._id),
    name: suite.name ?? null,
    description: suite.description ?? null,
    projectId: suite.projectId ? String(suite.projectId) : null,
    environment: {
      servers: Array.isArray(suite.environment?.servers)
        ? suite.environment.servers.map(String)
        : [],
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
    settings: {
      minimumAccuracy:
        typeof suite.defaultPassCriteria?.minimumPassRate === "number"
          ? suite.defaultPassCriteria.minimumPassRate
          : null,
      matchOptions: toPublicMatchOptions(suite.defaultMatchOptions),
      checks: Array.isArray(suite.defaultPredicates)
        ? suite.defaultPredicates
        : [],
      // GOAL_COMPLETION_DEFAULTS.enabled is true; readers treat absent as on.
      judge: {
        enabled: goal?.enabled !== false,
        model: goal?.judgeModel ?? null,
      },
    },
    schedule: {
      enabled: suite.schedule?.enabled === true,
      intervalMinutes:
        typeof suite.schedule?.intervalMinutes === "number"
          ? suite.schedule.intervalMinutes
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
 * Resolve a model id's provider. Handles a `provider/model` prefix directly,
 * and looks a BARE id (e.g. "claude-sonnet-4-5") up in the model catalog —
 * suite execution configs store bare ids, so a slash check alone would fail to
 * derive a provider and leave new cases model-less.
 */
function providerForModelId(modelId: string): string | undefined {
  if (modelId.includes("/")) return modelId.split("/")[0];
  const match = SUPPORTED_MODELS.find(
    (m) => String(m.id) === modelId || String(m.id).endsWith(`/${modelId}`)
  );
  return match ? String(match.provider) : undefined;
}

function deriveProvider(model: string, explicit: string | undefined): string {
  if (explicit) return explicit;
  const provider = providerForModelId(model);
  if (provider) return provider;
  throw new WebRouteError(
    400,
    ErrorCode.VALIDATION_ERROR,
    `Cannot derive a provider for model "${model}". Pass provider, or a "provider/model" id.`
  );
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
  isNegative: z.boolean().optional(),
  scenario: z.string().optional(),
  models: z
    .array(
      z.object({
        model: z.string().min(1),
        provider: z.string().min(1).optional(),
      })
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

const createCaseSchema = z.object(publicCaseBodyShape);
const updateCaseSchema = z.object(publicCaseBodyShape);

const updateSuiteSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  environment: z.object({ servers: z.array(z.string().min(1)) }).optional(),
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
      })
    )
    .optional(),
  settings: z
    .object({
      minimumAccuracy: z.number().min(0).max(100).optional(),
      matchOptions: publicMatchOptionsSchema.nullable().optional(),
      checks: z.array(publicCheckSchema).nullable().optional(),
      judge: z
        .object({
          enabled: z.boolean().optional(),
          model: z.string().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
});

const scheduleSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(5).max(10080).optional(),
});

const generateCasesSchema = z.object({
  mode: z.enum(["normal", "negative"]).optional(),
  servers: z.array(z.string().min(1)).optional(),
  caseModels: z
    .array(
      z.object({
        model: z.string().min(1),
        provider: z.string().min(1).optional(),
      })
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
});

/**
 * Build createTestCase / updateTestCase mutation args from the public case
 * body. `defaultModels` (resolved from the suite when the body omits models)
 * is only used for create — update leaves models untouched when omitted.
 */
function buildCaseMutationArgs(
  body: z.infer<typeof createCaseSchema>,
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
  }
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  let isModelFreeStepsCase = false;
  if (body.title !== undefined) args.title = body.title;
  if (body.iterations !== undefined) args.runs = body.iterations;
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
      body.steps as TestStep[]
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
        `Case kind is immutable (this case is "${existingKind}"); create a new case to change it.`
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
    args.models = body.models.map((m) => ({
      model: m.model,
      provider: deriveProvider(m.model, m.provider),
    }));
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

  return args;
}

/**
 * Map an error thrown by a Convex suite/case write mutation onto a v1 error.
 * Convex surfaces validation failures as plain Errors; the common cases (not
 * found / unauthorized, and the suite/case invariant guards like "Positive
 * test cases must include at least one assertion") are caller mistakes (404 /
 * 400), not 500s.
 */
function translateConvexWriteError(error: unknown): WebRouteError {
  if (error instanceof WebRouteError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (isConvexNotVisibleError(error)) {
    return new WebRouteError(404, ErrorCode.NOT_FOUND, "Resource not found");
  }
  // Strip Convex's "[Request ID: …] Server Error\nUncaught Error: " framing so
  // the caller sees the human-readable invariant message.
  const cleaned = message
    .replace(/\[Request ID:[^\]]*\]\s*/g, "")
    .replace(/^Server Error\s*/i, "")
    .replace(/Uncaught (Error|ConvexError):\s*/i, "")
    .split("\n")[0]!
    .trim();
  return new WebRouteError(
    400,
    ErrorCode.VALIDATION_ERROR,
    cleaned || "Eval write rejected by the platform"
  );
}

/**
 * Resolve public host attachments (`{ host, servers? }`) to the internal
 * `{ namedHostId, selectedServerIds? }` shape. Host names resolve via the
 * project's host catalog; per-host server names resolve against the suite's
 * own environment bindings (no live connection, no extra catalog query).
 */
async function resolveHostAttachments(
  convexClient: ReturnType<typeof createConvexClients>["convexClient"],
  projectId: string,
  suite: SuiteDoc,
  hosts: Array<{ host: string; servers?: string[] }>
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
  for (const b of suite.environment?.serverBindings ?? []) {
    if (b?.projectServerId) {
      bindingByName.set(
        String(b.serverName).toLocaleLowerCase(),
        String(b.projectServerId)
      );
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
          `Host name "${trimmed}" is ambiguous; use the host id.`
        );
      }
      resolved = matches[0];
    }
    if (!resolved) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        `Host "${trimmed}" not found in this project.`
      );
    }
    const attachment: Record<string, unknown> = {
      namedHostId: String(resolved.hostId),
    };
    if (servers !== undefined) {
      attachment.selectedServerIds = servers.map((name) => {
        const id = bindingByName.get(name.trim().toLocaleLowerCase());
        if (!id) {
          throw new WebRouteError(
            400,
            ErrorCode.VALIDATION_ERROR,
            `Server "${name}" is not in the suite's environment; add it via environment.servers first.`
          );
        }
        return id;
      });
    }
    return attachment;
  });
}

// ── Routes ───────────────────────────────────────────────────────────

// POST /v1/projects/:projectId/eval-runs
// Create a suite run (existing suiteId rerun and/or inline tests) and start
// executing it in the background. Responds 202 with the runId immediately;
// poll GET /eval-runs/:runId for progress.
evals.post("/projects/:projectId/eval-runs", async (c) => {
  const projectId = c.req.param("projectId");
  const rawBody = await synthesizeServerBody(c);
  const body = parseWithSchema(createEvalRunSchema, {
    ...rawBody,
    projectId,
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

  // Omitted serverIds on a rerun (the schema guarantees suiteId here):
  // connect the suite's saved server selection — the exact set the run
  // snapshot will reference — instead of making the caller guess it.
  let serverIds = body.serverIds ?? [];
  let serverNames = body.serverNames;
  if (serverIds.length === 0) {
    const selection = await fetchSuiteRunServerSelection(
      convexAuthToken,
      body.suiteId!,
      body.namedHostId
    );
    serverIds = selection.serverIds;
    serverNames = selection.serverNames;
  }

  const slotKey = orgConcurrencyKey(c);
  if (!tryAcquireRunSlot(slotKey)) {
    return v1Error(
      c,
      "RATE_LIMITED",
      `Too many concurrent eval runs (max ${MAX_CONCURRENT_RUNS}). Wait for an active run to finish.`,
      { reason: "CONCURRENT_RUN_LIMIT", maxConcurrentRuns: MAX_CONCURRENT_RUNS }
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
    const { manager } = await createAuthorizedManager(
      callerContextFromHono(c),
      convexAuthToken,
      projectId,
      serverIds,
      WEB_CALL_TIMEOUT_MS,
      undefined,
      undefined,
      { serverNames }
    );

    let prepared: PreparedEvalRun;
    try {
      prepared = await prepareEvalRun(manager, {
        ...body,
        // Project the public `steps`-based inline tests onto the internal
        // run-schema test shape the pipeline still consumes.
        tests: body.tests.map(publicInlineTestToRunTest),
        serverIds,
        serverNames,
        projectId,
        suiteRerun,
        convexAuthToken,
        source: "api",
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
        releaseSlotOnce();
        void manager.disconnectAllServers().catch(() => {});
      });

    return v1Resource(
      c,
      {
        runId: prepared.runId,
        suiteId: prepared.suiteId,
        status: "running",
        caseUpsert: prepared.caseUpsert,
        // The servers the run connects to — explicit or derived from the
        // suite's saved selection — so callers that omitted serverIds can
        // see what the run targets. Names are present when known (always,
        // on the derived path).
        servers: serverIds.map((serverId, index) => ({
          id: serverId,
          ...(serverNames?.[index] ? { name: serverNames[index] } : {}),
        })),
      },
      202
    );
  } catch (error) {
    releaseSlotOnce();
    throw error;
  }
});

// POST /v1/projects/:projectId/eval-suites
// Author-only: CREATE a runnable eval suite (suite + test cases) WITHOUT
// running it. Synchronous — validation/persistence errors surface here.
// Responds 201 with the suiteId. Distinct from POST /eval-runs (which creates
// AND detaches execution, responding 202 with a runId). No concurrency slot,
// no recorder, no execution.
evals.post("/projects/:projectId/eval-suites", async (c) => {
  const projectId = c.req.param("projectId");
  const rawBody = await synthesizeServerBody(c);
  const body = parseWithSchema(createEvalSuiteSchema, rawBody);

  // Expand ergonomic tests into the strict run-schema element shape, then
  // re-validate against the source-of-truth schema. Use parseWithSchema so a
  // second-stage failure (for example, an invalid advancedConfig.toolChoice)
  // surfaces as a 400 VALIDATION_ERROR rather than an uncaught ZodError → 500.
  const normalizedTests = parseWithSchema(
    RunEvalsRequestSchema.shape.tests,
    normalizeCreateTestsToRunTests(body.tests, {
      model: body.model,
      provider: body.provider,
    })
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
    { serverNames }
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
      201
    );
  } finally {
    await manager.disconnectAllServers().catch(() => {});
  }
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
  return v1Resource(c, toRunDto(run!));
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
    run = await readClient.query("testSuites:getTestSuiteRun" as any, { runId });
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
      `Cannot cancel a run that already ${status}`
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

// GET /v1/projects/:projectId/eval-runs/:runId/iterations?cursor=&limit=
// Per-iteration results: tool calls, structured token usage, latency.
evals.get("/projects/:projectId/eval-runs/:runId/iterations", async (c) => {
  const projectId = c.req.param("projectId");
  const runId = c.req.param("runId");
  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? 50) || 50, 1),
    200
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
    page.isDone ? undefined : page.continueCursor
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
    const convex = createConvexReadClient(await getConvexBearerForRequest(c));

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
          "Eval iteration not found"
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
          "Eval iteration not found"
        );
      }
      throw error;
    }
    if (trace === null || trace === undefined) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "Trace is not available for this iteration",
        { reason: "TRACE_NOT_AVAILABLE" }
      );
    }
    return v1Resource(c, trace);
  }
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
    const convex = createConvexReadClient(await getConvexBearerForRequest(c));

    let iteration: IterationDoc | null;
    try {
      const [run, iter] = await Promise.all([
        convex.query("testSuites:getTestSuiteRun" as any, { runId }),
        convex.query("testSuites:getTestIteration" as any, { iterationId }),
      ]);
      requireProjectMatch(run, projectId, "Eval run");
      iteration = iter as IterationDoc | null;
      if (
        !iteration ||
        String(iteration.suiteRunId ?? "") !== runId
      ) {
        throw new WebRouteError(
          404,
          ErrorCode.NOT_FOUND,
          "Eval iteration not found"
        );
      }
    } catch (error) {
      if (isConvexNotVisibleError(error)) {
        throw new WebRouteError(
          404,
          ErrorCode.NOT_FOUND,
          "Eval iteration not found"
        );
      }
      throw error;
    }

    const snapshot = (iteration.testCaseSnapshot ?? {}) as Record<string, any>;
    const steps: TestStep[] = Array.isArray(snapshot.steps)
      ? normalizeSteps(snapshot.steps as TestStep[])
      : [];

    // Evidence is best-effort: the trace blob may be absent (still-running or
    // never-persisted iteration). Verdicts from metadata still return.
    let envelope: Record<string, unknown> | undefined;
    try {
      const trace = await convex.action(
        "testSuites:getTestIterationBlob" as any,
        { iterationId }
      );
      if (trace && typeof trace === "object") {
        envelope = trace as Record<string, unknown>;
      }
    } catch (error) {
      if (!isConvexNotVisibleError(error)) throw error;
    }

    const assembled = assembleStepResults(
      steps,
      iteration.metadata as { stepResults?: any[]; skippedSteps?: any[] } | undefined,
      envelope as Parameters<typeof assembleStepResults>[2]
    );
    return v1PageJson(c, assembled.map(toStepResultDto));
  }
);

// GET /v1/projects/:projectId/eval-suites/:suiteId/runs?limit=
// Recent runs for a suite, newest first.
evals.get("/projects/:projectId/eval-suites/:suiteId/runs", async (c) => {
  const projectId = c.req.param("projectId");
  const suiteId = c.req.param("suiteId");
  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? 25) || 25, 1),
    100
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
  suiteId: string
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
  return toSuiteDetailDto(suite!, execConfig);
}

/** Default execution models for a new case: the suite's configured model. */
async function defaultCaseModels(
  convex: ReturnType<typeof createConvexReadClient>,
  suiteId: string
): Promise<Array<{ model: string; provider: string }>> {
  try {
    const cfg: any = await convex.query("hostConfigsV2:getSuiteConfig" as any, {
      suiteId,
    });
    const modelId = cfg?.modelId;
    if (typeof modelId === "string" && modelId.length > 0) {
      // Suite configs store bare ids (e.g. "claude-sonnet-4-5"); resolve the
      // provider via the catalog so the new case isn't persisted model-less.
      const provider = providerForModelId(modelId);
      if (provider) return [{ model: modelId, provider }];
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
  selectors: string[]
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
          `Server name "${trimmed}" is ambiguous; use the server id.`
        );
      }
      match = named[0];
    }
    if (!match) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        `Server "${trimmed}" not found in this project.`
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
    await synthesizeServerBody(c)
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

  const updateArgs: Record<string, unknown> = { suiteId };
  if (body.name !== undefined) updateArgs.name = body.name;
  if (body.description !== undefined) updateArgs.description = body.description;
  if (body.environment !== undefined) {
    updateArgs.environment = { servers: body.environment.servers };
    updateArgs.refreshHostConfigFromEnvironment = true;
  }
  if (body.settings) {
    const s = body.settings;
    if (s.minimumAccuracy !== undefined)
      updateArgs.defaultPassCriteria = { minimumPassRate: s.minimumAccuracy };
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
      updateArgs.judgeConfig = { goalCompletion };
    }
  }
  // Only call updateTestSuite when there's something beyond the suiteId.
  if (Object.keys(updateArgs).length > 1) {
    try {
      await convexClient.mutation(
        "testSuites:updateTestSuite" as any,
        updateArgs
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
          body.hosts
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
        "Suite has no execution config to edit yet."
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

  return v1Resource(c, await readSuiteDetail(token, projectId, suiteId));
});

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
  const body = parseWithSchema(scheduleSchema, await synthesizeServerBody(c));
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
      "intervalMinutes is required to enable scheduled runs (this suite has no saved interval)."
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
  caseId: string
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
  }
);

// POST /v1/projects/:projectId/eval-suites/:suiteId/cases
evals.post("/projects/:projectId/eval-suites/:suiteId/cases", async (c) => {
  const projectId = c.req.param("projectId");
  const suiteId = c.req.param("suiteId");
  const body = parseWithSchema(createCaseSchema, await synthesizeServerBody(c));
  if (!body.title) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "title is required."
    );
  }
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
  let caseId: string;
  try {
    caseId = await convexClient.mutation("testSuites:createTestCase" as any, {
      suiteId,
      changeSource: "manual",
      ...args,
    });
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  const created = await loadCaseInScope(
    createConvexReadClient(token),
    projectId,
    suiteId,
    String(caseId)
  );
  return v1Resource(c, toCaseDto(created), 201);
});

// PATCH /v1/projects/:projectId/eval-suites/:suiteId/cases/:caseId
evals.patch(
  "/projects/:projectId/eval-suites/:suiteId/cases/:caseId",
  async (c) => {
    const projectId = c.req.param("projectId");
    const suiteId = c.req.param("suiteId");
    const caseId = c.req.param("caseId");
    const body = parseWithSchema(
      updateCaseSchema,
      await synthesizeServerBody(c)
    );
    const token = await getConvexBearerForRequest(c);
    const existing = await loadCaseInScope(
      createConvexReadClient(token),
      projectId,
      suiteId,
      caseId
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
        }
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
        caseId
      );
    }
    return v1Resource(c, toCaseDto(updated));
  }
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
      caseId
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
  }
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
      await synthesizeServerBody(c)
    );
    const mode = body.mode ?? "normal";
    const token = await getConvexBearerForRequest(c);

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
          "Eval suite not found"
        );
      }
      throw error;
    }
    requireProjectMatch(suite, projectId, "Eval suite");

    // Resolve the servers to discover tools from: explicit override, else the
    // suite's saved selection. An override may be server names OR IDs (the API
    // is the contract — don't assume the SDK pre-resolved), so map to IDs here;
    // batch authorization in createAuthorizedManager only accepts Convex IDs.
    let serverIds = body.servers;
    let serverNames: string[] | undefined;
    if (!serverIds || serverIds.length === 0) {
      const selection = await fetchSuiteRunServerSelection(
        token,
        suiteId,
        undefined
      );
      serverIds = selection.serverIds;
      serverNames = selection.serverNames;
    } else {
      const resolved = await resolveProjectServerSelectors(
        readClient,
        projectId,
        serverIds
      );
      serverIds = resolved.serverIds;
      serverNames = resolved.serverNames;
    }

    const caseModels =
      body.caseModels?.map((m) => ({
        model: m.model,
        provider: deriveProvider(m.model, m.provider),
      })) ?? (await defaultCaseModels(readClient, suiteId));

    const { manager } = await createAuthorizedManager(
      callerContextFromHono(c),
      token,
      projectId,
      serverIds,
      WEB_CALL_TIMEOUT_MS,
      undefined,
      undefined,
      { serverNames }
    );

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

    let drafts: any[];
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

    // Persist each generated draft as a case under the suite.
    const { convexClient } = createConvexClients(token);
    const created: ReturnType<typeof toCaseDto>[] = [];
    const skipped: Array<{ title: string; error: string }> = [];
    let normal = 0;
    let negative = 0;
    for (const draft of drafts) {
      // The legacy negative-only path emits only negative cases; otherwise the
      // plan-driven generator flags each draft. Negative cases must carry NO
      // expected tool calls (the suite guard rejects that), so clear them on
      // both the top level and prompt turns.
      const isNeg = legacyNegativeOnly || draft.isNegativeTest === true;
      const mapCalls = (
        calls: any
      ): Array<{ toolName: string; arguments: any }> =>
        isNeg || !Array.isArray(calls)
          ? []
          : calls.map((tc: any) =>
              typeof tc === "string"
                ? { toolName: tc, arguments: {} }
                : {
                    toolName: tc.toolName ?? tc.tool,
                    arguments: tc.arguments ?? {},
                  }
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
      const steps = Array.isArray(draft.steps)
        ? normalizeSteps(draft.steps)
        : promptTurnsToSteps(promptTurns);
      const args: Record<string, unknown> = {
        suiteId,
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
      };
      try {
        const caseId = await convexClient.mutation(
          "testSuites:createTestCase" as any,
          args
        );
        const doc = await createConvexReadClient(token).query(
          "testSuites:getTestCase" as any,
          { testCaseId: caseId }
        );
        created.push(toCaseDto(doc));
        if (isNeg) negative += 1;
        else normal += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn("v1.eval.generate: failed to persist a generated case", {
          error: reason,
        });
        skipped.push({ title: String(draft.title ?? ""), error: reason });
      }
    }

    return v1Resource(c, {
      generationModel: "anthropic/claude-haiku-4.5",
      created,
      counts: { normal, negative },
      // Surface, never silently drop, drafts that failed to persist.
      ...(skipped.length > 0 ? { skipped } : {}),
    });
  }
);

export default evals;
