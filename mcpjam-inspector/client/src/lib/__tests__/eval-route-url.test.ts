import { describe, expect, it } from "vitest";
import {
  buildEvalsRunsPath,
  buildEvalsPath,
  buildEvaluatePath,
} from "../app-navigation";
import { parseEvalRouteFromUrl } from "../eval-route-url";
import { legacyEvalRouteFor } from "../eval-nav-routes";
import type { EvalNavRoute } from "../eval-route-types";

describe("eval-route-url", () => {
  it("preserves the originating case checks when opening suite evaluators", () => {
    const route = {
      type: "suite-edit" as const,
      suiteId: "suite-1",
      fromCaseChecks: "case-1",
    };
    const [path, search] = buildEvaluatePath(route).split("?");
    expect(parseEvalRouteFromUrl("/evaluate", path, `?${search}`)).toEqual(
      route,
    );
  });
  it("roundtrips the case UVC checks page", () => {
    const route = {
      type: "test-edit" as const,
      suiteId: "suite-1",
      testId: "case-1",
      checks: true,
    };
    const url = buildEvalsPath(route);
    const [path, search] = url.split("?");
    expect(url).toContain("checks=1");
    expect(parseEvalRouteFromUrl("/evaluate", path, `?${search}`)).toEqual(
      route,
    );
  });
  it("parses eval list and create routes", () => {
    expect(parseEvalRouteFromUrl("/evals", "/evals")).toEqual({
      type: "list",
    });
    expect(parseEvalRouteFromUrl("/evals/runs", "evals/runs")).toEqual({
      type: "list",
    });
    expect(parseEvalRouteFromUrl("/evals", "/evals/create")).toEqual({
      type: "create",
    });
  });

  it("parses suite overview routes and query views", () => {
    expect(parseEvalRouteFromUrl("/evals", "/evals/suite/s_123")).toEqual({
      type: "suite-overview",
      suiteId: "s_123",
      view: "runs",
    });
    expect(
      parseEvalRouteFromUrl("/evals", "/evals/suite/s_123", "?view=runs"),
    ).toEqual({
      type: "suite-overview",
      suiteId: "s_123",
      view: "runs",
    });
    expect(
      parseEvalRouteFromUrl(
        "/evals",
        "/evals/suite/s_123",
        "?view=test-cases&fromCommit=abc123",
      ),
    ).toEqual({
      type: "suite-overview",
      suiteId: "s_123",
      view: "test-cases",
      fromCommit: "abc123",
    });
    expect(
      parseEvalRouteFromUrl("/evals", "/evals/suite/s_123", "?view=cross-host"),
    ).toEqual({
      type: "suite-overview",
      suiteId: "s_123",
      view: "cross-host",
    });
  });

  it("builds eval suite overview routes", () => {
    expect(buildEvalsPath({ type: "list" })).toBe("/evals");
    expect(buildEvalsPath({ type: "create" })).toBe("/evals/create");
    expect(
      buildEvalsPath({
        type: "suite-overview",
        suiteId: "s_abc",
        view: "executions",
      }),
    ).toBe("/evals/suite/s_abc?view=executions");
    expect(
      buildEvalsPath({
        type: "suite-overview",
        suiteId: "s_abc",
        fromCommit: "manual-xyz",
      }),
    ).toBe("/evals/suite/s_abc?fromCommit=manual-xyz");
  });

  it("round-trips the import review link an API import hands back", () => {
    // `reviewUrl` in an import reply is this link. It has to survive the trip
    // through the URL, because the person opening it is often not the one who
    // ran the import — and their browser holds none of those drafts.
    const route = {
      type: "suite-overview",
      suiteId: "s_abc",
      importJob: "job_77",
    } as const;
    expect(buildEvalsPath(route)).toBe("/evals/suite/s_abc?importJob=job_77");
    expect(
      parseEvalRouteFromUrl(
        "/evals",
        "/evals/suite/s_abc",
        "?importJob=job_77",
      ),
    ).toEqual({ ...route, view: "runs" });
  });

  it("parses run detail query state", () => {
    expect(
      parseEvalRouteFromUrl(
        "/evals",
        "/evals/suite/s_123/runs/r_456",
        "?iteration=i_1&insights=1",
      ),
    ).toEqual({
      type: "run-detail",
      suiteId: "s_123",
      runId: "r_456",
      iteration: "i_1",
      insightsFocus: true,
    });
    expect(
      parseEvalRouteFromUrl(
        "/evals",
        "/evals/suite/s_123/runs/r_456",
        "?compareTo=r_123",
      ),
    ).toEqual({
      type: "run-detail",
      suiteId: "s_123",
      runId: "r_456",
      iteration: undefined,
      compareToRunId: "r_123",
    });
    expect(
      parseEvalRouteFromUrl(
        "/evals",
        "/evals/suite/s_123/runs/r_456",
        "?case=tc_789",
      ),
    ).toEqual({
      type: "run-detail",
      suiteId: "s_123",
      runId: "r_456",
      iteration: undefined,
      testCaseId: "tc_789",
    });
  });

  it("builds run detail query state", () => {
    expect(
      buildEvalsPath({
        type: "run-detail",
        suiteId: "s_abc",
        runId: "r_def",
        iteration: "i_3",
        insightsFocus: true,
        compareToRunId: "r_base",
      }),
    ).toBe(
      "/evals/suite/s_abc/runs/r_def?iteration=i_3&insights=1&compareTo=r_base",
    );
  });

  it("parses test detail, test edit, and suite edit routes", () => {
    expect(
      parseEvalRouteFromUrl(
        "/evals",
        "/evals/suite/s_123/test/t_789",
        "?iteration=i_2",
      ),
    ).toEqual({
      type: "test-detail",
      suiteId: "s_123",
      testId: "t_789",
      iteration: "i_2",
    });
    expect(
      parseEvalRouteFromUrl("/evals", "/evals/suite/s_123/test/t_789/edit"),
    ).toEqual({
      type: "test-edit",
      suiteId: "s_123",
      testId: "t_789",
    });
    expect(
      parseEvalRouteFromUrl(
        "/evals",
        "/evals/suite/s_123/test/t_789/edit",
        "?compare=1",
      ),
    ).toEqual({
      type: "test-edit",
      suiteId: "s_123",
      testId: "t_789",
      openCompare: true,
    });
    expect(
      parseEvalRouteFromUrl(
        "/evals",
        "/evals/suite/s_123/test/t_789/edit",
        "?compare=true&iteration=i_42",
      ),
    ).toEqual({
      type: "test-edit",
      suiteId: "s_123",
      testId: "t_789",
      openCompare: true,
      iteration: "i_42",
    });
    expect(parseEvalRouteFromUrl("/evals", "/evals/suite/s_123/edit")).toEqual({
      type: "suite-edit",
      suiteId: "s_123",
    });
  });

  it("builds test edit compare routes", () => {
    expect(
      buildEvalsPath({
        type: "test-edit",
        suiteId: "s_abc",
        testId: "t_def",
        openCompare: true,
        iteration: "i_42",
      }),
    ).toBe("/evaluate/suite/s_abc/test/t_def/edit?compare=1&iteration=i_42");
    expect(
      buildEvaluatePath({
        type: "test-edit",
        suiteId: "preview:asana:create-and-assign",
        testId: "case-create-task",
        fromEvalServer: "srv-a",
      }),
    ).toBe(
      "/evaluate/suite/preview%3Aasana%3Acreate-and-assign/test/case-create-task/edit?fromEvalServer=srv-a",
    );
  });

  it("parses a first-run return onto today's case editor", () => {
    expect(
      parseEvalRouteFromUrl(
        "/evaluate",
        "/evaluate/suite/preview%3Aasana%3Acreate-and-assign/test/case-create-task/edit",
        "?fromEvalServer=srv-a",
      ),
    ).toEqual({
      type: "test-edit",
      suiteId: "preview:asana:create-and-assign",
      testId: "case-create-task",
      fromEvalServer: "srv-a",
    });
  });

  it("parses runs-mode commit detail query state", () => {
    expect(
      parseEvalRouteFromUrl(
        "/evals/runs",
        "/evals/runs/commit/abc1234567890",
        "?suite=s_abc&iteration=i_4",
      ),
    ).toEqual({
      type: "commit-detail",
      commitSha: "abc1234567890",
      suite: "s_abc",
      iteration: "i_4",
    });
  });

  it("builds runs-mode commit detail and suite routes", () => {
    expect(
      buildEvalsRunsPath({
        type: "commit-detail",
        commitSha: "abc1234567890",
        suite: "s_abc",
        iteration: "i_4",
      }),
    ).toBe("/evals/runs/commit/abc1234567890?suite=s_abc&iteration=i_4");
    expect(
      buildEvalsRunsPath({
        type: "suite-overview",
        suiteId: "s_abc",
        view: "test-cases",
        fromCommit: "sha9abcdef",
      }),
    ).toBe("/evals/runs/suite/s_abc?view=test-cases&fromCommit=sha9abcdef");
  });

  it("parses runs-mode suite drill-down paths", () => {
    expect(
      parseEvalRouteFromUrl(
        "/evals/runs",
        "/evals/runs/suite/s_123/test/t_789/edit",
        "?compare=1",
      ),
    ).toEqual({
      type: "test-edit",
      suiteId: "s_123",
      testId: "t_789",
      openCompare: true,
    });
  });

  it("returns null outside the requested prefix", () => {
    expect(
      parseEvalRouteFromUrl("/evals/runs", "/evals/suite/s_123"),
    ).toBeNull();
  });

  it("keeps the two modes mutually exclusive under the shared /evals root", () => {
    // Runs lives inside Suites' path space, so Suites must NOT swallow a Runs
    // URL as a bare list route — that would render the wrong lens instead of
    // letting the Runs route match.
    expect(parseEvalRouteFromUrl("/evals", "/evals/runs")).toBeNull();
    expect(
      parseEvalRouteFromUrl("/evals", "/evals/runs/suite/s_123"),
    ).toBeNull();
    expect(
      parseEvalRouteFromUrl("/evals", "/evals/runs/commit/abc123"),
    ).toBeNull();
  });

  it("degrades a commit route built in Suites mode to that mode's list", () => {
    // Commits are a Runs-only lens; Suites has no cross-suite SHA view.
    expect(
      buildEvalsPath({ type: "commit-detail", commitSha: "abc1234567890" }),
    ).toBe("/evals");
  });

  it("keeps /evaluate and /evals from parsing each other's URLs", () => {
    // The flag-gated Evaluate (New) tab is a SIBLING of /evals, not a
    // sub-tree: `/evaluate` does not start with `/evals/`, and `/evals` does
    // not start with `/evaluate/`. If either prefix ever swallowed the
    // other's URLs, one tab would silently render the other's routes.
    expect(parseEvalRouteFromUrl("/evals", "/evaluate")).toBeNull();
    expect(parseEvalRouteFromUrl("/evals", "/evaluate/suite/s_123")).toBeNull();
    expect(parseEvalRouteFromUrl("/evaluate", "/evals")).toBeNull();
    expect(parseEvalRouteFromUrl("/evaluate", "/evals/runs")).toBeNull();

    expect(parseEvalRouteFromUrl("/evaluate", "/evaluate")).toEqual({
      type: "list",
    });
    expect(parseEvalRouteFromUrl("/evaluate", "/evaluate/create")).toEqual({
      type: "create",
    });
    expect(
      parseEvalRouteFromUrl("/evaluate", "/evaluate/eval-server/srv-a"),
    ).toEqual({
      type: "eval-server",
      serverId: "srv-a",
    });
    expect(parseEvalRouteFromUrl("/evals", "/evals/eval-server/srv-a")).toEqual(
      { type: "list" },
    );
    expect(
      parseEvalRouteFromUrl("/evaluate", "/evaluate/suite/s_123/runs/r_9"),
    ).toEqual({
      type: "run-detail",
      suiteId: "s_123",
      runId: "r_9",
      iteration: undefined,
      testCaseId: undefined,
    });
  });

  it("builds /evaluate paths and degrades its commit route to the list", () => {
    expect(buildEvaluatePath({ type: "list" })).toBe("/evaluate");
    expect(buildEvaluatePath({ type: "create" })).toBe("/evaluate/create");
    expect(buildEvaluatePath({ type: "eval-server", serverId: "srv-a" })).toBe(
      "/evaluate/eval-server/srv-a",
    );
    expect(buildEvalsPath({ type: "eval-server", serverId: "srv-a" })).toBe(
      "/evals",
    );
    expect(
      buildEvaluatePath({ type: "suite-overview", suiteId: "s_123" }),
    ).toBe("/evaluate/suite/s_123");
    // Commits are a Runs-mode lens; Evaluate (New) has no cross-suite SHA view.
    expect(
      buildEvaluatePath({ type: "commit-detail", commitSha: "abc1234567890" }),
    ).toBe("/evaluate");
  });

  it("roundtrips the dedicated run comparison page", () => {
    // The route this asserts is the one EBB-14 was: both halves of the
    // round-trip have always worked, and the URL still 404'd because the
    // router never registered the path. `route-elements-coverage.test.ts`
    // guards that half; this one guards the string.
    const route = {
      type: "run-detail" as const,
      suiteId: "s_1",
      runId: "r_1",
      comparison: true,
    };
    const path = buildEvaluatePath(route);
    expect(path).toBe("/evaluate/suite/s_1/runs/r_1/compare");
    expect(parseEvalRouteFromUrl("/evaluate", path)).toEqual({
      ...route,
      iteration: undefined,
      testCaseId: undefined,
    });
    // Without the trailing segment it is the plain run page, not a compare.
    expect(
      parseEvalRouteFromUrl("/evaluate", "/evaluate/suite/s_1/runs/r_1"),
    ).not.toHaveProperty("comparison");
  });

  it("decodes path params", () => {
    expect(
      parseEvalRouteFromUrl("/evals", "/evals/suite/suite%20one/test/case%202"),
    ).toEqual({
      type: "test-detail",
      suiteId: "suite one",
      testId: "case 2",
      iteration: undefined,
    });
  });
});

