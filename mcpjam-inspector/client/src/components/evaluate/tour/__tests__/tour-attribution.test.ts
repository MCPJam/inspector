import { describe, expect, it } from "vitest";
import {
  isAwaitingFirstRunAfterTour,
  markSuiteCreatedFromTour,
  projectHasNoRuns,
  takeFirstRunAfterTour,
} from "../tour-attribution";

describe("tour attribution", () => {
  it("credits the tour with only the first run of a suite it created", () => {
    markSuiteCreatedFromTour("suite-a");

    expect(takeFirstRunAfterTour("suite-b")).toBe(false);
    expect(takeFirstRunAfterTour("suite-a")).toBe(true);
    expect(takeFirstRunAfterTour("suite-a")).toBe(false);
  });

  it("keeps the credit when it's only checked, not taken", () => {
    markSuiteCreatedFromTour("suite-c");

    expect(isAwaitingFirstRunAfterTour("suite-c")).toBe(true);
    expect(isAwaitingFirstRunAfterTour("suite-c")).toBe(true);
    expect(takeFirstRunAfterTour("suite-c")).toBe(true);
    expect(isAwaitingFirstRunAfterTour("suite-c")).toBe(false);
  });

  it("offers the tour replay only once suites load and none has a run", () => {
    expect(projectHasNoRuns(true, [])).toBe(false);
    expect(projectHasNoRuns(false, [])).toBe(true);
    expect(projectHasNoRuns(false, [{ latestRun: null }])).toBe(true);
    expect(
      projectHasNoRuns(false, [{ latestRun: null }, { latestRun: {} }]),
    ).toBe(false);
  });
});
