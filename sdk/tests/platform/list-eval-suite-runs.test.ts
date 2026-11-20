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

function run(
  id: string,
  status: string,
  createdAt: number,
  suiteId = "suite-a"
) {
  const finished = status === "completed";
  return {
    id,
    suiteId,
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

/**
 * A client whose suite listing and run history are the given rows. Runs are
 * served for whichever suite the request names, so a history spread over
 * several suites is filtered by `suiteId`.
 */
function makeClient(suites: unknown[], allRuns: ReturnType<typeof run>[]) {
  const fetchMock = vi.fn<typeof fetch>(async (target) => {
    const url = new URL(String(target));
    if (url.pathname === "/api/v1/projects") {
      return Response.json({ items: [PROJECT] });
    }
    if (/\/eval-suites$/.test(url.pathname)) {
      return Response.json({ items: suites });
    }
    const runsOf = /\/eval-suites\/([^/]+)\/runs$/.exec(url.pathname);
    if (runsOf) {
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const runs = allRuns.filter(
        (item) => item.suiteId === decodeURIComponent(runsOf[1])
      );
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
      [run("r1", "completed", 30, "suite-b")]
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

describe("listEvalSuiteRunsOperation latestFinishedRun across suites", () => {
  function runningSuite(id: string, latestRunAt: number, updatedAt = 1) {
    const row = suite(id, latestRunAt, updatedAt);
    return { ...row, latestRun: { ...row.latestRun!, status: "running" } };
  }

  it("looks in the project's other suites when the newest run's suite has no finished run", async () => {
    // A new suite's first run is the newest in the project and still going;
    // the last verdict is in another suite.
    const { client, runCalls } = makeClient(
      [runningSuite("suite-new", 50), suite("suite-old", 40, 1)],
      [
        run("first", "running", 50, "suite-new"),
        run("verdict", "completed", 40, "suite-old"),
      ]
    );

    const result = await listEvalSuiteRunsOperation.execute({}, { client });

    expect(result.suite.id).toBe("suite-new");
    expect(result.items.map((item) => item.id)).toEqual(["first"]);
    expect(result.latestFinishedRun?.id).toBe("verdict");
    expect(result.latestFinishedRunSuite).toEqual({
      id: "suite-old",
      name: "SUITE-OLD",
    });
    expect(runCalls().map((url) => url.pathname.split("/")[6])).toEqual([
      "suite-new",
      "suite-old",
    ]);
  });

  it("stays inside a suite the caller named", async () => {
    const { client, runCalls } = makeClient(
      [runningSuite("suite-new", 50), suite("suite-old", 40, 1)],
      [
        run("first", "running", 50, "suite-new"),
        run("verdict", "completed", 40, "suite-old"),
      ]
    );

    const result = await listEvalSuiteRunsOperation.execute(
      { suite: "suite-new" },
      { client }
    );

    expect(result.latestFinishedRun).toBeNull();
    expect(result).not.toHaveProperty("latestFinishedRunSuite");
    expect(runCalls()).toHaveLength(1);
  });

  it("takes the newest finished run and stops once no other suite can beat it", async () => {
    // suite-b's latest run is going, but an earlier one finished at 45. No run
    // in suite-c (latest 30) or suite-d (latest 20) can be newer, so neither
    // is read.
    const { client, runCalls } = makeClient(
      [
        runningSuite("suite-a", 60),
        suite("suite-c", 30, 1),
        runningSuite("suite-b", 55),
        suite("suite-d", 20, 1),
      ],
      [
        run("a-first", "running", 60, "suite-a"),
        run("b-going", "running", 55, "suite-b"),
        run("b-done", "completed", 45, "suite-b"),
        run("c-done", "completed", 30, "suite-c"),
        run("d-done", "completed", 20, "suite-d"),
      ]
    );

    const result = await listEvalSuiteRunsOperation.execute({}, { client });

    expect(result.latestFinishedRun?.id).toBe("b-done");
    expect(result.latestFinishedRunSuite?.id).toBe("suite-b");
    expect(runCalls().map((url) => url.pathname.split("/")[6])).toEqual([
      "suite-a",
      "suite-b",
    ]);
  });

  it("is null when no suite in the project has a finished run", async () => {
    const { client } = makeClient(
      [runningSuite("suite-new", 50), runningSuite("suite-other", 40)],
      [
        run("first", "running", 50, "suite-new"),
        run("other", "running", 40, "suite-other"),
      ]
    );

    const result = await listEvalSuiteRunsOperation.execute({}, { client });

    expect(result.latestFinishedRun).toBeNull();
    expect(result).not.toHaveProperty("latestFinishedRunSuite");
  });
});
