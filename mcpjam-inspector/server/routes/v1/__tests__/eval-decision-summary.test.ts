/**
 * `GET …/eval-runs/:runId/decision-summary` — the canonical contract, end to end.
 *
 * The load-bearing claim is not that the route returns a body. It is that the
 * API's answer, a client-side assembly and the fixture corpus are ONE reading of
 * a run. So this test drives the real Hono route over CONVEX DOCUMENTS built to
 * project into each fixture's DTO input, and asserts the response equals the
 * `expected` block that `sdk/tests/eval-run-decision-summary.test.ts` asserts
 * the SDK assembler produces. Byte-equivalence between the two surfaces is then
 * a consequence rather than a claim.
 *
 * Driving it from documents also exercises the trust boundaries the route
 * depends on: `toRunVerdictProjection` refusing a decision that does not
 * validate, and `toStageProjection` quarantining a stage chain that does not.
 * A test that fed the route DTOs would prove the assembler works and nothing
 * about the boundary it is supposed to sit behind.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Hono } from "hono";
import Ajv2020 from "ajv/dist/2020.js";

const { validateGuestTokenMock, convexQueryMock } = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  convexQueryMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    mutation: vi.fn(),
    action: vi.fn(),
  })),
}));

import v1Routes from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(
    resolve(
      here,
      "../../../../../sdk/tests/fixtures/eval-run-decision-summary-fixtures.json"
    ),
    "utf8"
  )
) as {
  cases: Array<{
    __name: string;
    input: {
      projectId: string;
      run: Record<string, any>;
      iterations: Array<Record<string, any>>;
      page: { complete: boolean; nextCursor?: string };
    };
    expected: Record<string, unknown>;
  }>;
};

const BEARER = "caller-bearer-token";

/**
 * Turn a fixture's RUN DTO back into the Convex document it was projected from.
 *
 * Only the fields `toRunDto` reads. `verdictSummary` is placed on the document
 * unvalidated on purpose — `toRunVerdictProjection` is what decides whether it
 * reaches the DTO, and the "unreadable decision" fixture depends on that
 * decision being made by the boundary rather than by this helper.
 */
function runDoc(projectId: string, run: Record<string, any>) {
  return {
    _id: run.id,
    projectId,
    suiteId: "suite_1",
    runNumber: 1,
    status: run.status,
    result: run.result ?? null,
    summary: run.summary ?? null,
    source: "api",
    notes: null,
    createdAt: 1,
    completedAt: 2,
    ...(run.verdictPolicyVersion !== undefined
      ? { verdictPolicyVersion: run.verdictPolicyVersion }
      : {}),
    ...(run.verdictSummary !== undefined
      ? { verdictSummary: run.verdictSummary }
      : {}),
    ...(run.verdictPolicyIntegrityError !== undefined
      ? { verdictPolicyIntegrityError: run.verdictPolicyIntegrityError }
      : {}),
  };
}

/**
 * Turn a fixture's ITERATION DTO back into its document.
 *
 * `stageResultsUnverified: true` is NOT a stored field — it is what
 * `toStageProjection` emits when a stored derivation fails validation. So the
 * quarantine fixture is reproduced by storing rows that genuinely do not
 * validate (one row where the contract requires six, in chain order), which is
 * the only way to prove the boundary is doing the quarantining.
 */
function iterationDoc(runId: string, iteration: Record<string, any>) {
  const metadata: Record<string, unknown> = {};
  if (iteration.stageResultsUnverified === true) {
    metadata.stageResults = [{ stage: "call", state: "failed" }];
    metadata.stageAnalyzerVersion = iteration.stageAnalyzerVersion;
  } else if (iteration.stageResults !== undefined) {
    metadata.stageResults = iteration.stageResults;
    if (iteration.firstFailedStage !== undefined) {
      metadata.firstFailedStage = iteration.firstFailedStage;
    }
    if (iteration.failureCategory !== undefined) {
      metadata.failureCategory = iteration.failureCategory;
    }
    metadata.stageAnalyzerVersion = iteration.stageAnalyzerVersion;
  }
  return {
    _id: iteration.id,
    suiteRunId: runId,
    testCaseId: iteration.testCaseId ?? null,
    testCaseSnapshot: {
      title: iteration.title ?? null,
      ...(iteration.caseId ? { caseId: iteration.caseId } : {}),
      expectedToolCalls: iteration.expectedToolCalls ?? [],
    },
    iterationNumber: iteration.iterationNumber,
    status: iteration.status,
    result: iteration.result ?? null,
    actualToolCalls: iteration.actualToolCalls ?? [],
    error: iteration.error ?? null,
    startedAt: 1,
    updatedAt: 2,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function request(path: string): Promise<Response> {
  return makeApp().request(`/api/v1${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${BEARER}` },
  });
}

