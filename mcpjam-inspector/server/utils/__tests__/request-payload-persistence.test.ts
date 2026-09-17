import { describe, expect, it } from "vitest";
import {
  capRequestPayloadsForPersist,
  MAX_PERSISTED_REQUEST_PAYLOAD_BYTES,
} from "../live-chat-trace-stream";
import {
  expandPersistedRequestPayloads,
  type LiveChatTraceRequestPayloadEntry,
} from "@/shared/live-chat-trace";

const entry = (
  stepIndex: number,
  text = "hello",
): LiveChatTraceRequestPayloadEntry => ({
  turnId: "turn",
  promptIndex: 0,
  stepIndex,
  payload: {
    system: "system",
    tools: {
      search: { name: "search", inputSchema: { $ref: "#/$defs/query" } },
    },
    messages: [{ role: "user", content: text }],
  },
});

describe("persisted request compaction", () => {
  it("deduplicates adjacent catalogs and expands changed tools without mutating live entries", () => {
    const entries = [
      entry(0),
      entry(1),
      entry(2),
      { ...entry(0), turnId: "next" },
    ];
    entries[2].payload.tools = {};
    const original = structuredClone(entries);
    const stored = capRequestPayloadsForPersist(entries);
    expect(stored[1].payload).not.toHaveProperty("system");
    expect(stored[1].inherits).toEqual({ system: true, tools: true });
    expect(stored[2].payload.tools).toEqual({});
    expect(stored[3].inherits).toBeUndefined();
    expect(
      expandPersistedRequestPayloads(stored).map((e) => e.payload),
    ).toEqual(entries.map((e) => e.payload));
    expect(entries).toEqual(original);
  });
  it("drops earliest messages first, accounts for UTF-8 bytes, and discloses truncation", () => {
    const stored = capRequestPayloadsForPersist([
      entry(0, "😀".repeat(530000)),
      entry(1),
    ]);
    expect(stored[0].payload.messages).toBeUndefined();
    expect(stored[0].messageCount).toBe(1);
    expect(stored[1].payload.messages).toEqual(entry(1).payload.messages);
    expect(stored.every((e) => e.truncated)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThanOrEqual(
      MAX_PERSISTED_REQUEST_PAYLOAD_BYTES,
    );
  });
  it("enforces the hard cap even when a tool catalog alone exceeds it", () => {
    const huge = entry(0);
    huge.payload.tools.search.description = "x".repeat(
      MAX_PERSISTED_REQUEST_PAYLOAD_BYTES,
    );
    const stored = capRequestPayloadsForPersist([
      huge,
      { ...huge, stepIndex: 1 },
    ]);
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThanOrEqual(
      MAX_PERSISTED_REQUEST_PAYLOAD_BYTES,
    );
    expect(stored.every((e) => e.truncated)).toBe(true);
  });
});
