import { describe, expect, it } from "vitest";
import {
  fitWidgetModelContext,
  upsertWidgetModelContextEntry,
} from "../widget-model-context";
import type { WidgetModelContextEntry } from "@/shared/chat-v2";
import { PLUGIN_CONTEXT_NOT_PERSISTED_MESSAGE } from "@/shared/plugin-model-context";
import { WIDGET_MODEL_CONTEXT_MAX_JSON_BYTES } from "@/shared/widget-model-context-limits";

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

const refusal = (queue: WidgetModelContextEntry[], context: object) => {
  try {
    upsertWidgetModelContextEntry(queue, "call-1", context);
  } catch (error) {
    return error;
  }
};

describe("upsertWidgetModelContextEntry within one chat request", () => {
  it("queues an image, audio clip or binary resource without its bytes", () => {
    const bytes = "A".repeat(2_000_000);
    const queue = upsertWidgetModelContextEntry([], "call-1", {
      content: [
        { type: "image", mimeType: "image/png", data: bytes },
        { type: "audio", mimeType: "audio/wav", data: bytes },
        {
          type: "resource",
          resource: {
            uri: "file:///part.stl",
            mimeType: "model/stl",
            blob: bytes,
          },
        },
        { type: "text", text: "part" },
      ] as never,
    });
    expect(queue[0].context.content).toEqual([
      { type: "image", mimeType: "image/png" },
      { type: "audio", mimeType: "audio/wav" },
      {
        type: "resource",
        resource: { uri: "file:///part.stl", mimeType: "model/stl" },
      },
      { type: "text", text: "part" },
    ]);
  });

  it("refuses an update past an entry's caps, keeping the App's last one", () => {
    const queue = upsertWidgetModelContextEntry([], "call-1", {
      structuredContent: { v: 1 },
    });
    expect(
      refusal(queue, {
        structuredContent: {
          v: "x".repeat(WIDGET_MODEL_CONTEXT_MAX_JSON_BYTES),
        },
      }),
    ).toMatchObject({
      code: -32000,
      message: PLUGIN_CONTEXT_NOT_PERSISTED_MESSAGE,
    });
    expect(
      refusal(queue, {
        content: Array.from({ length: 33 }, () => ({
          type: "text",
          text: "x",
        })),
      }),
    ).toMatchObject({ code: -32000 });
    expect(queue).toEqual([
      { toolCallId: "call-1", context: { structuredContent: { v: 1 } } },
    ]);
  });

  it("refuses the entry that would take the whole queue past one request", () => {
    let queue: WidgetModelContextEntry[] = [];
    const add = (toolCallId: string) => {
      queue = upsertWidgetModelContextEntry(queue, toolCallId, {
        structuredContent: { v: "x".repeat(60 * 1024) },
      });
    };
    for (const id of ["a", "b", "c", "d"]) add(id);
    expect(() => add("e")).toThrow(PLUGIN_CONTEXT_NOT_PERSISTED_MESSAGE);
    expect(queue.map((entry) => entry.toolCallId)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});

describe("fitWidgetModelContext", () => {
  it("sends the newest entries that fit when two queues go as one", () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      toolCallId: `call-${i}`,
      context: { structuredContent: { i } },
    }));
    expect(fitWidgetModelContext(entries)).toEqual(entries.slice(8));
  });
});
