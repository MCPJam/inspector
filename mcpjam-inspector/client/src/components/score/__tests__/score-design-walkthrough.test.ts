import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isScoreDemoServerUrl,
  isScoreDesignWalkthrough,
  SCORE_DEMO_SERVER_URL,
} from "../score-design-walkthrough";

describe("score design walkthrough", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/embed/score");
  });

  it("recognizes the dummy host", () => {
    expect(isScoreDemoServerUrl(SCORE_DEMO_SERVER_URL)).toBe(true);
    expect(isScoreDemoServerUrl("https://mcp.excalidraw.com/mcp")).toBe(false);
  });

  it("walks through in DEV when the project is still missing", () => {
    expect(
      isScoreDesignWalkthrough("https://mcp.excalidraw.com/mcp", null),
    ).toBe(true);
    expect(
      isScoreDesignWalkthrough("https://mcp.excalidraw.com/mcp", "proj_1"),
    ).toBe(false);
  });

  it("walks through any URL when ?preview=1", () => {
    window.history.replaceState(null, "", "/embed/score?preview=1");
    expect(
      isScoreDesignWalkthrough("https://mcp.excalidraw.com/mcp", "proj_1"),
    ).toBe(true);
  });
});
