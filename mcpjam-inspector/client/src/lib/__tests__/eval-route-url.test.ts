import { describe, expect, it } from "vitest";
import { buildCiEvalsPath, buildEvalsPath } from "../app-navigation";
import { parseEvalRouteFromUrl } from "../eval-route-url";

describe("eval-route-url", () => {
  it("parses eval list and create routes", () => {
    expect(parseEvalRouteFromUrl("/evals", "/evals")).toEqual({
      type: "list",
    });
    expect(parseEvalRouteFromUrl("/ci-evals", "ci-evals")).toEqual({
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
  });

  it("builds run detail query state", () => {
    expect(
      buildEvalsPath({
        type: "run-detail",
        suiteId: "s_abc",
        runId: "r_def",
        iteration: "i_3",
        insightsFocus: true,
      }),
    ).toBe("/evals/suite/s_abc/runs/r_def?iteration=i_3&insights=1");
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
      parseEvalRouteFromUrl(
        "/evals",
        "/evals/suite/s_123/test/t_789/edit",
      ),
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
    expect(
      parseEvalRouteFromUrl("/evals", "/evals/suite/s_123/edit"),
    ).toEqual({
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
    ).toBe("/evals/suite/s_abc/test/t_def/edit?compare=1&iteration=i_42");
  });

  it("parses ci eval commit detail query state", () => {
    expect(
      parseEvalRouteFromUrl(
        "/ci-evals",
        "/ci-evals/commit/abc1234567890",
        "?suite=s_abc&iteration=i_4",
      ),
    ).toEqual({
      type: "commit-detail",
      commitSha: "abc1234567890",
      suite: "s_abc",
      iteration: "i_4",
    });
  });

  it("builds ci eval commit detail and suite routes", () => {
    expect(
      buildCiEvalsPath({
        type: "commit-detail",
        commitSha: "abc1234567890",
        suite: "s_abc",
        iteration: "i_4",
      }),
    ).toBe("/ci-evals/commit/abc1234567890?suite=s_abc&iteration=i_4");
    expect(
      buildCiEvalsPath({
        type: "suite-overview",
        suiteId: "s_abc",
        view: "test-cases",
        fromCommit: "sha9abcdef",
      }),
    ).toBe(
      "/ci-evals/suite/s_abc?view=test-cases&fromCommit=sha9abcdef",
    );
  });

  it("parses ci eval suite drill-down paths", () => {
    expect(
      parseEvalRouteFromUrl(
        "/ci-evals",
        "/ci-evals/suite/s_123/test/t_789/edit",
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
      parseEvalRouteFromUrl("/ci-evals", "/evals/suite/s_123"),
    ).toBeNull();
  });

  it("decodes path params", () => {
    expect(
      parseEvalRouteFromUrl(
        "/evals",
        "/evals/suite/suite%20one/test/case%202",
      ),
    ).toEqual({
      type: "test-detail",
      suiteId: "suite one",
      testId: "case 2",
      iteration: undefined,
    });
  });
});
