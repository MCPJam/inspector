import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where a promoted case lands. The destination is shared by every promote
 * surface (User Testing, Swarms, Sessions, chat history, the per-turn
 * action), so the tab choice is tested here once rather than through each of
 * them.
 */

const { mockNavigateApp } = vi.hoisted(() => ({
  mockNavigateApp: vi.fn(),
}));

vi.mock("@/lib/app-navigation", () => ({
  navigateApp: (...args: unknown[]) => mockNavigateApp(...args),
  buildEvalsPath: (route: Record<string, unknown>) =>
    `/evals/suite/${route.suiteId}/test/${route.testId}/edit`,
  buildEvaluatePath: (route: Record<string, unknown>) =>
    `/evaluate/suite/${route.suiteId}/test/${route.testId}/edit`,
}));

import { navigateToPromotedTestCase } from "../promote-to-eval-navigation";

const TARGET = { suiteId: "suite-1", testCaseId: "case-1" };

describe("navigateToPromotedTestCase", () => {
  beforeEach(() => {
    mockNavigateApp.mockClear();
  });

  /**
   * Unconditional — not behind `evaluate-enabled`. Promoting used to drop the
   * user on `/evals`, the tab being retired; this is the assertion that keeps
   * a flag from creeping back in front of the destination.
   */
  it("opens the created case in the Evaluate redesign", () => {
    expect(navigateToPromotedTestCase(TARGET)).toBe(true);

    expect(mockNavigateApp).toHaveBeenCalledWith(
      "/evaluate/suite/suite-1/test/case-1/edit",
    );
  });

  it("does not navigate when the promote result has no ids", () => {
    expect(navigateToPromotedTestCase({ suiteId: "suite-1" })).toBe(false);
    expect(navigateToPromotedTestCase({ testCaseId: "case-1" })).toBe(false);
    expect(navigateToPromotedTestCase({ suiteId: " ", testCaseId: " " })).toBe(
      false,
    );
    expect(mockNavigateApp).not.toHaveBeenCalled();
  });
});
