import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ModelMessage } from "ai";
import {
  appendDedupedModelMessages,
  createOffsetInterval,
  evalTraceBlobV1Z,
  evalTraceSpanZ,
  normalizeFinishReason,
  normalizeSpanInterval,
  stepResultHasToolActivity,
} from "../eval-trace";

const __dirname = dirname(fileURLToPath(import.meta.url));
type FixtureRow = { label: string; value: Record<string, unknown> };
type Fixtures = { __readme: string; accept: FixtureRow[]; reject: FixtureRow[] };
const traceSpanFixtures: Fixtures = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures/trace-span-parity-fixtures.json"),
    "utf8",
  ),
);

describe("eval-trace helpers", () => {
  it("normalizeSpanInterval bumps zero-duration to 1ms", () => {
    expect(normalizeSpanInterval(5, 5)).toEqual({ startMs: 5, endMs: 6 });
    expect(normalizeSpanInterval(5, 3)).toEqual({ startMs: 5, endMs: 6 });
    expect(normalizeSpanInterval(5, 8)).toEqual({ startMs: 5, endMs: 8 });
  });

  it("createOffsetInterval uses runner-relative offsets", () => {
    const runStartedAt = 1000;
    expect(createOffsetInterval(runStartedAt, 1000, 1050)).toEqual({
      startMs: 0,
      endMs: 50,
    });
  });

  it("appendDedupedModelMessages dedupes by id and by json", () => {
    const acc: ModelMessage[] = [{ role: "user", content: "hi" }];
    appendDedupedModelMessages(acc, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok", id: "m1" } as ModelMessage,
    ]);
    expect(acc).toHaveLength(2);
    appendDedupedModelMessages(acc, [
      { role: "assistant", content: "ok", id: "m1" } as ModelMessage,
    ]);
    expect(acc).toHaveLength(2);
  });

  it("stepResultHasToolActivity detects tool arrays", () => {
    expect(stepResultHasToolActivity({})).toBe(false);
    expect(stepResultHasToolActivity({ toolCalls: [{}] })).toBe(true);
    expect(stepResultHasToolActivity({ dynamicToolResults: [{}] })).toBe(true);
  });

  it("evalTraceBlobV1Z accepts envelope shape", () => {
    const parsed = evalTraceBlobV1Z.parse({
      traceVersion: 1,
      messages: [],
      spans: [
        {
          id: "a",
          name: "Step 1",
          category: "step",
          startMs: 0,
          endMs: 10,
        },
      ],
    });
    expect(parsed.traceVersion).toBe(1);
    expect(parsed.spans).toHaveLength(1);
  });

  it("evalTraceBlobV1Z preserves optional rich span metadata", () => {
    const parsed = evalTraceBlobV1Z.parse({
      traceVersion: 1,
      messages: [],
      spans: [
        {
          id: "tool-1",
          parentId: "step-1",
          name: "search",
          category: "tool",
          startMs: 5,
          endMs: 20,
          promptIndex: 1,
          stepIndex: 2,
          status: "ok",
          toolCallId: "call-1",
          toolName: "search",
          serverId: "server-1",
          modelId: "gpt-4o",
          inputTokens: 11,
          outputTokens: 7,
          totalTokens: 18,
          messageStartIndex: 3,
          messageEndIndex: 4,
        },
      ],
    });

    expect(parsed.spans?.[0]).toEqual(
      expect.objectContaining({
        promptIndex: 1,
        stepIndex: 2,
        status: "ok",
        toolCallId: "call-1",
        toolName: "search",
        serverId: "server-1",
        modelId: "gpt-4o",
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        messageStartIndex: 3,
        messageEndIndex: 4,
      }),
    );
  });

  it("evalTraceBlobV1Z accepts widget snapshots", () => {
    const parsed = evalTraceBlobV1Z.parse({
      traceVersion: 1,
      messages: [],
      widgetSnapshots: [
        {
          toolCallId: "tool-1",
          toolName: "create_view",
          protocol: "mcp-apps",
          serverId: "server-1",
          resourceUri: "ui://widget/index.html",
          toolMetadata: {
            ui: {
              resourceUri: "ui://widget/index.html",
            },
          },
          widgetCsp: {
            connectDomains: ["https://example.com"],
          },
          widgetPermissions: {
            camera: true,
          },
          widgetPermissive: true,
          prefersBorder: true,
          widgetHtmlBlobId: "blob-1",
        },
      ],
    });

    expect(parsed.widgetSnapshots).toHaveLength(1);
    expect(parsed.widgetSnapshots?.[0]).toEqual(
      expect.objectContaining({
        toolCallId: "tool-1",
        toolName: "create_view",
        protocol: "mcp-apps",
        serverId: "server-1",
        resourceUri: "ui://widget/index.html",
        widgetHtmlBlobId: "blob-1",
      }),
    );
  });
});

