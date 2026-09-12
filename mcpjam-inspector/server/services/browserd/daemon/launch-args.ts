/**
 * The Chromium switches and context pins browserd launches with in the hosted
 * desktop sandbox — and WHY each earns its place.
 *
 * This extends the local WebMCP Inspector's `launch-args.ts` philosophy ("the
 * probe that proved each one necessary") to the hosted context, which differs in
 * three ways the local inspector never faces: the browser runs headed under Xfce
 * inside E2B (small `/dev/shm`, GPU-less, frequently-occluded window), it opens
 * arbitrary PUBLIC sites (bot-detection, cookie walls), and its screenshots feed
 * an eval double-run bar that demands determinism.
 *
 * PROVENANCE HONESTY: the WebMCP feature flag and `--disable-dev-shm-usage` are
 * carried over from the local inspector, where they were probed against the
 * pinned Chromium (151.0.7922.34 / Playwright 1.62.1). The remaining hardening
 * (L4) and determinism pins (L5) come from a year of production browser-driving
 * shared by an operator (tracker: `webmcp-hosted-runtime`, learnings L4/L5) and
 * are documented by PURPOSE here; each is live-verified by the driver's
 * spike-gated integration test in PR (c2), NOT asserted as probed yet.
 */
import { WEBMCP_LAUNCH_ARGS } from "../../webmcp-inspector/launch-args";
import { BROWSERD_OBSERVATION_VIEWPORT } from "../protocol";

export { BROWSERD_OBSERVATION_VIEWPORT };

/**
 * The `--enable-features` / `--disable-features` prefix pair, and the rule
 * that governs both.
 *
 * CHROMIUM DOES NOT MERGE THESE SWITCHES. Given the same switch twice it
 * honours the LAST occurrence and silently discards every earlier one — and
 * Playwright emits exactly one combined `--disable-features=<12 features>`
 * before appending our args, so any `--disable-features` of ours replaces its
 * whole list. Verified against the pinned playwright-core 1.62.1 bundle
 * (`chromiumSwitches`: one joined switch, then `chromeArguments.push(...args)`).
 *
 * What that costs is not theoretical for an agent browser: it re-enables
 * `HttpsUpgrades` (changes navigation for `http://` targets), `Translate` and
 * `AvoidUnnecessaryBeforeUnloadCheckSync` (two classic ways an automated
 * Chromium wedges mid-action), and `DestroyProfileOnBrowserClose` (which our
 * persistent profile depends on) — all to say something Playwright was
 * already saying.
 *
 * So browserd emits NO `--disable-features` at all, and exactly ONE
 * `--enable-features` carrying everything it needs enabled.
 */
const ENABLE_FEATURES = "--enable-features=";
const DISABLE_FEATURES = "--disable-features=";

/** The feature names carried by `--enable-features` switches in `args`. */
function featuresEnabledBy(args: readonly string[]): string[] {
  return args.flatMap((arg) =>
    arg.startsWith(ENABLE_FEATURES)
      ? arg.slice(ENABLE_FEATURES.length).split(",").filter(Boolean)
      : [],
  );
}

/**
 * Everything browserd needs ENABLED, in one switch because Chromium only reads
 * one.
 *
 * `WebMCP` is not restated here — it is read out of `WEBMCP_LAUNCH_ARGS` so
 * the feature name stays single-sourced with the local inspector, which is the
 * whole point of sharing that constant.
 */
export const BROWSERD_ENABLED_FEATURES: readonly string[] = [
  ...featuresEnabledBy(WEBMCP_LAUNCH_ARGS),
  // Playwright enables this itself (unless PLAYWRIGHT_LEGACY_SCREENSHOT is
  // set) and our switch would otherwise drop it, quietly moving every capture
  // back to the legacy screenshot surface. Restated to preserve the pinned
  // version's own default rather than to change it.
  "CDPScreenshotNewSurface",
];

/**
 * L4 — hardening flags that turn "the sandbox is flaky" and "the site blocks the
 * agent" into solved problems. Grouped by what each defends against.
 *
 * Everything here is true of a browser browserd drives ANYWHERE. What is true
 * only of the hosted sandbox (software GL) lives in
 * `BROWSERD_SOFTWARE_GL_ARGS`, and `hardeningArgsFor` picks per surface.
 */
