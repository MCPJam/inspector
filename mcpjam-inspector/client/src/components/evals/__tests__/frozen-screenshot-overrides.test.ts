import { describe, it, expect } from "vitest";
import type {
  EvalTraceBrowserInteractionStepView,
  EvalTraceWidgetRenderObservationView,
} from "@/shared/eval-trace";
import type { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import { buildFrozenScreenshotOverrides } from "../frozen-screenshot-overrides";

const obs = (
  o: Partial<EvalTraceWidgetRenderObservationView>,
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
  o: Partial<EvalTraceBrowserInteractionStepView>,
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

  it("carries saved eval errors and the observation resource URI into the frozen override", () => {
    const out = buildFrozenScreenshotOverrides({}, [
      obs({
        toolCallId: "tc1",
        screenshotUrl: "https://s/a.png",
        resourceUri: "ui://widget/view.html",
        consoleErrors: ["TypeError: broken"],
        blockedRequests: ["https://blocked.example.com"],
      }),
    ]);

    expect(out.tc1).toMatchObject({
      resourceUri: "ui://widget/view.html",
      recordedWidgetErrors: {
        consoleErrors: ["TypeError: broken"],
        blockedRequests: ["https://blocked.example.com"],
      },
    });
  });

  it("keeps errors from later failed observations with the last good screenshot", () => {
    const out = buildFrozenScreenshotOverrides({}, [
      obs({ screenshotUrl: "https://s/good.png", consoleErrors: ["first"] }),
      obs({
        ts: 2,
        status: "render_error",
        screenshotUrl: undefined,
        consoleErrors: ["first", "later"],
      }),
    ]);

    expect(out.tc1?.recordedWidgetErrors?.consoleErrors).toEqual([
      "first",
      "later",
    ]);
  });

  it("merges onto an existing snapshot override without dropping its fields", () => {
    const base: Record<string, ToolRenderOverride> = {
      tc1: { cachedWidgetHtmlUrl: "https://s/html", serverId: "srv" },
    };
    const out = buildFrozenScreenshotOverrides(
      base,
      [obs({ toolCallId: "tc1", screenshotUrl: "https://s/a.png" })],
      // A click inside the App is what makes the picture win over the saved copy.
      [interaction({ toolCallId: "tc1", ts: 0, screenshotUrl: null })],
    );
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
      ],
    );
    expect(out["tc1"]?.frozenScreenshotUrl).toBe("https://s/cart-open.png");
  });

  it("keeps the render resource URI when a later interaction supplies only a screenshot", () => {
    const out = buildFrozenScreenshotOverrides(
      {},
      [
        obs({
          toolCallId: "tc1",
          ts: 1,
          screenshotUrl: "https://s/initial.png",
          resourceUri: "ui://widget/view.html",
        }),
      ],
      [
        interaction({
          toolCallId: "tc1",
          ts: 50,
          screenshotUrl: "https://s/final.png",
        }),
      ],
    );

    expect(out.tc1).toMatchObject({
      frozenScreenshotUrl: "https://s/final.png",
      resourceUri: "ui://widget/view.html",
    });
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
      [interaction({ toolCallId: "tc1", ts: 50, screenshotUrl: null })],
    );
    expect(out["tc1"]?.frozenScreenshotUrl).toBe("https://s/initial.png");
  });

  describe("live App vs recorded picture", () => {
    const savedCopy = (): Record<string, ToolRenderOverride> => ({
      tc1: {
        cachedWidgetHtmlUrl: "https://s/app.html",
        toolMetadata: { ui: { resourceUri: "ui://squad/show.html" } },
      },
    });

    it("shows the live App from its saved copy when the run did not click in it", () => {
      const base = savedCopy();
      const out = buildFrozenScreenshotOverrides(base, [
        obs({ toolCallId: "tc1", screenshotUrl: "https://s/page.png" }),
      ]);
      expect(out).toBe(base);
      expect(out.tc1?.frozenScreenshotUrl).toBeUndefined();
      expect(out.tc1?.cachedWidgetHtmlUrl).toBe("https://s/app.html");
    });

    it("shows the recorded picture when the run clicked inside the App", () => {
      const out = buildFrozenScreenshotOverrides(
        savedCopy(),
        [obs({ toolCallId: "tc1", ts: 1, screenshotUrl: "https://s/page.png" })],
        [
          interaction({
            toolCallId: "tc1",
            ts: 50,
            screenshotUrl: "https://s/after-click.png",
          }),
        ],
      );
      expect(out.tc1?.frozenScreenshotUrl).toBe("https://s/after-click.png");
    });

    it("only switches the clicked tool call to a picture", () => {
      const base: Record<string, ToolRenderOverride> = {
        ...savedCopy(),
        tc2: { cachedWidgetHtmlUrl: "https://s/other.html" },
      };
      const out = buildFrozenScreenshotOverrides(
        base,
        [
          obs({ toolCallId: "tc1", screenshotUrl: "https://s/one.png" }),
          obs({ toolCallId: "tc2", screenshotUrl: "https://s/two.png" }),
        ],
        [interaction({ toolCallId: "tc1", screenshotUrl: null })],
      );
      expect(out.tc1?.frozenScreenshotUrl).toBe("https://s/one.png");
      expect(out.tc2?.frozenScreenshotUrl).toBeUndefined();
    });

    it("falls back to the picture when there is no saved App copy", () => {
      const out = buildFrozenScreenshotOverrides({ tc1: { serverId: "srv" } }, [
        obs({ toolCallId: "tc1", screenshotUrl: "https://s/page.png" }),
      ]);
      expect(out.tc1?.frozenScreenshotUrl).toBe("https://s/page.png");
    });

    it.each([
      ["an assert screenshot", { action: "screenshot" as const }],
      ["a wait", { action: "wait" as const }],
      ["a mouse move", { action: "mouse_move" as const }],
      ["a failed click", { action: "left_click" as const, ok: false }],
      [
        "a skipped click",
        { action: "left_click" as const, note: "step_budget_exceeded" as const },
      ],
    ])("keeps the live App when the only step is %s", (_label, step) => {
      const base = savedCopy();
      const out = buildFrozenScreenshotOverrides(
        base,
        [obs({ toolCallId: "tc1", screenshotUrl: "https://s/page.png" })],
        [
          interaction({
            toolCallId: "tc1",
            ts: 50,
            screenshotUrl: "https://s/step.png",
            ...step,
          }),
        ],
      );
      expect(out).toBe(base);
      expect(out.tc1?.frozenScreenshotUrl).toBeUndefined();
    });

    it("keeps the live App when the run clicked but recorded no picture", () => {
      const base = savedCopy();
      const out = buildFrozenScreenshotOverrides(
        base,
        [obs({ toolCallId: "tc1", screenshotUrl: null })],
        [interaction({ toolCallId: "tc1", screenshotUrl: null })],
      );
      expect(out).toBe(base);
      expect(out.tc1?.frozenScreenshotUrl).toBeUndefined();
    });
  });
});
