import { describe, expect, it } from "vitest";
import { getPlaygroundCasesRedirect } from "../playground-route-preferences";

const defaultParams = {
  exploreSuiteId: "suite-1",
  isSuiteDetailsLoading: false,
  isSuiteRunsLoading: false,
  testCaseIds: ["case-1"],
  runIds: ["run-1"],
  iterationRunIds: ["run-1"],
};

describe("getPlaygroundCasesRedirect", () => {
  it("redirects the list route to the cases overview", () => {
    expect(
      getPlaygroundCasesRedirect({
        ...defaultParams,
        route: { type: "list" },
      }),
    ).toEqual({
      type: "suite-overview",
      suiteId: "suite-1",
      view: "test-cases",
    });
  });

  it("redirects a stale test-edit route from another suite", () => {
    expect(
      getPlaygroundCasesRedirect({
        ...defaultParams,
        route: {
          type: "test-edit",
          suiteId: "suite-old",
          testId: "case-old",
          openCompare: true,
        },
      }),
    ).toEqual({
      type: "suite-overview",
      suiteId: "suite-1",
      view: "test-cases",
    });
  });

  it("redirects a stale test-detail route from another suite", () => {
    expect(
      getPlaygroundCasesRedirect({
        ...defaultParams,
        route: {
          type: "test-detail",
          suiteId: "suite-old",
          testId: "case-old",
        },
      }),
    ).toEqual({
      type: "suite-overview",
      suiteId: "suite-1",
      view: "test-cases",
    });
  });

  it("redirects a stale run-detail route from another suite", () => {
    expect(
      getPlaygroundCasesRedirect({
        ...defaultParams,
        route: {
          type: "run-detail",
          suiteId: "suite-old",
          runId: "run-old",
        },
      }),
    ).toEqual({
      type: "suite-overview",
      suiteId: "suite-1",
      view: "test-cases",
    });
  });

  it("keeps a valid same-suite test-edit route", () => {
    expect(
      getPlaygroundCasesRedirect({
        ...defaultParams,
        route: {
          type: "test-edit",
          suiteId: "suite-1",
          testId: "case-1",
          openCompare: true,
        },
      }),
    ).toBeNull();
  });

  it("redirects missing same-suite test routes after details load", () => {
    expect(
      getPlaygroundCasesRedirect({
        ...defaultParams,
        route: {
          type: "test-detail",
          suiteId: "suite-1",
          testId: "case-missing",
        },
      }),
    ).toEqual({
      type: "suite-overview",
      suiteId: "suite-1",
      view: "test-cases",
    });
  });

  it("waits for suite details before rejecting a same-suite test route", () => {
    expect(
      getPlaygroundCasesRedirect({
        ...defaultParams,
        isSuiteDetailsLoading: true,
        route: {
          type: "test-edit",
          suiteId: "suite-1",
          testId: "case-missing",
        },
      }),
    ).toBeNull();
  });

  it("waits for suite runs before rejecting a same-suite run route", () => {
    expect(
      getPlaygroundCasesRedirect({
        ...defaultParams,
        isSuiteRunsLoading: true,
        route: {
          type: "run-detail",
          suiteId: "suite-1",
          runId: "run-missing",
        },
      }),
    ).toBeNull();
  });

  it("keeps a same-suite run route when iterations still reference that run", () => {
    expect(
      getPlaygroundCasesRedirect({
        ...defaultParams,
        runIds: [],
        iterationRunIds: ["run-older"],
        route: {
          type: "run-detail",
          suiteId: "suite-1",
          runId: "run-older",
        },
      }),
    ).toBeNull();
  });

  it("keeps the runs view as-is — all suite-overview views render the same dashboard", () => {
    expect(
      getPlaygroundCasesRedirect({
        ...defaultParams,
        route: {
          type: "suite-overview",
          suiteId: "suite-1",
          view: "runs",
        },
      }),
    ).toBeNull();
  });

  it("keeps the cases view as-is", () => {
    expect(
      getPlaygroundCasesRedirect({
        ...defaultParams,
        route: {
          type: "suite-overview",
          suiteId: "suite-1",
          view: "test-cases",
        },
      }),
    ).toBeNull();
  });

  it("keeps the executions view as-is", () => {
    expect(
      getPlaygroundCasesRedirect({
        ...defaultParams,
        route: {
          type: "suite-overview",
          suiteId: "suite-1",
          view: "executions",
        },
      }),
    ).toBeNull();
  });
});