export const BROWSERD_SHARED_HARDENING_ARGS: readonly string[] = [
  // Crash-avoidance in a container with a small /dev/shm. Its ABSENCE is exactly
  // what reads as "E2B is flaky" under load. (Local inspector carries this too.)
  "--disable-dev-shm-usage",

  // Bot-detection is a top-3 practical failure on public HTTPS — browserd's
  // hosted target. Drop the automation signal; a real UA is set on the context.
  "--disable-blink-features=AutomationControlled",

  // Determinism for the eval double-run bar: identical color across hosts.
  "--force-color-profile=srgb",

  // NOTE — there is deliberately no `--disable-features=PaintHolding` here.
  // Holding the old frame across a navigation really would poison a capture,
  // but Playwright ALREADY disables PaintHolding in its own combined switch;
  // restating it bought nothing and destroyed the other eleven entries in that
  // list (see the ENABLE_FEATURES/DISABLE_FEATURES note above). Anything
  // browserd genuinely needs disabled has to be added to Playwright's list,
  // not emitted as a competing switch.

  // The panel/stream is frequently occluded and the driven tab is often not
  // foreground; without these, timers throttle and the agent sees a frozen app.
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--disable-back-forward-cache",

  // Every one of these otherwise becomes a modal the agent cannot reason about.
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-hang-monitor",
  "--noerrdialogs",

  // Force desktop hover / fine-pointer semantics. Without it, sites that gate
  // menus on `@media (hover: hover)` behave as touch devices and hover-triggered
  // navigation is unreachable by synthetic input.
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
];

/**
 * Software GL — a property of the SANDBOX, not of browserd.
 *
 * The hosted desktop has no GPU, so WebGL content would fail outright without
 * these. A user's own machine has one, and forcing SwiftShader there makes
 * `WEBGL_debug_renderer_info` report "Google SwiftShader" on a laptop that
 * plainly has a real GPU — the oldest headless heuristic there is, and a
 * standing captcha trigger on the local engine.
 */
export const BROWSERD_SOFTWARE_GL_ARGS: readonly string[] = [
  "--disable-gpu",
  "--use-angle=swiftshader-webgl",
];

/**
 * WHICH BROWSER IS THIS?
 *
 * `sandbox` is the hosted E2B desktop: GPU-less Linux, browsing on behalf of a
 * run whose screenshots are held to the eval double-run bar. `local` is the
 * user's own machine, where the same pins stop being determinism and start
 * being LIES — a Linux UA on a Mac, SwiftShader on a machine with a GPU, UTC on
 * a laptop in Lisbon. Bot scoring reads contradictions like that as automation,
 * which is why the local engine sat behind constant captchas.
 */
export type BrowserdSurface = "sandbox" | "local";

/**
 * L5 — Playwright context options that make "fresh context per iteration" give
 * DETERMINISM, not just isolation. Pinned so a screenshot on one host matches
 * another: same device scale, locale, timezone, and no motion.
 *
 * SANDBOX ONLY. Every pin below is a claim about the machine, and in the
 * sandbox each one is TRUE: it really is a Linux box, really is in UTC. See
 * `BROWSERD_LOCAL_CONTEXT_OPTIONS` for what survives on a real desktop.
 */
export const BROWSERD_CONTEXT_OPTIONS = {
  viewport: BROWSERD_OBSERVATION_VIEWPORT,
  deviceScaleFactor: 1,
  locale: "en-US",
  timezoneId: "UTC",
  reducedMotion: "reduce",
  colorScheme: "light",
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/151.0.0.0 Safari/537.36 MCPJam-Browser/1.0",
} as const;

/**
 * The same options for a browser on the USER'S machine.
 *
 * Only the viewport survives, and it survives because it is not a claim about
 * the machine at all: 1024×768 is the model's coordinate space, the frame every
 * `browser_*` tool's click coordinates are expressed in. Dropping it would
 * break tool calls, not fingerprints.
 *
 * Everything else is deliberately ABSENT rather than set to some "real-looking"
 * value, because absent is what makes Chromium answer with the truth:
 *
 *  - no `locale`/`timezoneId` — the OS's own, so `Intl` and `Accept-Language`
 *    agree with the IP the request comes from.
 *  - no `reducedMotion`/`colorScheme` — the user's actual OS preferences.
 *  - no `userAgent` — the load-bearing one. Playwright derives
 *    `userAgentMetadata` from whatever string it is given and never populates
 *    `brands` (verified in the bundled playwright-core 1.62.1,
 *    `calculateUserAgentMetadata`), so ANY context-level UA override ships a
 *    Chrome-claiming UA header beside an EMPTY `Sec-CH-UA` — itself a signal.
 *    The local engine corrects the UA with Chromium's own `--user-agent`
 *    switch instead (see `localChromeUserAgent`), which leaves the real client
 *    hints untouched.
 */
