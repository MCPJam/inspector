import { describe, it, expect } from "vitest";
import type {
  EvalTraceBrowserInteractionStepView,
  EvalTraceWidgetRenderObservationView,
} from "@/shared/eval-trace";
import type { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import { buildFrozenScreenshotOverrides } from "../frozen-screenshot-overrides";

const obs = (
  o: Partial<EvalTraceWidgetRenderObservationView>
): EvalTraceWidgetRenderObservationView => ({
  toolCallId: "tc1",
  toolName: "search-products",
  promptIndex: 0,
  status: "rendered",
  elapsedMs: 10,
  ts: 1,
  ...o,
});

const interaction = (
  o: Partial<EvalTraceBrowserInteractionStepView>
): EvalTraceBrowserInteractionStepView => ({
  toolCallId: "tc1",
  stepIndex: 0,
  promptIndex: 0,
  action: "left_click",
  elapsedMs: 5,
  ts: 100,
  ...o,
});

describe("buildFrozenScreenshotOverrides", () => {
  it("maps a rendered observation's screenshotUrl onto the override, keyed by toolCallId", () => {
    const out = buildFrozenScreenshotOverrides({}, [
      obs({ toolCallId: "tc1", screenshotUrl: "https://s/a.png" }),
    ]);
    expect(out["tc1"]?.frozenScreenshotUrl).toBe("https://s/a.png");
  });

  it("merges onto an existing snapshot override without dropping its fields", () => {
    const base: Record<string, ToolRenderOverride> = {
      tc1: { cachedWidgetHtmlUrl: "https://s/html", serverId: "srv" },
    };
    const out = buildFrozenScreenshotOverrides(base, [
      obs({ toolCallId: "tc1", screenshotUrl: "https://s/a.png" }),
    ]);
    expect(out["tc1"]).toMatchObject({
      cachedWidgetHtmlUrl: "https://s/html",
      serverId: "srv",
      frozenScreenshotUrl: "https://s/a.png",
    });
    // base is not mutated
    expect(base["tc1"]!.frozenScreenshotUrl).toBeUndefined();
  });

  it("picks the LATEST rendered screenshot per tool call (re-render wins)", () => {
    const out = buildFrozenScreenshotOverrides({}, [
      obs({ toolCallId: "tc1", ts: 1, screenshotUrl: "https://s/old.png" }),
      obs({ toolCallId: "tc1", ts: 5, screenshotUrl: "https://s/new.png" }),
    ]);
    expect(out["tc1"]?.frozenScreenshotUrl).toBe("https://s/new.png");
  });

  it("a later FAILED attempt does not shadow an earlier good capture", () => {
    const out = buildFrozenScreenshotOverrides({}, [
      obs({ toolCallId: "tc1", ts: 1, screenshotUrl: "https://s/good.png" }),
      obs({
        toolCallId: "tc1",
        ts: 9,
        status: "render_error",
        screenshotUrl: undefined,
      }),
    ]);
    expect(out["tc1"]?.frozenScreenshotUrl).toBe("https://s/good.png");
  });

  it("ignores observations without a screenshotUrl or not rendered", () => {
    const out = buildFrozenScreenshotOverrides({}, [
      obs({ toolCallId: "tc1", status: "rendered", screenshotUrl: null }),
      obs({
        toolCallId: "tc2",
        status: "browser_unavailable",
        screenshotUrl: "https://s/x.png",
      }),
    ]);
    expect(out).toEqual({});
  });

  it("returns the base object unchanged when there is nothing to add", () => {
    const base: Record<string, ToolRenderOverride> = { tc1: { serverId: "s" } };
    expect(buildFrozenScreenshotOverrides(base, [])).toBe(base);
  });

  it("prefers the latest interaction-step capture over the initial render (final state)", () => {
    // The render observation is the OPENING render; the interact-step captures
    // are later (each click), so the cart-click screenshot — the final state —
    // wins over the initial storefront render.
    const out = buildFrozenScreenshotOverrides(
      {},
      [
        obs({
          toolCallId: "tc1",
          ts: 1,
          screenshotUrl: "https://s/initial.png",
        }),
      ],
      [
        interaction({
          toolCallId: "tc1",
          ts: 50,
          screenshotUrl: "https://s/add-to-cart.png",
        }),
        interaction({
          toolCallId: "tc1",
          ts: 90,
          screenshotUrl: "https://s/cart-open.png",
        }),
      ]
    );
    expect(out["tc1"]?.frozenScreenshotUrl).toBe("https://s/cart-open.png");
  });

  it("falls back to the render screenshot when no interaction step has one", () => {
    const out = buildFrozenScreenshotOverrides(
      {},
      [
        obs({
          toolCallId: "tc1",
          ts: 1,
          screenshotUrl: "https://s/initial.png",
        }),
      ],
      [interaction({ toolCallId: "tc1", ts: 50, screenshotUrl: null })]
    );
    expect(out["tc1"]?.frozenScreenshotUrl).toBe("https://s/initial.png");
  });
});
