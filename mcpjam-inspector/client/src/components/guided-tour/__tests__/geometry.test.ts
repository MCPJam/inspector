import { describe, expect, it } from "vitest";
import { placePopover } from "../geometry";

const bounds = { width: 1000, height: 700 };
const card = { width: 320, height: 160 };

describe("placePopover", () => {
  it("sits below a short anchor, centered and pointing at it", () => {
    const spot = placePopover(
      { x: 300, y: 100, width: 400, height: 80 },
      card,
      bounds,
      "bottom",
    );
    expect(spot.placement).toBe("bottom");
    expect(spot.top).toBe(100 + 80 + 14);
    expect(spot.left).toBe(500 - 160);
    expect(spot.arrow).toBe(160);
  });

  it("flips to the right when there is no room below", () => {
    const spot = placePopover(
      { x: 40, y: 400, width: 300, height: 260 },
      card,
      bounds,
      "bottom",
    );
    expect(spot.placement).toBe("right");
    expect(spot.left).toBe(40 + 300 + 14);
  });

  it("points a right-side card at the top of a tall anchor", () => {
    const spot = placePopover(
      { x: 40, y: 100, width: 400, height: 400 },
      card,
      bounds,
      "right",
    );
    expect(spot.placement).toBe("right");
    expect(spot.top + spot.arrow).toBe(100 + 60);
  });

  it("stays on top over the anchor's upper edge when there is no room above", () => {
    const spot = placePopover(
      { x: 40, y: 100, width: 900, height: 500 },
      card,
      bounds,
      "top",
    );
    expect(spot.placement).toBe("top");
    expect(spot.top).toBe(12);
  });

  it("keeps the card inside the pane near an edge", () => {
    const spot = placePopover(
      { x: 900, y: 50, width: 80, height: 30 },
      card,
      bounds,
      "bottom",
    );
    expect(spot.left).toBe(bounds.width - card.width - 12);
    expect(spot.arrow).toBeLessThanOrEqual(card.width - 16);
  });
});