export const BROWSERD_LOCAL_CONTEXT_OPTIONS = {
  viewport: BROWSERD_OBSERVATION_VIEWPORT,
  deviceScaleFactor: 1,
} as const;

/** The hardening set for a surface: software GL is the sandbox's alone. */
export function hardeningArgsFor(
  surface: BrowserdSurface = "sandbox",
): readonly string[] {
  return surface === "local"
    ? BROWSERD_SHARED_HARDENING_ARGS
    : [...BROWSERD_SHARED_HARDENING_ARGS, ...BROWSERD_SOFTWARE_GL_ARGS];
}

/** Back-compat alias: the hosted arg set, unchanged. */
export const BROWSERD_HARDENING_ARGS: readonly string[] =
  hardeningArgsFor("sandbox");

/**
 * The platform token a REAL Chrome puts in its UA on this OS.
 *
 * These are the frozen strings Chrome itself sends, not a description of the
 * host: every Mac says `Mac OS X 10_15_7` (Apple Silicon included — Chrome does
 * not report the true version), and every 64-bit Windows says `Windows NT 10.0`.
 * Inventing "more accurate" values here would reintroduce exactly the kind of
 * mismatch this module exists to remove.
 */
export function chromePlatformToken(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  if (platform === "win32") return "Windows NT 10.0; Win64; x64";
  return "X11; Linux x86_64";
}

/**
 * A real desktop Chrome UA for this platform and Chromium major.
 *
 * The minor/build/patch are zeroed because Chrome's own UA reduction zeroes
 * them — `Chrome/151.0.0.0` is what a stock browser sends. No product token is
 * appended: `MCPJam-Browser/1.0` in the sandbox UA is honest, and on public
 * HTTPS it is also a single-token match for every bot rule in existence.
 */
export function chromeUserAgent(
  platform: NodeJS.Platform,
  majorVersion: number | string,
): string {
  return (
    `Mozilla/5.0 (${chromePlatformToken(platform)}) ` +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    `Chrome/${majorVersion}.0.0.0 Safari/537.36`
  );
}

/**
 * The `chromium` entry's major version in a playwright-core `browsers.json`.
 *
 * Split from the file read so the parse is testable without an install: a
 * worktree or a pruned package has no `playwright-core` to resolve, and a
 * version claim is the last thing that should be exercised only in CI.
 */
export function chromiumMajorFromManifest(raw: string): number | null {
  try {
    const manifest = JSON.parse(raw) as {
      browsers?: Array<{ name?: string; browserVersion?: string }>;
    };
    const entry = manifest.browsers?.find((b) => b.name === "chromium");
    const major = Number.parseInt(entry?.browserVersion ?? "", 10);
    return Number.isFinite(major) && major > 0 ? major : null;
  } catch {
    return null;
  }
}

let bundledMajor: number | null | undefined;

/**
 * The Chromium major version Playwright will actually launch.
 *
 * Read from playwright-core's own `browsers.json` — the file that decides which
 * build gets installed — so the UA can never claim a version other than the
 * binary's. `browsers.json` is not in playwright-core's `exports` map, so it is
 * resolved relative to the `package.json` that is; a miss returns null and the
 * caller simply declines to correct the UA rather than guessing a version.
 */
export async function bundledChromiumMajorVersion(): Promise<number | null> {
  if (bundledMajor !== undefined) return bundledMajor;
  let resolved: number | null = null;
  try {
    const { createRequire } = await import("node:module");
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const require_ = createRequire(import.meta.url);
    const root = dirname(require_.resolve("playwright-core/package.json"));
    resolved = chromiumMajorFromManifest(
      readFileSync(join(root, "browsers.json"), "utf8"),
    );
  } catch {
    // Not resolvable (a packaged build, a pruned install, a bare worktree).
    // Fall through: no switch is emitted and Chromium keeps its own UA, which
    // is the truth — including the word "Headless" when headless, which is the
    // status quo for every surface that does not pass one.
  }
  bundledMajor = resolved;
  return resolved;
}