function stubCorpusRow(row: (typeof corpus.cases)[number]): void {
  const { projectId, run, iterations, page } = row.input;
  const doc = runDoc(projectId, run);
  const docs = iterations.map((iteration) => iterationDoc(run.id, iteration));
  convexQueryMock.mockImplementation((name: string) => {
    if (name === "testSuites:getTestSuiteRun") return Promise.resolve(doc);
    if (name === "testSuites:listTestSuiteRunIterations") {
      return Promise.resolve({
        page: docs,
        isDone: page.nextCursor === undefined,
        continueCursor: page.nextCursor ?? "",
      });
    }
    return Promise.resolve(null);
  });
}

beforeEach(() => {
  vi.stubEnv("CONVEX_URL", "https://example.convex.cloud");
  validateGuestTokenMock.mockResolvedValue({ valid: false });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET …/eval-runs/:runId/decision-summary", () => {
  for (const row of corpus.cases) {
    it(`${row.__name}: matches the shared golden corpus`, async () => {
      stubCorpusRow(row);
      const res = await request(
        `/projects/${row.input.projectId}/eval-runs/${row.input.run.id}/decision-summary`
      );
      expect(res.status).toBe(200);
      // Equal to the SAME object the SDK assembler is asserted to produce in
      // sdk/tests/eval-run-decision-summary.test.ts. That is the parity claim.
      expect(await res.json()).toEqual(row.expected);
    });
  }

  it("admits a guest the way the run and its iterations already do", async () => {
    // Guests can GET `/eval-runs/:id` and `/iterations`. This route composes
    // those two reads; omitting it from the allowlist 401s the Evaluate
    // verdict cell as LOAD FAILED while RATE still renders. GET-only so a
    // later write at the same URL stays default-denied.
    const { isGuestAllowedV1Request } = await import(
      "../guest-allowed-paths.js"
    );
    const path = `/api/v1/projects/${corpus.cases[0]!.input.projectId}/eval-runs/${
      corpus.cases[0]!.input.run.id
    }/decision-summary`;
    expect(isGuestAllowedV1Request("GET", path)).toBe(true);
    expect(isGuestAllowedV1Request("POST", path)).toBe(false);

    stubCorpusRow(corpus.cases[0]!);
    validateGuestTokenMock.mockResolvedValue({
      valid: true,
      guestId: "guest_abc",
    });
    const res = await makeApp().request(
      `/api/v1/projects/${corpus.cases[0]!.input.projectId}/eval-runs/${
        corpus.cases[0]!.input.run.id
      }/decision-summary`,
      {
        method: "GET",
        headers: { Authorization: "Bearer guest_bearer" },
      }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(corpus.cases[0]!.expected);
  });

  it("refuses a run from another project as NOT_FOUND", async () => {
    stubCorpusRow(corpus.cases[0]!);
    const res = await request(
      `/projects/some-other-project/eval-runs/${
        corpus.cases[0]!.input.run.id
      }/decision-summary`
    );
    expect(res.status).toBe(404);
  });

  it("marks a cursor-fetched page incomplete even when it is the last one", async () => {
    // The permissive mistake this guards: `isDone` alone reads a cursor's final
    // page as the run's complete failure list, when the caller has already
    // skipped everything before it.
    const row = corpus.cases.find(
      (entry) => entry.__name === "policyV2-passing"
    )!;
    stubCorpusRow(row);
    const res = await request(
      `/projects/${row.input.projectId}/eval-runs/${row.input.run.id}/decision-summary?cursor=page-2`
    );
    const body = (await res.json()) as any;
    expect(body.diagnostics.complete).toBe(false);
    expect(body.diagnostics.nextCursor).toBeUndefined();
  });

  it("passes the caller's page size through to the iteration read", async () => {
    const row = corpus.cases[0]!;
    stubCorpusRow(row);
    await request(
      `/projects/${row.input.projectId}/eval-runs/${row.input.run.id}/decision-summary?limit=7`
    );
    expect(convexQueryMock).toHaveBeenCalledWith(
      "testSuites:listTestSuiteRunIterations",
      { runId: row.input.run.id, paginationOpts: { numItems: 7, cursor: null } }
    );
  });

  it("clamps an out-of-range page size instead of refusing", async () => {
    const row = corpus.cases[0]!;
    stubCorpusRow(row);
    await request(
      `/projects/${row.input.projectId}/eval-runs/${row.input.run.id}/decision-summary?limit=9999`
    );
    expect(convexQueryMock).toHaveBeenCalledWith(
      "testSuites:listTestSuiteRunIterations",
      expect.objectContaining({
        paginationOpts: { numItems: 200, cursor: null },
      })
    );
  });
});

describe("the iteration DTO's declared case id", () => {
  it("projects testCaseSnapshot.caseId beside the stored row id", async () => {
    const row = corpus.cases.find(
      (entry) => entry.__name === "policyV2-passing"
    )!;
    stubCorpusRow(row);
    const res = await request(
      `/projects/${row.input.projectId}/eval-runs/${row.input.run.id}/iterations`
    );
    const body = (await res.json()) as any;
    expect(body.items[0].caseId).toBe("c_alpha");
    // The two identities stay apart: one is the author's durable name for the
    // case, the other is this deployment's row id.
    expect(body.items[0].testCaseId).toBe("row-1");
  });

  it("OMITS it, rather than nulling it, when the snapshot has none", async () => {
    // Every iteration predating declared ids, and every UI-authored case, is in
    // this shape — so the field must be additive for them, not a new `null`.
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getTestSuiteRun") {
        return Promise.resolve(
          runDoc("p1", { id: "run-1", status: "completed" })
        );
      }
      if (name === "testSuites:listTestSuiteRunIterations") {
        return Promise.resolve({
          page: [
            {
              _id: "it-1",
              suiteRunId: "run-1",
              testCaseId: "row-1",
              testCaseSnapshot: { title: "no declared id" },
              iterationNumber: 1,
              status: "completed",
              result: "passed",
            },
          ],
          isDone: true,
          continueCursor: "",
        });
      }
      return Promise.resolve(null);
    });
    const res = await request(`/projects/p1/eval-runs/run-1/iterations`);
    const body = (await res.json()) as any;
    expect("caseId" in body.items[0]).toBe(false);
  });
});