describe("trace-span parity fixtures (inspector evalTraceSpanZ side)", () => {
  it("fixture file has accept + reject cohorts and a readme", () => {
    expect(typeof traceSpanFixtures.__readme).toBe("string");
    expect(traceSpanFixtures.accept.length).toBeGreaterThan(0);
    expect(traceSpanFixtures.reject.length).toBeGreaterThan(0);
  });

  for (const row of traceSpanFixtures.accept) {
    it(`accepts + preserves harness fields: ${row.label}`, () => {
      const parsed = evalTraceSpanZ.safeParse(row.value);
      if (!parsed.success) {
        throw new Error(
          `Expected accept for "${row.label}":\n${JSON.stringify(parsed.error.issues, null, 2)}`,
        );
      }
      // Harness metadata must round-trip through the Zod mirror unchanged.
      for (const field of [
        "finishReason",
        "provider",
        "responseId",
        "responseTimestamp",
        "ttfcMs",
      ] as const) {
        if (row.value[field] !== undefined) {
          expect((parsed.data as Record<string, unknown>)[field]).toEqual(
            row.value[field],
          );
        }
      }
    });
  }

  for (const row of traceSpanFixtures.reject) {
    it(`rejects: ${row.label}`, () => {
      expect(evalTraceSpanZ.safeParse(row.value).success).toBe(false);
    });
  }

  // Inspector-only: optional-field TYPE mismatches. The backend normalizer
  // leniently drops a bad optional, so these are NOT in the shared reject set;
  // the strict Zod mirror must still refuse them.
  it("rejects ttfcMs of the wrong type", () => {
    expect(
      evalTraceSpanZ.safeParse({
        id: "x",
        name: "LLM",
        category: "llm",
        startMs: 0,
        endMs: 1,
        ttfcMs: "240",
      }).success,
    ).toBe(false);
  });
});

describe("normalizeFinishReason", () => {
  it("folds raw provider aliases to the canonical vocabulary", () => {
    expect(normalizeFinishReason("content_filter")).toBe("content-filter");
    expect(normalizeFinishReason("max_tokens")).toBe("length");
    expect(normalizeFinishReason("end_turn")).toBe("stop");
    expect(normalizeFinishReason("tool_use")).toBe("tool-calls");
  });

  it("passes through already-canonical AI SDK values", () => {
    expect(normalizeFinishReason("length")).toBe("length");
    expect(normalizeFinishReason("content-filter")).toBe("content-filter");
    expect(normalizeFinishReason("stop")).toBe("stop");
  });

  it("returns undefined for missing/empty input (never fabricates)", () => {
    expect(normalizeFinishReason(undefined)).toBeUndefined();
    expect(normalizeFinishReason(null)).toBeUndefined();
    expect(normalizeFinishReason("   ")).toBeUndefined();
    expect(normalizeFinishReason(42)).toBeUndefined();
  });

  it("preserves debug fidelity for unrecognized values (lowercased)", () => {
    expect(normalizeFinishReason("SomethingNew")).toBe("somethingnew");
  });
});