/**
 * The UA string the local engine should present, or nothing.
 *
 * It reaches Chromium as the `--user-agent` switch (see
 * `buildBrowserdLaunchArgs`), never as a Playwright context option.
 *
 * WHY A SWITCH AND NOT A CONTEXT OPTION: the switch changes the UA STRING and
 * leaves Chromium's real user-agent metadata alone, so `Sec-CH-UA`,
 * `Sec-CH-UA-Platform` and `navigator.userAgentData` keep answering with the
 * truth — which now agrees with the header. A Playwright `userAgent` option
 * would override both, with an empty brand list (see
 * `BROWSERD_LOCAL_CONTEXT_OPTIONS`).
 *
 * WHY AT ALL, given the truth is what we want: headless Chromium says
 * `HeadlessChrome/151.0.0.0`, which public sites block outright. The switch
 * restores the token a headed run of the SAME binary would have sent and
 * changes nothing else.
 *
 * Declines when the binary is not Playwright's own (`customExecutable`): its
 * version is unknown, and a UA claiming the wrong major is the mismatch we are
 * here to remove.
 */
export async function localChromeUserAgent(
  options: { customExecutable?: boolean; platform?: NodeJS.Platform } = {},
): Promise<string | undefined> {
  if (options.customExecutable) return undefined;
  const major = await bundledChromiumMajorVersion();
  if (major === null) return undefined;
  return chromeUserAgent(options.platform ?? process.platform, major);
}

/**
 * Build browserd's full launch-arg list: everything the shared WebMCP args ask
 * for that is NOT a feature switch, then the single combined
 * `--enable-features`, then the L4 hardening set for the surface, then the
 * local engine's UA correction if it has one, then any extra args (e.g.
 * `--window-size` matched to the X screen geometry, supplied by the boot recipe
 * once it knows the display). Order is stable for test assertions.
 *
 * Feature switches are folded into `BROWSERD_ENABLED_FEATURES` rather than
 * passed through — from `WEBMCP_LAUNCH_ARGS` AND from `extra` — so exactly one
 * `--enable-features` ever reaches Chromium. Every other arg passes through
 * untouched, so adding a non-feature arg upstream is not silently dropped
 * here.
 */
export function buildBrowserdLaunchArgs(
  extra: readonly string[] = [],
  options: { surface?: BrowserdSurface; userAgent?: string } = {},
): string[] {
  const surface = options.surface ?? "sandbox";
  const passthrough = WEBMCP_LAUNCH_ARGS.filter(
    (arg) => !arg.startsWith(ENABLE_FEATURES),
  );
  // FOLDED, not passed through, for the same reason the shared args are — and
  // this half was missing. An `--enable-features` in `extra` is emitted LAST,
  // and by this module's own rule at the top of the file Chromium honours the
  // last occurrence and discards every earlier one. So a caller that passed
  // `--enable-features=WebMCP` alongside these args got WebMCP and lost
  // `CDPScreenshotNewSurface` — quietly moving every capture back to the
  // legacy screenshot surface. The WebMCP Inspector's local Chromium did
  // exactly that.
  //
  // Deduped while preserving first-seen order, so the emitted switch is stable
  // for a test to assert and a caller restating a feature we already have
  // changes nothing.
  const enabled = [
    ...new Set([...BROWSERD_ENABLED_FEATURES, ...featuresEnabledBy(extra)]),
  ];
  const args = [
    ...passthrough,
    `${ENABLE_FEATURES}${enabled.join(",")}`,
    ...hardeningArgsFor(surface),
    ...(options.userAgent ? [`--user-agent=${options.userAgent}`] : []),
    ...extra.filter((arg) => !arg.startsWith(ENABLE_FEATURES)),
  ];
  // Enforced, not merely documented: a `--disable-features` reaching Chromium
  // from anywhere — a future hardening entry, or a boot recipe's extra arg —
  // silently deletes Playwright's list. Failing to launch is recoverable and
  // loud; launching a browser missing eleven stability features is neither.
  const clobbering = args.find((arg) => arg.startsWith(DISABLE_FEATURES));
  if (clobbering) {
    throw new Error(
      `browserd launch args must not carry ${DISABLE_FEATURES} (got "${clobbering}"): ` +
        "Chromium honours only the last occurrence, so this would discard " +
        "Playwright's own disabled-feature list wholesale",
    );
  }
  return args;
}
