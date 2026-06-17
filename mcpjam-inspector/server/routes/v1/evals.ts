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
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { parseWithSchema, ErrorCode, WebRouteError } from "../web/errors.js";
import {
  createAuthorizedManager,
  callerContextFromHono,
} from "../web/auth.js";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import {
  RunEvalsRequestSchema,
  prepareEvalRun,
  authorEvalSuite,
  createConvexClients,
  resolveServerIdsOrThrow,
  promptTurnSchema,
  type PreparedEvalRun,
  type RunEvalsRequest,
} from "../shared/evals.js";
import { matchOptionsSchema, casePredicatesSchema } from "@/shared/eval-matching";
import { probeConfigSchema, TEST_CASE_TYPES } from "@/shared/probe-config";
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

// ── Request schema ───────────────────────────────────────────────────

const MAX_V1_TESTS = 100;

// Public shape: the web RunEvalsRequestSchema minus hosted-app plumbing the
// public surface must not accept (`convexAuthToken` comes from the bearer;
// chatbox/access/storage fields are hosted-client concerns).
const createEvalRunSchema = RunEvalsRequestSchema.omit({
  convexAuthToken: true,
  chatboxId: true,
  accessVersion: true,
  storageServerIds: true,
})
  .extend({
    // Inline tests are optional on the public surface: a bare `suiteId`
    // rerun is the simplest possible call.
    tests: RunEvalsRequestSchema.shape.tests.max(MAX_V1_TESTS).default([]),
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

// An expected tool call may be given as a bare tool name or a {toolName,
// arguments} object — the ergonomic authoring shape. `normalizeCreateTests…`
// expands both into the wire `{ toolName, arguments }` the run schema expects.
const expectedToolCallEntrySchema = z.union([
  z.string().min(1),
  z.object({
    toolName: z.string().min(1),
    arguments: z.record(z.string(), z.any()).optional(),
  }),
]);

// Ergonomic body for author-only suite creation. NOT `RunEvalsRequestSchema`:
// per-test `runs`/`model`/`provider`/`expectedToolCalls` are optional here and
// filled from suite-level defaults by `normalizeCreateTestsToRunTests` before
// the strict run schema validates them.
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
        // Required for prompt cases; widget_probe rows carry an empty query
        // (normalized to "" in normalizeCreateTestsToRunTests). Enforced by
        // the superRefine below so a prompt case can't be authored query-less.
        query: z.string().optional(),
        runs: z.number().int().min(1).max(10).optional(),
        model: z.string().optional(),
        provider: z.string().optional(),
        expectedToolCalls: z.array(expectedToolCallEntrySchema).optional(),
        expectedOutput: z.string().optional(),
        isNegativeTest: z.boolean().optional(),
        scenario: z.string().optional(),
        promptTurns: z.array(promptTurnSchema).optional(),
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
        caseType: z.enum(TEST_CASE_TYPES).optional(),
        probeConfig: probeConfigSchema.optional(),
      }).superRefine((testCase, ctx) => {
        if (
          testCase.caseType !== "widget_probe" &&
          (testCase.query === undefined || testCase.query.length === 0)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["query"],
            message: "query is required for prompt cases",
          });
        }
      }),
    )
    .min(1)
    .max(MAX_V1_TESTS),
});

type CreateEvalSuiteBody = z.infer<typeof createEvalSuiteSchema>;

/**
 * Expand the ergonomic authoring tests into the full
 * `RunEvalsRequestSchema.shape.tests` element shape: fill `runs`, resolve
 * model/provider from suite defaults (deriving provider from a `provider/model`
 * id when neither is given), and normalize `expectedToolCalls` entries.
 */
function normalizeCreateTestsToRunTests(
  tests: CreateEvalSuiteBody["tests"],
  suite: { model: string; provider?: string },
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
        `Cannot derive a provider for test "${test.title}". Pass a suite-level "provider", a per-test "provider", or a "provider/model" id.`,
      );
    }
    const expectedToolCalls = (test.expectedToolCalls ?? []).map((el) =>
      typeof el === "string"
        ? { toolName: el, arguments: {} }
        : { toolName: el.toolName, arguments: el.arguments ?? {} },
    );
    return {
      title: test.title,
      // widget_probe rows are authored query-less; the run schema accepts "".
      query: test.query ?? "",
      runs,
      model,
      provider,
      expectedToolCalls,
      ...(test.expectedOutput !== undefined
        ? { expectedOutput: test.expectedOutput }
        : {}),
      ...(test.isNegativeTest !== undefined
        ? { isNegativeTest: test.isNegativeTest }
        : {}),
      ...(test.scenario !== undefined ? { scenario: test.scenario } : {}),
      ...(test.promptTurns !== undefined
        ? { promptTurns: test.promptTurns }
        : {}),
      ...(test.advancedConfig !== undefined
        ? { advancedConfig: test.advancedConfig }
        : {}),
      ...(test.matchOptions !== undefined
        ? { matchOptions: test.matchOptions }
        : {}),
      ...(test.predicates !== undefined ? { predicates: test.predicates } : {}),
      ...(test.caseType !== undefined ? { caseType: test.caseType } : {}),
      ...(test.probeConfig !== undefined
        ? { probeConfig: test.probeConfig }
        : {}),
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

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

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
    iteration.status === "cancelled";
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
  // re-validate against the source-of-truth schema (re-checks the
  // widget_probe ↔ probeConfig invariant the run path also enforces).
  // Use parseWithSchema so a second-stage failure (e.g. widget_probe without
  // probeConfig, or an invalid advancedConfig.toolChoice) surfaces as a 400
  // VALIDATION_ERROR rather than an uncaught ZodError → 500.
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
    { serverNames },
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
      201,
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

export default evals;
