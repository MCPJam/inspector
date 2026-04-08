import { describe, expect, it } from "vitest";
import { shouldAutoOpenPlaygroundCasesView } from "../playground-route-preferences";

describe("shouldAutoOpenPlaygroundCasesView", () => {
  it("opens cases when returning to the list route", () => {
    expect(
      shouldAutoOpenPlaygroundCasesView({
        route: { type: "list" },
        exploreSuiteId: "suite-1",
        isSuiteDetailsLoading: false,
        runsCount: 0,
      }),
    ).toBe(true);
  });

  it("opens cases when an explore suite has cases but no suite runs", () => {
    expect(
      shouldAutoOpenPlaygroundCasesView({
        route: {
          type: "suite-overview",
          suiteId: "suite-1",
          view: "runs",
        },
        exploreSuiteId: "suite-1",
        isSuiteDetailsLoading: false,
        runsCount: 0,
      }),
    ).toBe(true);
  });

  it("opens cases when an explore suite has no suite runs yet", () => {
    expect(
      shouldAutoOpenPlaygroundCasesView({
        route: {
          type: "suite-overview",
          suiteId: "suite-1",
          view: "runs",
        },
        exploreSuiteId: "suite-1",
        isSuiteDetailsLoading: false,
        runsCount: 0,
      }),
    ).toBe(true);
  });

  it("does not override the cases view once it is already selected", () => {
    expect(
      shouldAutoOpenPlaygroundCasesView({
        route: {
          type: "suite-overview",
          suiteId: "suite-1",
          view: "test-cases",
        },
        exploreSuiteId: "suite-1",
        isSuiteDetailsLoading: false,
        runsCount: 0,
      }),
    ).toBe(false);
  });

  it("does not redirect when suite runs exist", () => {
    expect(
      shouldAutoOpenPlaygroundCasesView({
        route: {
          type: "suite-overview",
          suiteId: "suite-1",
          view: "runs",
        },
        exploreSuiteId: "suite-1",
        isSuiteDetailsLoading: false,
        runsCount: 2,
      }),
    ).toBe(false);
  });
});