/**
 * The OpenAPI document describes the SAME wire the route serves.
 *
 * `openapi-drift` compares paths and methods and never opens a schema;
 * `openapi-types-parity` compares the spec against the SDK's `platform/types.ts`
 * interfaces, and this contract's SDK type is a zod-inferred alias in
 * `@mcpjam/sdk/contract` rather than an interface there, so it is outside that
 * ratchet's reach. Validating real responses against the published schema is
 * the stronger check anyway: it compares the document to what the endpoint
 * actually emits, not to a second hand-written description of it.
 */
describe("openapi describes what the route returns", () => {
  const spec = JSON.parse(
    readFileSync(
      resolve(here, "../../../../../docs/reference/openapi.json"),
      "utf8"
    )
  ) as { components: { schemas: Record<string, unknown> } };

  // `ajv/dist/2020` is CJS; under Node's ESM interop the class arrives on
  // `.default` in some resolutions and directly in others.
  const Ajv = ((Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ??
    Ajv2020) as typeof Ajv2020;
  const ajv = new Ajv({ strict: false, logger: false });
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    ajv.addSchema(schema as object, `#/components/schemas/${name}`);
  }
  const validate = ajv.getSchema(
    "#/components/schemas/EvalRunDecisionSummary"
  )!;

  for (const row of corpus.cases) {
    it(`${row.__name}: validates against the published schema`, async () => {
      stubCorpusRow(row);
      const res = await request(
        `/projects/${row.input.projectId}/eval-runs/${row.input.run.id}/decision-summary`
      );
      const body = await res.json();
      const ok = validate(body);
      expect(ok ? [] : validate.errors).toEqual([]);
    });
  }

  it("documents the additive declared case id on the iteration schema", () => {
    const iteration = spec.components.schemas.EvalIteration as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(iteration.properties.caseId).toBeDefined();
    // ADDITIVE: never required, so every existing row still validates.
    expect(iteration.required).not.toContain("caseId");
  });
});
