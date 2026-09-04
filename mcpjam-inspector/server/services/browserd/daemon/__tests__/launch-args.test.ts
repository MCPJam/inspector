import { describe, expect, it } from "vitest";
import {
  BROWSERD_CONTEXT_OPTIONS,
  BROWSERD_ENABLED_FEATURES,
  BROWSERD_HARDENING_ARGS,
  BROWSERD_OBSERVATION_VIEWPORT,
  buildBrowserdLaunchArgs,
} from "../launch-args";
import { WEBMCP_LAUNCH_ARGS } from "../../../webmcp-inspector/launch-args";

describe("buildBrowserdLaunchArgs", () => {
  it("emits ONE combined --enable-features, then the hardening set", () => {
    const args = buildBrowserdLaunchArgs();
    expect(args[0]).toBe(
      `--enable-features=${BROWSERD_ENABLED_FEATURES.join(",")}`,
    );
    expect(args).toEqual([
      `--enable-features=${BROWSERD_ENABLED_FEATURES.join(",")}`,
      ...BROWSERD_HARDENING_ARGS,
    ]);
  });

  it("carries the load-bearing hardening flags (L4)", () => {
    const args = buildBrowserdLaunchArgs();
    // crash-avoidance, bot-detection, and screenshot determinism specifically
    expect(args).toContain("--disable-dev-shm-usage");
    expect(args).toContain("--disable-blink-features=AutomationControlled");
    expect(args).toContain("--force-color-profile=srgb");
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

describe("feature switches must not clobber Playwright's (verified vs. 1.62.1)", () => {
  it("emits NO --disable-features at all", () => {
    // Playwright emits one combined --disable-features carrying twelve
    // entries, then appends our args; Chromium honours only the LAST
    // occurrence. Any --disable-features of ours therefore deletes that whole
    // list — re-enabling HttpsUpgrades, Translate, the sync beforeunload
    // check and DestroyProfileOnBrowserClose, all to restate something
    // Playwright already said.
    for (const arg of buildBrowserdLaunchArgs()) {
      expect(arg.startsWith("--disable-features=")).toBe(false);
    }
  });

  it("REFUSES to build args when a caller supplies one anyway", () => {
    // The invariant is enforced, not documented: a boot recipe's extra arg is
    // the likeliest way this comes back.
    expect(() =>
      buildBrowserdLaunchArgs(["--disable-features=SomethingNew"]),
    ).toThrow(/must not carry --disable-features/);
  });

  it("emits exactly ONE --enable-features, carrying WebMCP", () => {
    const enables = buildBrowserdLaunchArgs().filter((arg) =>
      arg.startsWith("--enable-features="),
    );
    expect(enables).toHaveLength(1);
    expect(BROWSERD_ENABLED_FEATURES).toContain("WebMCP");
  });

  it("single-sources the WebMCP feature name from the shared inspector args", () => {
    // Not restated here: if the local inspector renames or extends its
    // feature list, browserd follows without a second edit.
    const shared = WEBMCP_LAUNCH_ARGS.flatMap((arg) =>
      arg.startsWith("--enable-features=")
        ? arg.slice("--enable-features=".length).split(",")
        : [],
    );
    expect(shared.length).toBeGreaterThan(0);
    for (const feature of shared) {
      expect(BROWSERD_ENABLED_FEATURES).toContain(feature);
    }
  });

  it("restates Playwright's own CDPScreenshotNewSurface, which our switch would drop", () => {
    expect(BROWSERD_ENABLED_FEATURES).toContain("CDPScreenshotNewSurface");
  });

  it("passes through a shared arg that is NOT a feature switch", () => {
    // Folding only the feature switches means an arg added upstream for some
    // other purpose still reaches Chromium.
    const nonFeature = WEBMCP_LAUNCH_ARGS.filter(
      (arg) => !arg.startsWith("--enable-features="),
    );
    const args = buildBrowserdLaunchArgs();
    for (const arg of nonFeature) expect(args).toContain(arg);
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
