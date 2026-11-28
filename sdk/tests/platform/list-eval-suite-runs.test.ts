import { describe, expect, it, vi } from "vitest";
import {
  listEvalSuiteRunsOperation,
  PlatformApiClient,
  PlatformApiError,
} from "../../src/platform/index.js";

const PROJECT = {
  id: "project-1",
  name: "Dogfood",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 1,
};

function suite(id: string, latestRunAt: number | null, updatedAt: number) {
  return {
    id,
    name: id.toUpperCase(),
    projectId: PROJECT.id,
    createdAt: 1,
    updatedAt,
    latestRun:
      latestRunAt === null
        ? null
        : {
            id: `${id}-latest`,
            status: "completed",
            passRate: 1,
            passed: 1,
            failed: 0,
            createdAt: latestRunAt,
          },
    totals: { passed: 1, failed: 0, runs: 1 },
    passRateTrend: [1],
  };
}

function run(id: string, status: string, createdAt: number) {
  const finished = status === "completed";
  return {
    id,
    suiteId: "suite-a",
    runNumber: createdAt,
    status,
    result: finished ? "passed" : "pending",
    summary: finished ? { total: 1, passed: 1, failed: 0, passRate: 1 } : null,
    source: "api",
    notes: null,
    createdAt,
    completedAt: finished ? createdAt + 1 : null,
  };
}

/** A client whose suite listing and run history are the given rows. */
function makeClient(suites: unknown[], runs: ReturnType<typeof run>[]) {
  const fetchMock = vi.fn<typeof fetch>(async (target) => {
    const url = new URL(String(target));
    if (url.pathname === "/api/v1/projects") {
      return Response.json({ items: [PROJECT] });
    }
    if (/\/eval-suites$/.test(url.pathname)) {
      return Response.json({ items: suites });
    }
    if (/\/eval-suites\/[^/]+\/runs$/.test(url.pathname)) {
      const limit = Number(url.searchParams.get("limit") ?? 25);
      return Response.json({ items: runs.slice(0, limit) });
    }
    return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_test",
    fetch: fetchMock,
  });
  const runCalls = () =>
    fetchMock.mock.calls
      .map(([target]) => new URL(String(target)))
      .filter((url) => url.pathname.endsWith("/runs"));
  return { client, runCalls };
}

describe("listEvalSuiteRunsOperation without a suite", () => {
  it("lists the suite holding the project's most recent run", async () => {
    const { client, runCalls } = makeClient(
      [
        suite("suite-a", 10, 50),
        suite("suite-b", 30, 5),
        suite("suite-c", null, 99),
      ],
      [run("r1", "completed", 30)]
    );

    const input = listEvalSuiteRunsOperation.inputSchema.parse({ limit: 1 });
    const result = await listEvalSuiteRunsOperation.execute(input, { client });

    expect(result.suite).toEqual({ id: "suite-b", name: "SUITE-B" });
    expect(runCalls()[0]?.pathname).toContain("/eval-suites/suite-b/runs");
  });

  it("falls back to the most recently updated suite when none has run", async () => {
    const { client } = makeClient(
      [suite("suite-a", null, 5), suite("suite-b", null, 9)],
      []
    );

    const result = await listEvalSuiteRunsOperation.execute({}, { client });

    expect(result.suite.id).toBe("suite-b");
    expect(result.items).toEqual([]);
    expect(result).not.toHaveProperty("latestFinishedRun");
  });

  it("says so when the project has no suites", async () => {
    const { client } = makeClient([], []);

    const error = await listEvalSuiteRunsOperation
      .execute({}, { client })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).code).toBe("NOT_FOUND");
    expect((error as PlatformApiError).message).toBe(
      'Project "Dogfood" has no eval suites.'
    );
  });
});

describe("listEvalSuiteRunsOperation latestFinishedRun", () => {
  const history = [
    run("r3", "running", 30),
    run("r2", "grading", 20),
    run("r1", "completed", 10),
  ];

  it("adds the newest finished run when every listed run is still going", async () => {
    const { client, runCalls } = makeClient([suite("suite-a", 30, 1)], history);

    const result = await listEvalSuiteRunsOperation.execute(
      { suite: "suite-a", limit: 1 },
      { client }
    );

    expect(result.items.map((item) => item.id)).toEqual(["r3"]);
    expect(result.latestFinishedRun?.id).toBe("r1");
    expect(runCalls().map((url) => url.searchParams.get("limit"))).toEqual([
      "1",
      "25",
    ]);
  });

  it("omits it when a listed run has finished", async () => {
    const { client, runCalls } = makeClient([suite("suite-a", 30, 1)], history);

    const result = await listEvalSuiteRunsOperation.execute(
      { suite: "suite-a", limit: 3 },
      { client }
    );

    expect(result).not.toHaveProperty("latestFinishedRun");
    expect(runCalls()).toHaveLength(1);
  });

  it("is null without a second request when the page already holds every run", async () => {
    const { client, runCalls } = makeClient(
      [suite("suite-a", 30, 1)],
      history.slice(0, 2)
    );

    const result = await listEvalSuiteRunsOperation.execute(
      { suite: "suite-a" },
      { client }
    );

    expect(result.latestFinishedRun).toBeNull();
    expect(runCalls()).toHaveLength(1);
  });
});
