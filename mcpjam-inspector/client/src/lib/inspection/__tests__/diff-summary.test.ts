import { describe, it, expect } from "vitest";
import type { ServerInspectionDiff } from "../types";
import { formatDiffSummary } from "../diff-summary";

function makeDiff(
  overrides: Partial<ServerInspectionDiff> = {},
): ServerInspectionDiff {
  return {
    initChanges: [],
    toolChanges: [],
    computedAt: Date.now(),
    ...overrides,
  };
}

describe("formatDiffSummary", () => {
  it("returns empty string for empty diff", () => {
    expect(formatDiffSummary(makeDiff())).toBe("");
  });

  it("formats singular tool added", () => {
    expect(
      formatDiffSummary(
        makeDiff({ toolChanges: [{ type: "added", name: "t" }] }),
      ),
    ).toBe("1 tool added");
  });

  it("formats plural tools added", () => {
    expect(
      formatDiffSummary(
        makeDiff({
          toolChanges: [
            { type: "added", name: "a" },
            { type: "added", name: "b" },
          ],
        }),
      ),
    ).toBe("2 tools added");
  });

  it("formats removed tools", () => {
    expect(
      formatDiffSummary(
        makeDiff({ toolChanges: [{ type: "removed", name: "t" }] }),
      ),
    ).toBe("1 tool removed");
  });

  it("formats changed tools", () => {
    expect(
      formatDiffSummary(
        makeDiff({
          toolChanges: [
            { type: "changed", name: "a", changedFields: ["description"] },
            { type: "changed", name: "b", changedFields: ["inputSchema"] },
          ],
        }),
      ),
    ).toBe("2 tools changed");
  });

  it("formats init changes with field names", () => {
    expect(
      formatDiffSummary(
        makeDiff({
          initChanges: [
            { field: "instructions", before: "a", after: "b" },
          ],
        }),
      ),
    ).toBe("instructions updated");
  });

  it("formats multiple init changes", () => {
    expect(
      formatDiffSummary(
        makeDiff({
          initChanges: [
            { field: "protocolVersion", before: "1", after: "2" },
            { field: "serverCapabilities", before: {}, after: { tools: {} } },
          ],
        }),
      ),
    ).toBe("protocol version, capabilities updated");
  });

  it("combines tool and init changes", () => {
    const result = formatDiffSummary(
      makeDiff({
        toolChanges: [
          { type: "added", name: "a" },
          { type: "added", name: "b" },
          { type: "removed", name: "c" },
          { type: "changed", name: "d", changedFields: ["description"] },
        ],
        initChanges: [
          { field: "instructions", before: "old", after: "new" },
        ],
      }),
    );
    expect(result).toBe(
      "2 tools added, 1 tool removed, 1 tool changed, instructions updated",
    );
  });

  it("formats only init changes", () => {
    expect(
      formatDiffSummary(
        makeDiff({
          initChanges: [
            { field: "transport", before: "stdio", after: "http" },
          ],
        }),
      ),
    ).toBe("transport updated");
  });
});
