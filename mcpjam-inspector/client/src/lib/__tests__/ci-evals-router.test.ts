import { describe, expect, it } from "vitest";
import {
  navigateToCiEvalsRoute,
  parseCiEvalsRoute,
} from "../ci-evals-router";

describe("ci-evals-router", () => {
  it("parses list route", () => {
    window.location.hash = "#/ci-evals";
    expect(parseCiEvalsRoute()).toEqual({ type: "list" });
  });

  it("parses suite overview with test-cases view", () => {
    window.location.hash = "#/ci-evals/suite/s_123?view=test-cases";
    expect(parseCiEvalsRoute()).toEqual({
      type: "suite-overview",
      suiteId: "s_123",
      view: "test-cases",
    });
  });

  it("parses run detail route with iteration query", () => {
    window.location.hash = "#/ci-evals/suite/s_123/runs/r_456?iteration=i_1";
    expect(parseCiEvalsRoute()).toEqual({
      type: "run-detail",
      suiteId: "s_123",
      runId: "r_456",
      iteration: "i_1",
    });
  });

  it("parses test detail route with iteration query", () => {
    window.location.hash = "#/ci-evals/suite/s_123/test/t_789?iteration=i_2";
    expect(parseCiEvalsRoute()).toEqual({
      type: "test-detail",
      suiteId: "s_123",
      testId: "t_789",
      iteration: "i_2",
    });
  });

  it("navigates to suite overview route", () => {
    navigateToCiEvalsRoute({ type: "suite-overview", suiteId: "s_abc" });
    expect(window.location.hash).toBe("#/ci-evals/suite/s_abc");
  });

  it("navigates to run detail route with iteration", () => {
    navigateToCiEvalsRoute({
      type: "run-detail",
      suiteId: "s_abc",
      runId: "r_def",
      iteration: "i_3",
    });
    expect(window.location.hash).toBe(
      "#/ci-evals/suite/s_abc/runs/r_def?iteration=i_3",
    );
  });

  it("returns null outside ci-evals routes", () => {
    window.location.hash = "#/evals";
    expect(parseCiEvalsRoute()).toBeNull();
  });
});
