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
 */
export const BROWSERD_HARDENING_ARGS: readonly string[] = [
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

  // Software GL that still RUNS WebGL content instead of failing it (no GPU in
  // the sandbox).
  "--disable-gpu",
  "--use-angle=swiftshader-webgl",
];

/**
 * L5 — Playwright context options that make "fresh context per iteration" give
 * DETERMINISM, not just isolation. Pinned so a screenshot on one host matches
 * another: same device scale, locale, timezone, and no motion. A real desktop
 * UA pairs with `--disable-blink-features=AutomationControlled` above.
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
 * Build browserd's full launch-arg list: everything the shared WebMCP args ask
 * for that is NOT a feature switch, then the single combined
 * `--enable-features`, then the L4 hardening set, then any extra args (e.g.
 * `--window-size` matched to the X screen geometry, supplied by the boot recipe
 * once it knows the display). Order is stable for test assertions.
 *
 * Feature switches from `WEBMCP_LAUNCH_ARGS` are folded into
 * `BROWSERD_ENABLED_FEATURES` rather than passed through, so exactly one
 * `--enable-features` ever reaches Chromium; every other shared arg passes
 * through untouched, so adding a non-feature arg upstream is not silently
 * dropped here.
 */
export function buildBrowserdLaunchArgs(extra: readonly string[] = []): string[] {
  const passthrough = WEBMCP_LAUNCH_ARGS.filter(
    (arg) => !arg.startsWith(ENABLE_FEATURES),
  );
  const args = [
    ...passthrough,
    `${ENABLE_FEATURES}${BROWSERD_ENABLED_FEATURES.join(",")}`,
    ...BROWSERD_HARDENING_ARGS,
    ...extra,
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
