/**
 * `get_eval_run` hands a model the canonical decision summary.
 *
 * D9's parity claim covers the Platform MCP server too: what a model reads
 * about a finished run must be the SAME object the API returns and the CLI
 * renders, not a reshaping of it. So this asserts the operation returns a
 * corpus fixture verbatim rather than merely returning "something summary-ish".
 *
 * The other half is that adding it cannot break the read. An API deployment
 * that predates the endpoint answers 404, and a run polled mid-flight has no
 * verdict to summarize — in both cases the RUN is still the resource, and
 * failing the read because an optional diagnostic was unavailable would be a
 * strictly worse trade.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  getEvalRunOperation,
  PlatformApiClient,
} from "../../src/platform/index.js";
import type { EvalRunDecisionSummary } from "../../src/contract/index.js";

const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../fixtures/eval-run-decision-summary-fixtures.json",
        import.meta.url
      )
    ),
    "utf8"
  )
) as { cases: Array<{ __name: string; expected: EvalRunDecisionSummary }> };

const SUMMARY = corpus.cases.find(
  (row) => row.__name === "measured-failure-at-every-stage"
)!.expected;

const PROJECTS = [{ id: "project-1", name: "Acme", slug: "acme" }];

function makeClient(
  options: {
    runStatus?: string;
    summaryStatus?: number;
  } = {}
) {
  const fetchMock = vi.fn(async (target: unknown) => {
    const url = new URL(String(target));
    if (url.pathname === "/api/v1/projects") {
      return Response.json({ items: PROJECTS });
    }
    if (url.pathname === "/api/v1/projects/project-1/eval-runs/run-1") {
      return Response.json({
        id: "run-1",
        suiteId: "suite-1",
        runNumber: 1,
        status: options.runStatus ?? "completed",
        result: "failed",
        summary: null,
        source: "api",
        notes: null,
        createdAt: 1,
        completedAt: 2,
      });
    }
    if (
      url.pathname ===
      "/api/v1/projects/project-1/eval-runs/run-1/decision-summary"
    ) {
      if (options.summaryStatus && options.summaryStatus !== 200) {
        return Response.json(
          { error: { code: "NOT_FOUND", message: "no such route" } },
          { status: options.summaryStatus }
        );
      }
      return Response.json(SUMMARY);
    }
    if (
      url.pathname ===
      "/api/v1/projects/project-1/eval-runs/run-1/iterations"
    ) {
      return Response.json({ items: [] });
    }
    return Response.json(
      { error: { code: "NOT_FOUND", message: url.pathname } },
      { status: 404 }
    );
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_test",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

function summaryCalls(fetchMock: ReturnType<typeof vi.fn>): URL[] {
  return fetchMock.mock.calls
    .map(([target]) => new URL(String(target)))
    .filter((url) => url.pathname.endsWith("/decision-summary"));
}

describe("get_eval_run — decision summary", () => {
  it("returns the canonical object VERBATIM, without reshaping it", async () => {
    const { client } = makeClient();
    const result = await getEvalRunOperation.execute(
      { project: "project-1", runId: "run-1" },
      { client }
    );
    // Deep equality against the shared corpus is the parity assertion: the same
    // bytes the API route test asserts the endpoint returns.
    expect(result.decisionSummary).toEqual(SUMMARY);
  });

  it("does not fetch one for a run that is still going", async () => {
    // A running run has no verdict yet, so the request would buy a
    // `notEstablished` the poller already knows from `status`.
    const { client, fetchMock } = makeClient({ runStatus: "running" });
    const result = await getEvalRunOperation.execute(
      { project: "project-1", runId: "run-1" },
      { client }
    );
    expect(result.decisionSummary).toBeUndefined();
    expect(summaryCalls(fetchMock)).toHaveLength(0);
  });

  it("falls back to the shared assembler when the endpoint is absent", async () => {
    const { client } = makeClient({ summaryStatus: 404 });
    const result = await getEvalRunOperation.execute(
      { project: "project-1", runId: "run-1" },
      { client }
    );
    expect(result.run.id).toBe("run-1");
    expect(result.decisionSummary).toMatchObject({
      runId: "run-1",
      verdict: "failed",
      verdictSource: "legacy",
      diagnostics: {
        items: [],
        complete: true,
        scannedIterations: 0,
      },
    });
  });

  it("asks for a small diagnostics page by default", async () => {
    // Each diagnostic carries a six-row chain; a model that spent its window on
    // page one of a 200-trial run has no room left to act on it.
    const { client, fetchMock } = makeClient();
    await getEvalRunOperation.execute(
      { project: "project-1", runId: "run-1" },
      { client }
    );
    expect(summaryCalls(fetchMock)[0]?.searchParams.get("limit")).toBe("20");
  });

  it("forwards an explicit diagnostics cursor and page size", async () => {
    const { client, fetchMock } = makeClient();
    await getEvalRunOperation.execute(
      {
        project: "project-1",
        runId: "run-1",
        diagnosticsCursor: "page-2",
        diagnosticsLimit: 5,
      },
      { client }
    );
    const call = summaryCalls(fetchMock)[0]!;
    expect(call.searchParams.get("cursor")).toBe("page-2");
    expect(call.searchParams.get("limit")).toBe("5");
  });

  it("keeps the old input shape working", async () => {
    // The pagination knobs are ADDITIVE and optional: a caller that has only
    // ever sent `{project, runId}` must not start failing validation.
    expect(
      getEvalRunOperation.inputSchema.safeParse({
        project: "project-1",
        runId: "run-1",
      }).success
    ).toBe(true);
  });

  it("tells the model to read the summary first, and what its counts count", () => {
    const description = getEvalRunOperation.description;
    expect(description).toContain("decisionSummary");
    expect(description).toContain("measurementUnit");
    // `notEstablished` must be described as an absence, never as a failure.
    expect(description).toContain("it is not a failure");
  });
});
