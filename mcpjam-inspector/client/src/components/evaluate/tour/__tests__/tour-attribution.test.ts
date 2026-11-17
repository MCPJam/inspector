import { describe, expect, it } from "vitest";
import {
  markSuiteCreatedFromTour,
  takeFirstRunAfterTour,
} from "../tour-attribution";

describe("tour attribution", () => {
  it("credits the tour with only the first run of a suite it created", () => {
    markSuiteCreatedFromTour("suite-a");

    expect(takeFirstRunAfterTour("suite-b")).toBe(false);
    expect(takeFirstRunAfterTour("suite-a")).toBe(true);
    expect(takeFirstRunAfterTour("suite-a")).toBe(false);
  });
});
