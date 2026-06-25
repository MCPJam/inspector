import { describe, expect, it } from "vitest";
import {
  buildToolCallPromptIndex,
  deriveRenderedWidgetTargets,
  mergeRecordingTargets,
  type RenderedTraceSource,
} from "../rendered-widget-targets";
import {
  fingerprintDiverged,
  type RecordingTarget,
} from "@/components/chat-v2/thread/recorder-types";

// Minimal shapes — cast to the trace types the helper reads structurally.
const obs = (promptIndex: number, toolName: string, status = "rendered") =>
  ({ promptIndex, toolName, status, toolCallId: `c${promptIndex}-${toolName}`, elapsedMs: 0, ts: 0 }) as any;
const toolSpan = (promptIndex: number, toolName: string) =>
  ({ id: `s${promptIndex}-${toolName}`, category: "tool", promptIndex, toolName }) as any;

describe("deriveRenderedWidgetTargets", () => {
  it("uses widgetRenderObservations (status rendered) as authoritative", () => {
    const trace: RenderedTraceSource = {
      spans: [toolSpan(0, "search-products"), toolSpan(1, "search-products")],
      widgetRenderObservations: [
        obs(0, "search-products"),
        obs(1, "search-products"),
      ],
    };
    expect(deriveRenderedWidgetTargets(trace)).toEqual([
      { promptIndex: 0, toolName: "search-products" },
      { promptIndex: 1, toolName: "search-products" },
    ]);
  });

  it("drops observations that did not render", () => {
    const trace: RenderedTraceSource = {
      widgetRenderObservations: [
        obs(0, "search-products"),
        obs(1, "broken-widget", "render_error"),
      ],
    };
    expect(deriveRenderedWidgetTargets(trace)).toEqual([
      { promptIndex: 0, toolName: "search-products" },
    ]);
  });

  it("treats an EMPTY observations array as authoritative (clears spans)", () => {
    const trace: RenderedTraceSource = {
      spans: [toolSpan(0, "search-products")],
      widgetRenderObservations: [],
    };
    expect(deriveRenderedWidgetTargets(trace)).toEqual([]);
  });

  it("falls back to tool spans only when observations are absent", () => {
    const trace: RenderedTraceSource = {
      spans: [toolSpan(2, "search-products"), { id: "x", category: "llm" } as any],
    };
    expect(deriveRenderedWidgetTargets(trace)).toEqual([
      { promptIndex: 2, toolName: "search-products" },
    ]);
  });

  it("dedupes repeated renders of the same widget in a turn", () => {
    const trace: RenderedTraceSource = {
      widgetRenderObservations: [obs(0, "view-cart"), obs(0, "view-cart")],
    };
    expect(deriveRenderedWidgetTargets(trace)).toEqual([
      { promptIndex: 0, toolName: "view-cart" },
    ]);
  });

  it("returns [] for null/empty trace", () => {
    expect(deriveRenderedWidgetTargets(null)).toEqual([]);
    expect(deriveRenderedWidgetTargets({})).toEqual([]);
  });
});

describe("mergeRecordingTargets", () => {
  const widgets = new Set(["search-products", "view-cart"]);
  const authored: RecordingTarget[] = [
    { promptIndex: 0, toolName: "search-products" },
    { promptIndex: 0, toolName: "view-cart" },
  ];

  it("appends rendered-only widget targets after authored, deduped", () => {
    const rendered = [
      { promptIndex: 0, toolName: "search-products" }, // dup of authored
      { promptIndex: 1, toolName: "search-products" }, // new ·T2
    ];
    expect(mergeRecordingTargets(authored, rendered, widgets)).toEqual([
      { promptIndex: 0, toolName: "search-products" },
      { promptIndex: 0, toolName: "view-cart" },
      { promptIndex: 1, toolName: "search-products" },
    ]);
  });

  it("filters rendered targets to widget tools", () => {
    const rendered = [
      { promptIndex: 1, toolName: "search-products" },
      { promptIndex: 1, toolName: "not-a-widget" },
    ];
    expect(mergeRecordingTargets([], rendered, widgets)).toEqual([
      { promptIndex: 1, toolName: "search-products" },
    ]);
  });

  it("preserves authored order/priority", () => {
    expect(mergeRecordingTargets(authored, [], widgets)).toEqual(authored);
  });
});

describe("buildToolCallPromptIndex", () => {
  it("lets render observations OVERRIDE span promptIndex (authored-turn wins)", () => {
    // The coke search-products: span says live-ordinal 2, observation says
    // authored-turn 1. The resolver must return 1 so it matches the ·T2 target.
    const spans = [
      { toolCallId: "redbull", promptIndex: 0 },
      { toolCallId: "coke", promptIndex: 2 },
    ];
    const observations = [
      { toolCallId: "redbull", promptIndex: 0 },
      { toolCallId: "coke", promptIndex: 1 },
    ];
    const map = new Map(buildToolCallPromptIndex(spans, observations));
    expect(map.get("coke")).toBe(1);
    expect(map.get("redbull")).toBe(0);
  });

  it("falls back to spans when no observations yet (streaming)", () => {
    const spans = [{ toolCallId: "coke", promptIndex: 2 }];
    const map = new Map(buildToolCallPromptIndex(spans, undefined));
    expect(map.get("coke")).toBe(2);
  });

  it("ignores entries missing toolCallId or promptIndex", () => {
    const map = new Map(
      buildToolCallPromptIndex(
        [{ promptIndex: 1 } as any, { toolCallId: "ok", promptIndex: 3 }],
        [{ toolCallId: "x" } as any],
      ),
    );
    expect([...map.entries()]).toEqual([["ok", 3]]);
  });
});

describe("fingerprintDiverged", () => {
  it("is false when no run fingerprint captured yet", () => {
    expect(fingerprintDiverged(null, "fp-1")).toBe(false);
  });
  it("is false while the draft matches the run", () => {
    expect(fingerprintDiverged("fp-1", "fp-1")).toBe(false);
  });
  it("is true once the draft diverges (even with nothing armed)", () => {
    expect(fingerprintDiverged("fp-1", "fp-2")).toBe(true);
  });
});
