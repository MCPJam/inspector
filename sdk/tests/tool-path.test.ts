import { describe, expect, it } from "vitest";
import {
  NO_TOOL_PATH_KEY,
  PATH_SEPARATOR,
  buildPathKey,
  collapseImmediateRepeats,
  toolNamesFromPathKey,
} from "../src/contract/tool-path.js";

describe("tool-path", () => {
  it("collapses immediate repeats so search,search,get becomes search→get", () => {
    expect(collapseImmediateRepeats(["search", "search", "get"])).toEqual([
      "search",
      "get",
    ]);
    expect(buildPathKey(["search", "search", "get"])).toBe(
      `search${PATH_SEPARATOR}get`
    );
  });

  it("keeps a genuine revisit (search→get→search)", () => {
    expect(buildPathKey(["search", "get", "search"])).toBe(
      `search${PATH_SEPARATOR}get${PATH_SEPARATOR}search`
    );
  });

  it("uses the no-tools sentinel for an empty sequence", () => {
    expect(buildPathKey([])).toBe(NO_TOOL_PATH_KEY);
    expect(toolNamesFromPathKey(NO_TOOL_PATH_KEY)).toEqual([]);
  });

  it("recovers distinct names from a pathKey", () => {
    expect(toolNamesFromPathKey(`search${PATH_SEPARATOR}get`)).toEqual([
      "search",
      "get",
    ]);
  });
});
