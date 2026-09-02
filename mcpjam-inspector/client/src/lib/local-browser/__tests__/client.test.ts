import { describe, expect, it } from "vitest";
import { modifiersOf, toPageCoordinates } from "../client";

/** An element whose rectangle a test controls. */
function image(width: number, height: number) {
  return {
    getBoundingClientRect: () =>
      ({ left: 0, top: 0, width, height }) as DOMRect,
  };
}

describe("mapping a click onto the page", () => {
  const frame = { deviceWidth: 1024, deviceHeight: 768, scale: 1 };

  it("maps a click when the picture fills the element exactly", () => {
    expect(
      toPageCoordinates({ clientX: 512, clientY: 384 }, image(1024, 768), frame),
    ).toEqual({ x: 512, y: 384 });
  });

  it("scales a click on a smaller rendering", () => {
    // Half size: the middle of the element is still the middle of the page.
    expect(
      toPageCoordinates({ clientX: 256, clientY: 192 }, image(512, 384), frame),
    ).toEqual({ x: 512, y: 384 });
  });

  it("accounts for the letterbox bars `object-contain` adds", () => {
    // A 1024x768 picture inside a 1024x968 element sits 100px from the top.
    const point = toPageCoordinates(
      { clientX: 512, clientY: 100 },
      image(1024, 968),
      frame,
    );
    expect(point).toEqual({ x: 512, y: 0 });
  });

  it("DROPS a click on a letterbox bar rather than snapping it to an edge", () => {
    // The page has nothing there; mapping it to the nearest pixel would put a
    // click somewhere the person did not aim.
    expect(
      toPageCoordinates({ clientX: 512, clientY: 10 }, image(1024, 968), frame),
    ).toBeNull();
  });

  it("reads a supersampled frame at its own scale", () => {
    // A 2x frame is 2048 device pixels of a 1024 CSS-pixel page.
    const point = toPageCoordinates(
      { clientX: 512, clientY: 384 },
      image(1024, 768),
      { deviceWidth: 2048, deviceHeight: 1536, scale: 2 },
    );
    expect(point).toEqual({ x: 512, y: 384 });
  });

  it("refuses to guess about an element with no size yet", () => {
    expect(
      toPageCoordinates({ clientX: 1, clientY: 1 }, image(0, 0), frame),
    ).toBeNull();
  });
});

describe("modifiers", () => {
  it("packs the bitmask CDP expects", () => {
    expect(modifiersOf({})).toBe(0);
    expect(modifiersOf({ altKey: true })).toBe(1);
    expect(modifiersOf({ ctrlKey: true })).toBe(2);
    expect(modifiersOf({ metaKey: true })).toBe(4);
    expect(modifiersOf({ shiftKey: true })).toBe(8);
    expect(modifiersOf({ ctrlKey: true, shiftKey: true })).toBe(10);
  });
});
