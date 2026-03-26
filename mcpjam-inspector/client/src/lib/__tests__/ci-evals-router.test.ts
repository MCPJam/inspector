import { describe, expect, it, vi } from "vitest";
import { navigateToCiEvalsRoute, parseCiEvalsRoute } from "../ci-evals-router";

describe("ci-evals-router", () => {
  it("parses list route", () => {
    window.location.hash = "#/ci-evals";
    expect(parseCiEvalsRoute()).toEqual({ type: "list" });
  });

  it("parses create route", () => {
    window.location.hash = "#/ci-evals/create";
    expect(parseCiEvalsRoute()).toEqual({ type: "create" });
  });

  it("navigates to create route", () => {
    navigateToCiEvalsRoute({ type: "create" });
    expect(window.location.hash).toBe("#/ci-evals/create");
  });

  it("parses suite overview with test-cases view", () => {
    window.location.hash = "#/ci-evals/suite/s_123?view=test-cases";
    expect(parseCiEvalsRoute()).toEqual({
      type: "suite-overview",
      suiteId: "s_123",
      view: "test-cases",
    });
  });

  it("parses suite overview defaulting to runs when view is omitted", () => {
    window.location.hash = "#/ci-evals/suite/s_123";
    expect(parseCiEvalsRoute()).toEqual({
      type: "suite-overview",
      suiteId: "s_123",
      view: "runs",
    });
  });

  it("parses suite overview as runs for explicit view=runs", () => {
    window.location.hash = "#/ci-evals/suite/s_123?view=runs";
    expect(parseCiEvalsRoute()).toEqual({
      type: "suite-overview",
      suiteId: "s_123",
      view: "runs",
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

  it("parses suite edit route", () => {
    window.location.hash = "#/ci-evals/suite/s_123/edit";
    expect(parseCiEvalsRoute()).toEqual({
      type: "suite-edit",
      suiteId: "s_123",
    });
  });

  it("parses test edit route", () => {
    window.location.hash = "#/ci-evals/suite/s_123/test/t_789/edit";
    expect(parseCiEvalsRoute()).toEqual({
      type: "test-edit",
      suiteId: "s_123",
      testId: "t_789",
    });
  });

  it("navigates to suite overview route", () => {
    navigateToCiEvalsRoute({ type: "suite-overview", suiteId: "s_abc" });
    expect(window.location.hash).toBe("#/ci-evals/suite/s_abc");
  });

  it("navigates to suite overview with test-cases view query", () => {
    navigateToCiEvalsRoute({
      type: "suite-overview",
      suiteId: "s_abc",
      view: "test-cases",
    });
    expect(window.location.hash).toBe(
      "#/ci-evals/suite/s_abc?view=test-cases",
    );
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

  it("navigates to suite edit route", () => {
    navigateToCiEvalsRoute({ type: "suite-edit", suiteId: "s_abc" });
    expect(window.location.hash).toBe("#/ci-evals/suite/s_abc/edit");
  });

  it("navigates to test edit route", () => {
    navigateToCiEvalsRoute({
      type: "test-edit",
      suiteId: "s_abc",
      testId: "t_def",
    });
    expect(window.location.hash).toBe("#/ci-evals/suite/s_abc/test/t_def/edit");
  });

  it("parses commit detail route", () => {
    window.location.hash = "#/ci-evals/commit/abc1234567890";
    expect(parseCiEvalsRoute()).toEqual({
      type: "commit-detail",
      commitSha: "abc1234567890",
    });
  });

  it("navigates to commit detail route", () => {
    navigateToCiEvalsRoute({
      type: "commit-detail",
      commitSha: "abc1234567890",
    });
    expect(window.location.hash).toBe("#/ci-evals/commit/abc1234567890");
  });

  it("returns null outside ci-evals routes", () => {
    window.location.hash = "#/evals";
    expect(parseCiEvalsRoute()).toBeNull();
  });

  describe("replace navigation", () => {
    it("uses replaceState instead of setting hash when replace is true", () => {
      const replaceStateSpy = vi.spyOn(history, "replaceState");
      navigateToCiEvalsRoute(
        {
          type: "run-detail",
          suiteId: "s_abc",
          runId: "r_def",
          iteration: "i_1",
        },
        { replace: true },
      );
      expect(replaceStateSpy).toHaveBeenCalledWith(
        {},
        "",
        "/#/ci-evals/suite/s_abc/runs/r_def?iteration=i_1",
      );
      replaceStateSpy.mockRestore();
    });

    it("dispatches hashchange event when replace is true", () => {
      const handler = vi.fn();
      window.addEventListener("hashchange", handler);
      navigateToCiEvalsRoute(
        { type: "run-detail", suiteId: "s_abc", runId: "r_def" },
        { replace: true },
      );
      expect(handler).toHaveBeenCalledTimes(1);
      window.removeEventListener("hashchange", handler);
    });

    it("does not use replaceState when replace option is not set", () => {
      const replaceStateSpy = vi.spyOn(history, "replaceState");
      navigateToCiEvalsRoute({
        type: "run-detail",
        suiteId: "s_abc",
        runId: "r_def",
      });
      expect(replaceStateSpy).not.toHaveBeenCalled();
      replaceStateSpy.mockRestore();
    });
  });
});