describe("per-layer Evaluate routes", () => {
  const routes: Array<[string, EvalNavRoute]> = [
    ["/evaluate/runs", { type: "evaluate-runs" }],
    [
      "/evaluate/suite/s1/settings",
      { type: "suite-settings", suiteId: "s1", tab: "settings" },
    ],
    [
      "/evaluate/suite/s1/settings/cases",
      { type: "suite-settings", suiteId: "s1", tab: "cases" },
    ],
    [
      "/evaluate/suite/s1/settings/evaluators",
      { type: "suite-settings", suiteId: "s1", tab: "evaluators" },
    ],
    [
      "/evaluate/suite/s1/settings/cases/new",
      { type: "case-new", suiteId: "s1" },
    ],
    [
      "/evaluate/suite/s1/settings/cases/c1",
      { type: "case-settings", suiteId: "s1", testCaseId: "c1" },
    ],
    [
      "/evaluate/suite/s1/settings/cases/c1/evaluators",
      { type: "case-evaluators", suiteId: "s1", testCaseId: "c1" },
    ],
    [
      "/evaluate/suite/s1/runs/r1/cases/c1",
      { type: "test-run", suiteId: "s1", runId: "r1", testCaseId: "c1" },
    ],
    [
      "/evaluate/suite/s1/runs/r1/cases/c1/edit",
      { type: "test-run-edit", suiteId: "s1", runId: "r1", testCaseId: "c1" },
    ],
    [
      "/evaluate/suite/s1/runs/r1/cases/c1/iter/i1",
      {
        type: "iteration",
        suiteId: "s1",
        runId: "r1",
        testCaseId: "c1",
        iterationId: "i1",
      },
    ],
  ];

  it.each(routes)("parses %s bare and under a project", (path, route) => {
    expect(parseEvalRouteFromUrl("/evaluate", path)).toEqual(route);
    expect(parseEvalRouteFromUrl("/evaluate", `/p/k57aaaaaaaaaaaaaaaaaaaaaaaaa${path}`)).toEqual(
      route,
    );
  });

  it.each(routes)("builds %s and round-trips it", (path, route) => {
    expect(buildEvaluatePath(route)).toBe(path);
    expect(parseEvalRouteFromUrl("/evaluate", buildEvaluatePath(route))).toEqual(
      route,
    );
  });

  it("decodes encoded ids and encodes them back", () => {
    const route: EvalNavRoute = {
      type: "iteration",
      suiteId: "a/b",
      runId: "r 1",
      testCaseId: "c?1",
      iterationId: "i#1",
    };
    const path = buildEvaluatePath(route);
    expect(path).toBe(
      "/evaluate/suite/a%2Fb/runs/r%201/cases/c%3F1/iter/i%231",
    );
    expect(parseEvalRouteFromUrl("/evaluate", path)).toEqual(route);
    expect(
      parseEvalRouteFromUrl("/evaluate", "/evaluate/suite/a%2Fb/settings/cases/x%2Fy"),
    ).toEqual({ type: "case-settings", suiteId: "a/b", testCaseId: "x/y" });
  });

  it("carries ?target= on a test run in both directions", () => {
    const route: EvalNavRoute = {
      type: "test-run",
      suiteId: "s1",
      runId: "r1",
      testCaseId: "c1",
      target: "openai/gpt 5",
    };
    const url = buildEvaluatePath(route);
    expect(url).toBe("/evaluate/suite/s1/runs/r1/cases/c1?target=openai%2Fgpt+5");
    const [path, search] = url.split("?");
    expect(parseEvalRouteFromUrl("/evaluate", path, `?${search}`)).toEqual(route);
    expect(
      parseEvalRouteFromUrl("/evaluate", "/evaluate/suite/s1/runs/r1/cases/c1"),
    ).not.toHaveProperty("target");
  });

  it("ignores other query params on the new kinds", () => {
    expect(
      parseEvalRouteFromUrl(
        "/evaluate",
        "/evaluate/suite/s1/runs/r1/cases/c1/iter/i1",
        "?target=m&case=x&iteration=y",
      ),
    ).toEqual({
      type: "iteration",
      suiteId: "s1",
      runId: "r1",
      testCaseId: "c1",
      iterationId: "i1",
    });
  });

  it("reads settings/cases/new as the create page, never a case id", () => {
    expect(
      parseEvalRouteFromUrl("/evaluate", "/evaluate/suite/s1/settings/cases/new"),
    ).toEqual({ type: "case-new", suiteId: "s1" });
  });

  it.each([
    "/evaluate/runs/x",
    "/evaluate/suite/s1/settings/foo",
    "/evaluate/suite/s1/settings/cases/new/evaluators",
    "/evaluate/suite/s1/settings/cases/c1/foo",
    "/evaluate/suite/s1/settings/evaluators/x",
    "/evaluate/suite/s1/runs/r1/cases",
    "/evaluate/suite/s1/runs/r1/cases/c1/foo",
    "/evaluate/suite/s1/runs/r1/cases/c1/iter",
    "/evaluate/suite/s1/runs/r1/cases/c1/iter/i1/x",
  ])("parses unknown path %s as the list", (path) => {
    expect(parseEvalRouteFromUrl("/evaluate", path)).toEqual({ type: "list" });
  });

  it.each(routes)("keeps today's result for %s under /evals", (path) => {
    for (const prefix of ["/evals", "/evals/runs"] as const) {
      const legacyPath = path.replace(/^\/evaluate/, prefix);
      const parsed = parseEvalRouteFromUrl(prefix, legacyPath);
      expect(parsed?.type === "list" || parsed === null).toBe(true);
    }
  });

  it("parses today's run, edit and checks forms exactly as before", () => {
    expect(
      parseEvalRouteFromUrl(
        "/evaluate",
        "/evaluate/suite/s1/runs/r1",
        "?case=c1&iteration=i1",
      ),
    ).toEqual({
      type: "run-detail",
      suiteId: "s1",
      runId: "r1",
      testCaseId: "c1",
      iteration: "i1",
    });
    expect(
      parseEvalRouteFromUrl("/evaluate", "/evaluate/suite/s1/edit"),
    ).toEqual({ type: "suite-edit", suiteId: "s1" });
    expect(
      parseEvalRouteFromUrl(
        "/evaluate",
        "/evaluate/suite/s1/test/c1/edit",
        "?checks=1",
      ),
    ).toEqual({ type: "test-edit", suiteId: "s1", testId: "c1", checks: true });
  });

  it.each(routes)("degrades %s to today's page on /evals builders", (_, route) => {
    expect(buildEvalsPath(route)).toBe(buildEvalsPath(legacyEvalRouteFor(route)));
    expect(buildEvalsRunsPath(route)).toBe(
      buildEvalsRunsPath(legacyEvalRouteFor(route)),
    );
    expect(buildEvalsPath(route)).not.toMatch(/\/settings|\/cases\/|\/iter\//);
  });
});
