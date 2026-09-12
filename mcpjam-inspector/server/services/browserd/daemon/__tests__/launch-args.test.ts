import { describe, expect, it } from "vitest";
import {
  BROWSERD_CONTEXT_OPTIONS,
  BROWSERD_ENABLED_FEATURES,
  BROWSERD_HARDENING_ARGS,
  BROWSERD_LOCAL_CONTEXT_OPTIONS,
  BROWSERD_OBSERVATION_VIEWPORT,
  BROWSERD_SHARED_HARDENING_ARGS,
  BROWSERD_SOFTWARE_GL_ARGS,
  buildBrowserdLaunchArgs,
  bundledChromiumMajorVersion,
  chromiumMajorFromManifest,
  chromePlatformToken,
  chromeUserAgent,
  hardeningArgsFor,
  localChromeUserAgent,
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

/**
 * The split that fixed "the local browser hits a captcha on every site": the
 * sandbox's pins describe the sandbox, and describing it on someone's laptop is
 * a pile of contradictions bot scoring is built to find.
 */
describe("surface split — sandbox pins are not claims about a user's machine", () => {
  it("leaves the HOSTED arg list byte-identical (this PR must not move it)", () => {
    expect(buildBrowserdLaunchArgs()).toEqual([
      `--enable-features=${BROWSERD_ENABLED_FEATURES.join(",")}`,
      ...BROWSERD_SHARED_HARDENING_ARGS,
      ...BROWSERD_SOFTWARE_GL_ARGS,
    ]);
    expect(buildBrowserdLaunchArgs([], { surface: "sandbox" })).toEqual(
      buildBrowserdLaunchArgs(),
    );
    expect(BROWSERD_HARDENING_ARGS).toEqual(hardeningArgsFor("sandbox"));
  });

  it("drops software GL locally — SwiftShader on a machine with a GPU is the oldest headless tell", () => {
    const local = buildBrowserdLaunchArgs([], { surface: "local" });
    expect(local).not.toContain("--disable-gpu");
    expect(local).not.toContain("--use-angle=swiftshader-webgl");
    // and keeps everything that is true of a driven browser anywhere
    for (const arg of BROWSERD_SHARED_HARDENING_ARGS) {
      expect(local).toContain(arg);
    }
    expect(local).toContain("--disable-blink-features=AutomationControlled");
  });

  it("keeps software GL in the sandbox, which really has no GPU", () => {
    for (const arg of BROWSERD_SOFTWARE_GL_ARGS) {
      expect(buildBrowserdLaunchArgs()).toContain(arg);
    }
  });

  it("emits --user-agent only when a surface supplies one, and never twice", () => {
    const withUa = buildBrowserdLaunchArgs([], {
      surface: "local",
      userAgent: "Mozilla/5.0 (Macintosh) Chrome/151.0.0.0",
    });
    expect(withUa.filter((arg) => arg.startsWith("--user-agent="))).toEqual([
      "--user-agent=Mozilla/5.0 (Macintosh) Chrome/151.0.0.0",
    ]);
    for (const args of [
      buildBrowserdLaunchArgs(),
      buildBrowserdLaunchArgs([], { surface: "local" }),
    ]) {
      expect(args.some((arg) => arg.startsWith("--user-agent="))).toBe(false);
    }
  });

  it("still puts the boot recipe's extra args LAST, after the UA switch", () => {
    const args = buildBrowserdLaunchArgs(["--window-size=1600,1200"], {
      surface: "local",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/151.0.0.0",
    });
    expect(args.at(-1)).toBe("--window-size=1600,1200");
  });

  it("keeps the model's coordinate space locally and drops every machine claim", () => {
    // The viewport is not a claim about the host — it is the frame every
    // browser_* click coordinate is expressed in, so it must survive.
    expect(BROWSERD_LOCAL_CONTEXT_OPTIONS.viewport).toBe(
      BROWSERD_OBSERVATION_VIEWPORT,
    );
    expect(BROWSERD_LOCAL_CONTEXT_OPTIONS.deviceScaleFactor).toBe(1);
    // Absent, not "set to something realistic": absent is what makes Chromium
    // answer with the truth, and a Playwright userAgent option would ship an
    // EMPTY Sec-CH-UA beside a Chrome-claiming UA header.
    for (const pin of [
      "userAgent",
      "timezoneId",
      "locale",
      "reducedMotion",
      "colorScheme",
    ]) {
      expect(BROWSERD_LOCAL_CONTEXT_OPTIONS).not.toHaveProperty(pin);
    }
  });
});

describe("the UA a real Chrome on this machine would send", () => {
  it("uses the frozen platform token per OS, not a description of the host", () => {
    expect(chromePlatformToken("darwin")).toBe(
      "Macintosh; Intel Mac OS X 10_15_7",
    );
    expect(chromePlatformToken("win32")).toBe("Windows NT 10.0; Win64; x64");
    expect(chromePlatformToken("linux")).toBe("X11; Linux x86_64");
  });

  it("zeroes the version tail the way Chrome's own UA reduction does", () => {
    expect(chromeUserAgent("darwin", 151)).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/151.0.0.0 Safari/537.36",
    );
  });

  it("carries no Headless and no MCPJam product token", () => {
    const ua = chromeUserAgent("darwin", 151);
    expect(ua).not.toMatch(/Headless/i);
    expect(ua).not.toMatch(/MCPJam/i);
    // the sandbox UA's own token is exactly what must not reach public HTTPS
    expect(BROWSERD_CONTEXT_OPTIONS.userAgent).toMatch(/MCPJam/);
  });

  it("takes the major from the manifest that decides which build is installed", () => {
    // Not a hardcoded 151: the UA must never claim a version other than the
    // binary's, which is why it comes from playwright-core's own browsers.json.
    expect(
      chromiumMajorFromManifest(
        JSON.stringify({
          browsers: [
            { name: "firefox", browserVersion: "999.0" },
            { name: "chromium", browserVersion: "151.0.7922.34" },
          ],
        }),
      ),
    ).toBe(151);
  });

  it("answers null rather than a guess when the manifest cannot be read", () => {
    // null is load-bearing: it is what makes the caller emit NO switch, so a
    // broken read can never produce a UA claiming a version we did not launch.
    expect(chromiumMajorFromManifest("not json")).toBeNull();
    expect(
      chromiumMajorFromManifest(JSON.stringify({ browsers: [] })),
    ).toBeNull();
    expect(
      chromiumMajorFromManifest(
        JSON.stringify({ browsers: [{ name: "chromium" }] }),
      ),
    ).toBeNull();
  });

  it("agrees with the installed playwright-core, where one is installed", async () => {
    // Skipped in a bare git worktree, which has no node_modules of its own;
    // in CI and in a normal checkout this is the real end-to-end check.
    const { createRequire } = await import("node:module");
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    let manifest: string | undefined;
    try {
      const root = dirname(
        createRequire(import.meta.url).resolve("playwright-core/package.json"),
      );
      manifest = readFileSync(join(root, "browsers.json"), "utf8");
    } catch {
      return; // no install here — nothing to agree with
    }
    const expected = chromiumMajorFromManifest(manifest);
    expect(expected).toBeGreaterThan(100);
    await expect(bundledChromiumMajorVersion()).resolves.toBe(expected);
    await expect(localChromeUserAgent({ platform: "darwin" })).resolves.toBe(
      chromeUserAgent("darwin", expected as number),
    );
  });

  it("declines to guess for a Chromium we did not install", async () => {
    await expect(
      localChromeUserAgent({ customExecutable: true }),
    ).resolves.toBeUndefined();
  });
});
