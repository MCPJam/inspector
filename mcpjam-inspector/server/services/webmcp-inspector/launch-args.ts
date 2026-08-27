/**
 * Chromium switches the WebMCP Inspector launches with, and the probe that
 * proved each one necessary.
 *
 * WebMCP ships as a Chrome origin trial, so on a stock profile the page API is
 * absent and a page's `registerTool` calls never run. Forcing the feature on is
 * what makes a developer's own page inspectable without them enrolling an
 * origin in a trial.
 *
 * `--enable-features=WebMCP` is the MINIMAL switch that works: probed against
 * the pinned Chromium (151.0.7922.34 / Playwright 1.62.1), it is the shortest
 * argument set for which `document.modelContext` is defined and a page's
 * registrations reach `WebMCP.toolsAdded`. `--enable-blink-features=WebMCP`,
 * `--enable-features=WebMCPTesting` and
 * `--enable-experimental-web-platform-features` each also work; the last is
 * deliberately NOT used, because it would turn on every unrelated experimental
 * platform feature and change how the inspected page behaves.
 *
 * THE DOMAIN IS NOT THE PROBE. `WebMCP.enable` resolves successfully even on a
 * browser where the feature is off (verified: with no extra switches, `enable`
 * returns OK and no tools ever arrive). Support must therefore be probed in the
 * page — see `PAGE_API_PROBE` — not by whether the CDP command succeeded.
 */
export const WEBMCP_LAUNCH_ARGS: readonly string[] = [
  "--enable-features=WebMCP",
];

/**
 * Baseline sandbox/shared-memory switches, matching the widget harness
 * (`mcp-app-browser-harness.ts`). Kept separate from the WebMCP switches so a
 * future provider can reuse one without the other.
 */
export const WEBMCP_BASE_LAUNCH_ARGS: readonly string[] = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
];

/**
 * Evaluated in the page to decide whether this browser actually supports
 * WebMCP. `document.modelContext` is the current API; Chromium 151 still
 * aliases `navigator.modelContext` to the same object, so either would do — we
 * read the documented one and fall back, rather than requiring both.
 */
export const PAGE_API_PROBE =
  "!!(document.modelContext ?? navigator.modelContext)";

export function buildWebMcpLaunchArgs(extra: readonly string[] = []): string[] {
  return [...WEBMCP_BASE_LAUNCH_ARGS, ...WEBMCP_LAUNCH_ARGS, ...extra];
}

/**
 * Run the browser headless even for a user-facing session.
 *
 * The default is headed, because the point of the local inspector is that the
 * developer drives their own page in a real window. But an inspector reached
 * over SSH, or running in a container or a bare WSL install, has no display to
 * open one on — and there the choice is headless or nothing. Tool discovery,
 * invocation and screenshots all work headless; only direct interaction is lost.
 */
export function webMcpHeadlessRequested(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.MCPJAM_WEBMCP_HEADLESS === "true";
}
