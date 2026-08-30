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

  // Otherwise a navigation can hold the OLD frame and we screenshot a page that
  // no longer exists — poison for both the agent and the eval.
  "--disable-features=PaintHolding",

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
 * L5 — the canonical model-facing coordinate space. Every screenshot handed to
 * the model is at this resolution and every coordinate it emits is in this
 * space, mapped by the driver — so the model never does scaling math and a
 * viewport change cannot silently corrupt targeting.
 */
export const BROWSERD_OBSERVATION_VIEWPORT = { width: 1024, height: 768 } as const;

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
 * Build browserd's full launch-arg list: the WebMCP feature flag (shared with
 * the local inspector, single source), the L4 hardening set, and any extra args
 * (e.g. `--window-size` matched to the X screen geometry, supplied by the boot
 * recipe once it knows the display). Order is stable for test assertions.
 */
export function buildBrowserdLaunchArgs(extra: readonly string[] = []): string[] {
  return [...WEBMCP_LAUNCH_ARGS, ...BROWSERD_HARDENING_ARGS, ...extra];
}
