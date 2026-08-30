/**
 * The browser boundary the driver logic is written against.
 *
 * Exactly like the local inspector's `provider.ts`, everything above this
 * interface — tab management, action dispatch, settle + state-token wiring —
 * never imports Playwright or speaks CDP, so it is unit-testable with fakes and
 * the real implementation (`chromium-launch.ts`) can be swapped without touching
 * the driver. The messy Playwright specifics (`waitForLoadState`, `evaluate` for
 * the DOM signal and the animation frame, screenshot buffer → base64) live in
 * the adapter; the boundary is deliberately small and clean.
 */

/** One browser tab. Methods mirror the subset of Playwright's Page browserd uses. */
export interface DriverPage {
  /** Navigate and wait for the document to commit (domcontentloaded). */
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  goBack(): Promise<void>;
  /** Resolve after a brief window with no in-flight requests, or on abort. */
  waitForNetworkIdle(signal: AbortSignal): Promise<void>;
  /** Resolve after one rendered frame, or on abort. */
  requestAnimationFrame(signal: AbortSignal): Promise<void>;
  /** A structural signal of the current DOM, for the L3 state token. */
  domStructureSignal(): Promise<string>;
  /** A PNG screenshot at the canonical observation viewport, base64-encoded. */
  screenshotBase64(): Promise<string>;
  url(): string;
  close(): Promise<void>;
  isClosed(): boolean;
}

/** The persistent browser context: one profile, many tabs. */
export interface DriverContext {
  newPage(): Promise<DriverPage>;
  /** True while the underlying browser is alive; false after a crash/close. */
  isConnected(): boolean;
  close(): Promise<void>;
}
