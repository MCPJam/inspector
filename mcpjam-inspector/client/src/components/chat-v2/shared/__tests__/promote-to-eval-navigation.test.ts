import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where a promoted case lands. The destination is shared by every promote
 * surface (User Testing, Swarms, Sessions, chat history, the per-turn
 * action), so the tab choice is tested here once rather than through each of
 * them.
 *
 * The builders are spied rather than stubbed into strings: the two facts this
 * helper owns are WHICH tab (`buildEvaluatePath`, not `buildEvalsPath`) and
 * WHICH route within it (`test-edit`, the editor). Asserting the finished URL
 * would only restate what `lib/__tests__/eval-route-url.test.ts` already
 * covers, and would pass even if the route type were wrong.
 */

const { mockNavigateApp, mockBuildEvaluatePath, mockBuildEvalsPath } =
  vi.hoisted(() => ({
    mockNavigateApp: vi.fn(),
    mockBuildEvaluatePath: vi.fn(() => "/evaluate/built-path"),
    mockBuildEvalsPath: vi.fn(() => "/evals/built-path"),
  }));

vi.mock("@/lib/app-navigation", () => ({
  navigateApp: (...args: unknown[]) => mockNavigateApp(...args),
  buildEvalsPath: (...args: unknown[]) => mockBuildEvalsPath(...args),
  buildEvaluatePath: (...args: unknown[]) => mockBuildEvaluatePath(...args),
}));

import { navigateToPromotedTestCase } from "../promote-to-eval-navigation";

const TARGET = { suiteId: "suite-1", testCaseId: "case-1" };

describe("navigateToPromotedTestCase", () => {
  beforeEach(() => {
    mockNavigateApp.mockClear();
    mockBuildEvaluatePath.mockClear();
    mockBuildEvalsPath.mockClear();
  });

  /**
   * Unconditional — not behind `evaluate-enabled`. Promoting used to drop the
   * user on `/evals`, the tab being retired; the `buildEvalsPath` assertion is
   * what keeps a flag from creeping back in front of the destination.
   */
  it("opens the created case in the Evaluate redesign", () => {
    expect(navigateToPromotedTestCase(TARGET)).toBe(true);

    expect(mockBuildEvaluatePath).toHaveBeenCalledWith({
      type: "test-edit",
      suiteId: "suite-1",
      testId: "case-1",
    });
    expect(mockBuildEvalsPath).not.toHaveBeenCalled();
    expect(mockNavigateApp).toHaveBeenCalledWith("/evaluate/built-path");
  });

  it("does not navigate when the promote result has no ids", () => {
    expect(navigateToPromotedTestCase({ suiteId: "suite-1" })).toBe(false);
    expect(navigateToPromotedTestCase({ testCaseId: "case-1" })).toBe(false);
    expect(navigateToPromotedTestCase({ suiteId: " ", testCaseId: " " })).toBe(
      false,
    );
    expect(mockBuildEvaluatePath).not.toHaveBeenCalled();
    expect(mockNavigateApp).not.toHaveBeenCalled();
  });
});
