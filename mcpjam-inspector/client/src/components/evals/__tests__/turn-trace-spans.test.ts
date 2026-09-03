import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { hydrateTurnTraceSpans } from "../turn-trace-spans";

/** A turn-relative span blob, exactly as a producer writes it: offsets from 0. */
function turnBlob(durationMs: number): EvalTraceSpan[] {
  return [
    {
      id: `step-${durationMs}`,
      name: "step",
      category: "step",
      startMs: 0,
      endMs: durationMs,
    },
    {
      id: `llm-${durationMs}`,
      name: "llm",
      category: "llm",
      startMs: 10,
      endMs: durationMs - 10,
    },
  ];
}

const originalFetch = global.fetch;

function mockBlobs(byUrl: Record<string, unknown>) {
  global.fetch = vi.fn(async (url: unknown) => {
    const body = byUrl[String(url)];
    if (body === undefined) {
      return { ok: false, status: 404, json: async () => null } as Response;
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

describe("hydrateTurnTraceSpans", () => {
  beforeEach(() => {
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("shifts each turn by its wall-clock distance from the session start", async () => {
    // Turn 1 at t=0 runs 5s; turn 2 starts 8s in — a 3s idle gap between them.
    mockBlobs({
      "blob://t1": turnBlob(5_000),
      "blob://t2": turnBlob(4_000),
    });

    const spans = await hydrateTurnTraceSpans([
      { startedAt: 1_000_000, spansBlobUrl: "blob://t1" },
      { startedAt: 1_008_000, spansBlobUrl: "blob://t2" },
    ]);

    const steps = spans.filter((span) => span.category === "step");
    expect(steps.map((span) => [span.startMs, span.endMs])).toEqual([
      [0, 5_000],
      [8_000, 12_000],
    ]);
    // The 3s the session spent idle between turns stays visible.
    expect(steps[1].startMs - steps[0].endMs).toBe(3_000);
  });

  it("no longer collapses every turn onto 0ms (BB-153)", async () => {
    mockBlobs({
      "blob://t1": turnBlob(33_000),
      "blob://t2": turnBlob(11_600),
      "blob://t3": turnBlob(14_600),
    });

    const spans = await hydrateTurnTraceSpans([
      { startedAt: 500, spansBlobUrl: "blob://t1" },
      { startedAt: 33_500, spansBlobUrl: "blob://t2" },
      { startedAt: 45_100, spansBlobUrl: "blob://t3" },
    ]);

    const startsAtZero = spans.filter((span) => span.startMs === 0);
    expect(startsAtZero).toHaveLength(1);
    expect(spans.every((span) => span.endMs >= span.startMs)).toBe(true);
  });

  it("anchors offset 0 at the earliest turn regardless of input order", async () => {
    mockBlobs({
      "blob://late": turnBlob(1_000),
      "blob://early": turnBlob(1_000),
    });

    const spans = await hydrateTurnTraceSpans([
      { startedAt: 2_000, spansBlobUrl: "blob://late" },
      { startedAt: 0, spansBlobUrl: "blob://early" },
    ]);

    expect(Math.min(...spans.map((span) => span.startMs))).toBe(0);
    expect(Math.max(...spans.map((span) => span.endMs))).toBe(3_000);
  });

  it("preserves every non-timing field on the span", async () => {
    mockBlobs({
      "blob://t1": [
        {
          id: "tool-1",
          name: "tools/call",
          category: "tool",
          startMs: 100,
          endMs: 900,
          toolName: "create_workflow",
          status: "error",
          mcpErrorCode: -32602,
        } satisfies EvalTraceSpan,
      ],
    });

    const [span] = await hydrateTurnTraceSpans([
      { startedAt: 5_000, spansBlobUrl: "blob://t1" },
    ]);

    expect(span).toMatchObject({
      id: "tool-1",
      toolName: "create_workflow",
      status: "error",
      mcpErrorCode: -32602,
      startMs: 100,
      endMs: 900,
    });
  });

  it("skips turns with no blob url, and keeps the rest correctly placed", async () => {
    mockBlobs({ "blob://t2": turnBlob(2_000) });

    const spans = await hydrateTurnTraceSpans([
      { startedAt: 0, spansBlobUrl: null },
      { startedAt: 6_000, spansBlobUrl: "blob://t2" },
    ]);

    // The missing turn still sets the session start, so turn 2 keeps its real
    // 6s offset instead of being pulled back to zero.
    const step = spans.find((span) => span.category === "step");
    expect(step).toMatchObject({ startMs: 6_000, endMs: 8_000 });
  });

  it("drops turns whose blob fails to load without shifting the others", async () => {
    mockBlobs({ "blob://ok": turnBlob(1_000) });

    const spans = await hydrateTurnTraceSpans([
      { startedAt: 0, spansBlobUrl: "blob://ok" },
      { startedAt: 4_000, spansBlobUrl: "blob://gone" },
    ]);

    expect(spans).toHaveLength(2);
    expect(Math.max(...spans.map((span) => span.endMs))).toBe(1_000);
  });

  it("tolerates a non-array blob body", async () => {
    mockBlobs({ "blob://weird": { spans: [] } });

    await expect(
      hydrateTurnTraceSpans([{ startedAt: 0, spansBlobUrl: "blob://weird" }]),
    ).resolves.toEqual([]);
  });

  it("returns an empty array for no turns and never calls fetch", async () => {
    mockBlobs({});
    await expect(hydrateTurnTraceSpans([])).resolves.toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("leaves already session-anchored blobs where they are", async () => {
    // Eval blobs are measured from the RUN start, and their rows carry a
    // persist-time `startedAt`. Rebasing them displaces every span by the
    // persist round-trip, which is a skew on a path that was correct before.
    mockBlobs({
      "blob-a": [
        { id: "a", name: "a", category: "step", startMs: 0, endMs: 100 },
      ],
      "blob-b": [
        { id: "b", name: "b", category: "step", startMs: 900, endMs: 1000 },
      ],
    });

    const spans = await hydrateTurnTraceSpans(
      [
        { startedAt: 5_000, spansBlobUrl: "blob-a" },
        { startedAt: 5_412, spansBlobUrl: "blob-b" },
      ],
      { sessionAnchored: true }
    );

    expect(spans.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 100],
      [900, 1000],
    ]);
  });

  it("still rebases when the caller does not claim session anchoring", async () => {
    mockBlobs({
      "blob-a": [
        { id: "a", name: "a", category: "step", startMs: 0, endMs: 100 },
      ],
      "blob-b": [
        { id: "b", name: "b", category: "step", startMs: 0, endMs: 100 },
      ],
    });

    const spans = await hydrateTurnTraceSpans([
      { startedAt: 5_000, spansBlobUrl: "blob-a" },
      { startedAt: 5_400, spansBlobUrl: "blob-b" },
    ]);

    expect(spans.map((s) => s.startMs)).toEqual([0, 400]);
  });

  it("drops a span with a non-finite number instead of the whole timeline", async () => {
    // `trace-timeline` folds endMs with Math.max, and Math.max(x, NaN) is NaN
    // — one bad row in one blob took out the axis for every turn.
    mockBlobs({
      "blob-a": [
        { id: "ok", name: "ok", category: "step", startMs: 0, endMs: 100 },
        { id: "nan", name: "nan", category: "step", startMs: 0, endMs: NaN },
        { id: "inf", name: "inf", category: "step", startMs: 0, endMs: Infinity },
        { id: "bad-shape", name: "bad", category: "not-a-category", startMs: 0, endMs: 5 },
        { id: "missing" },
        null,
      ],
    });

    const spans = await hydrateTurnTraceSpans([
      { startedAt: 5_000, spansBlobUrl: "blob-a" },
    ]);

    expect(spans.map((s) => s.id)).toEqual(["ok"]);
    expect(spans.every((s) => Number.isFinite(s.endMs))).toBe(true);
  });

  it("falls back to offset 0 for a turn with an unusable startedAt", async () => {
    mockBlobs({
      "blob://t1": turnBlob(1_000),
      "blob://bad": turnBlob(1_000),
    });

    const spans = await hydrateTurnTraceSpans([
      { startedAt: 1_000, spansBlobUrl: "blob://t1" },
      { startedAt: Number.NaN, spansBlobUrl: "blob://bad" },
    ]);

    // The NaN row must not poison the base for the valid turn.
    expect(spans.every((span) => Number.isFinite(span.startMs))).toBe(true);
    expect(Math.min(...spans.map((span) => span.startMs))).toBe(0);
  });
});
