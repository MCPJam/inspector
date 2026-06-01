import { describe, expect, it } from "vitest";
import { upsertWidgetModelContextEntry } from "../widget-model-context";

describe("upsertWidgetModelContextEntry", () => {
  it("adds a context entry", () => {
    expect(
      upsertWidgetModelContextEntry([], "call-1", {
        content: [{ type: "text", text: "board: X________" }],
        structuredContent: { board: ["X", "", "", "", "", "", "", "", ""] },
      })
    ).toEqual([
      {
        toolCallId: "call-1",
        context: {
          content: [{ type: "text", text: "board: X________" }],
          structuredContent: {
            board: ["X", "", "", "", "", "", "", "", ""],
          },
        },
      },
    ]);
  });

  it("replaces an existing context for the same tool call", () => {
    const queue = upsertWidgetModelContextEntry([], "call-1", {
      structuredContent: { board: ["X"] },
    });

    expect(
      upsertWidgetModelContextEntry(queue, "call-1", {
        structuredContent: { board: ["X", "O"] },
      })
    ).toEqual([
      {
        toolCallId: "call-1",
        context: { structuredContent: { board: ["X", "O"] } },
      },
    ]);
  });

  it("removes an entry when the update has no usable context", () => {
    const queue = upsertWidgetModelContextEntry([], "call-1", {
      structuredContent: { board: ["X"] },
    });

    expect(upsertWidgetModelContextEntry(queue, "call-1", {})).toEqual([]);
  });
});
