import { describe, expect, it } from "vitest";
import {
  advanceViewport,
  DEFAULT_SESSION_VIEWPORT,
  INITIAL_SESSION_VIEWPORT,
  isPointInSessionViewport,
  MAX_SESSION_VIEWPORT,
  MIN_SESSION_VIEWPORT,
  negotiateViewport,
  normalizeViewportSize,
  parseViewportPolicy,
  sameViewport,
  type SessionViewport,
} from "../browser-viewport";

describe("normalizeViewportSize", () => {
  it("rounds fractional measurements", () => {
    // A ResizeObserver reports CSS layout, which is fractional.
    expect(normalizeViewportSize({ width: 1279.6, height: 800.2 })).toEqual({
      width: 1280,
      height: 800,
    });
  });

  it("clamps rather than refusing a collapse-animation frame", () => {
    expect(normalizeViewportSize({ width: 40, height: 12 })).toEqual({
      width: MIN_SESSION_VIEWPORT.width,
      height: MIN_SESSION_VIEWPORT.height,
    });
  });

  it("clamps a 6K panel to what the encoder was measured at", () => {
    expect(normalizeViewportSize({ width: 6016, height: 3384 })).toEqual({
      width: MAX_SESSION_VIEWPORT.width,
      height: MAX_SESSION_VIEWPORT.height,
    });
  });

  it("treats an unmeasurable element as the smallest legal size", () => {
    // A detached node measures 0; NaN arrives from arithmetic on an absent one.
    expect(normalizeViewportSize({ width: Number.NaN, height: 0 })).toEqual({
      width: MIN_SESSION_VIEWPORT.width,
      height: MIN_SESSION_VIEWPORT.height,
    });
    expect(
      normalizeViewportSize({ width: Number.POSITIVE_INFINITY, height: 700 }),
    ).toEqual({ width: MIN_SESSION_VIEWPORT.width, height: 700 });
  });

  it("survives a missing field", () => {
    expect(normalizeViewportSize({})).toEqual({
      width: MIN_SESSION_VIEWPORT.width,
      height: MIN_SESSION_VIEWPORT.height,
    });
  });
});

describe("advanceViewport", () => {
  it("bumps the revision when the size actually changes", () => {
    const next = advanceViewport(
      INITIAL_SESSION_VIEWPORT,
      { width: 1400, height: 900 },
      "followPane",
    );
    expect(next).toEqual({ width: 1400, height: 900, revision: 1 });
  });

  it("returns the SAME object when nothing moved", () => {
    // Identity is the contract: a resize observer fires on every re-render and
    // an unconditional bump would invalidate every observation several times a
    // second.
    const current: SessionViewport = { width: 1400, height: 900, revision: 3 };
    expect(
      advanceViewport(current, { width: 1400, height: 900 }, "followPane"),
    ).toBe(current);
  });

  it("does not bump for a sub-pixel wobble that rounds to the same size", () => {
    const current: SessionViewport = { width: 1400, height: 900, revision: 3 };
    expect(
      advanceViewport(current, { width: 1400.4, height: 899.7 }, "followPane"),
    ).toBe(current);
  });

  it("never moves a fixed session", () => {
    const current: SessionViewport = { ...INITIAL_SESSION_VIEWPORT };
    expect(advanceViewport(current, { width: 1400, height: 900 }, "fixed")).toBe(
      current,
    );
  });

  it("bumps monotonically across a round trip back to the original size", () => {
    const wide = advanceViewport(
      INITIAL_SESSION_VIEWPORT,
      { width: 1400, height: 900 },
      "followPane",
    );
    const back = advanceViewport(wide, DEFAULT_SESSION_VIEWPORT, "followPane");
    expect(back.width).toBe(DEFAULT_SESSION_VIEWPORT.width);
    // Same pixels, different revision — the page reflowed twice on the way.
    expect(back.revision).toBe(2);
    expect(sameViewport(back, INITIAL_SESSION_VIEWPORT)).toBe(false);
  });

  it("clamps before comparing, so an out-of-range request at the bound is a no-op", () => {
    const current: SessionViewport = {
      width: MAX_SESSION_VIEWPORT.width,
      height: MAX_SESSION_VIEWPORT.height,
      revision: 5,
    };
    expect(
      advanceViewport(current, { width: 9000, height: 9000 }, "followPane"),
    ).toBe(current);
  });
});

describe("isPointInSessionViewport", () => {
  it("accepts the last addressable pixel and refuses the one past it", () => {
    const viewport = { width: 1400, height: 900 };
    expect(isPointInSessionViewport(1399, 899, viewport)).toBe(true);
    expect(isPointInSessionViewport(1400, 899, viewport)).toBe(false);
    expect(isPointInSessionViewport(1399, 900, viewport)).toBe(false);
  });

  it("refuses a point that the old fixed viewport would have accepted", () => {
    // A session narrowed to 800 has no pixel 900, even though the constant does.
    expect(isPointInSessionViewport(900, 10, { width: 800, height: 600 })).toBe(
      false,
    );
  });

  it("refuses negative and non-finite coordinates", () => {
    const viewport = { width: 1024, height: 768 };
    expect(isPointInSessionViewport(-1, 10, viewport)).toBe(false);
    expect(isPointInSessionViewport(Number.NaN, 10, viewport)).toBe(false);
  });
});

describe("negotiateViewport", () => {
  it("lets any caller join a fixed session", () => {
    expect(negotiateViewport("fixed", undefined)).toEqual({
      ok: true,
      policy: "fixed",
    });
  });

  it("refuses a caller that never declared responsiveness", () => {
    // Absent means no. Every client written before this module omits the field
    // and every one of them assumes 1024x768.
    expect(negotiateViewport("followPane", undefined)).toEqual({
      ok: false,
      reason: "responsive_viewport_required",
    });
    expect(negotiateViewport("followPane", {})).toEqual({
      ok: false,
      reason: "responsive_viewport_required",
    });
  });

  it("admits a caller that declared it", () => {
    expect(
      negotiateViewport("followPane", { responsiveViewport: true }),
    ).toEqual({ ok: true, policy: "followPane" });
  });
});

describe("parseViewportPolicy", () => {
  it("defaults to fixed for absent and unknown values", () => {
    expect(parseViewportPolicy(undefined)).toBe("fixed");
    expect(parseViewportPolicy("followpane")).toBe("fixed");
    expect(parseViewportPolicy(7)).toBe("fixed");
  });

  it("reads the one opt-in", () => {
    expect(parseViewportPolicy("followPane")).toBe("followPane");
  });
});
