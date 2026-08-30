import { describe, expect, it } from "vitest";
import {
  BROWSERD_CONTEXT_OPTIONS,
  BROWSERD_HARDENING_ARGS,
  BROWSERD_OBSERVATION_VIEWPORT,
  buildBrowserdLaunchArgs,
} from "../launch-args";
import { WEBMCP_LAUNCH_ARGS } from "../../../webmcp-inspector/launch-args";

describe("buildBrowserdLaunchArgs", () => {
  it("puts the shared WebMCP feature flag first, then the hardening set", () => {
    const args = buildBrowserdLaunchArgs();
    expect(args[0]).toBe(WEBMCP_LAUNCH_ARGS[0]);
    expect(args).toEqual([...WEBMCP_LAUNCH_ARGS, ...BROWSERD_HARDENING_ARGS]);
  });

  it("carries the load-bearing hardening flags (L4)", () => {
    const args = buildBrowserdLaunchArgs();
    // crash-avoidance, bot-detection, and screenshot determinism specifically
    expect(args).toContain("--disable-dev-shm-usage");
    expect(args).toContain("--disable-blink-features=AutomationControlled");
    expect(args).toContain("--force-color-profile=srgb");
    expect(args).toContain("--disable-features=PaintHolding");
  });

  it("appends extra args (e.g. --window-size from the boot recipe) last", () => {
    const args = buildBrowserdLaunchArgs(["--window-size=1600,1200"]);
    expect(args.at(-1)).toBe("--window-size=1600,1200");
  });

  it("does not enable every experimental platform feature (would perturb pages)", () => {
    expect(buildBrowserdLaunchArgs()).not.toContain(
      "--enable-experimental-web-platform-features",
    );
  });
});

describe("determinism pins (L5)", () => {
  it("pins the canonical model-facing viewport", () => {
    expect(BROWSERD_OBSERVATION_VIEWPORT).toEqual({ width: 1024, height: 768 });
    expect(BROWSERD_CONTEXT_OPTIONS.viewport).toBe(BROWSERD_OBSERVATION_VIEWPORT);
  });

  it("pins scale, locale, timezone, and motion so captures are reproducible", () => {
    expect(BROWSERD_CONTEXT_OPTIONS.deviceScaleFactor).toBe(1);
    expect(BROWSERD_CONTEXT_OPTIONS.locale).toBe("en-US");
    expect(BROWSERD_CONTEXT_OPTIONS.timezoneId).toBe("UTC");
    expect(BROWSERD_CONTEXT_OPTIONS.reducedMotion).toBe("reduce");
  });

  it("presents a real desktop UA (pairs with the AutomationControlled flag)", () => {
    expect(BROWSERD_CONTEXT_OPTIONS.userAgent).toMatch(/Chrome\/\d+/);
    expect(BROWSERD_CONTEXT_OPTIONS.userAgent).not.toMatch(/Headless/i);
  });
});
