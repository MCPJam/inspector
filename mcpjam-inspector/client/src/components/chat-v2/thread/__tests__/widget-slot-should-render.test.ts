import { describe, it, expect } from "vitest";
import { widgetSlotShouldRender } from "../tool-render-overrides";

describe("widgetSlotShouldRender", () => {
  it("renders when the tool is live-widget eligible (normal live path)", () => {
    expect(widgetSlotShouldRender(true, undefined)).toBe(true);
  });

  it("does NOT render when not eligible and no frozen capture", () => {
    expect(widgetSlotShouldRender(false, undefined)).toBe(false);
    expect(widgetSlotShouldRender(false, {})).toBe(false);
    expect(widgetSlotShouldRender(false, { frozenScreenshotUrl: null })).toBe(
      false
    );
  });

  it("renders the frozen capture EVEN when live widget rendering is unavailable", () => {
    // The load-bearing rule: a completed eval run's widget fails host-caps /
    // uiType / server checks at view-time (liveWidgetEligible === false), but
    // the recorded screenshot must still show.
    expect(
      widgetSlotShouldRender(false, {
        frozenScreenshotUrl: "https://store/redbull.png",
      })
    ).toBe(true);
  });
});
