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

import type { A11yNode, ConsoleEntry } from "./observation-budget";
import type { WebMcpBridge } from "./webmcp-bridge";

/**
 * Where an act is aimed. Coordinates are in the canonical observation
 * viewport (L5), so the model never does scaling math; a selector is resolved
 * by the page. `a11yRef` is deliberately NOT here yet — stable refs need
 * backendNodeId plumbing, and a ref that silently drifts is worse than one
 * the model cannot use.
 */
export type ActPoint = { x: number; y: number };

/** One browser tab. Methods mirror the subset of Playwright's Page browserd uses. */
export interface DriverPage {
  /** Navigate and wait for the document to commit (domcontentloaded). */
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  goBack(): Promise<void>;
  /**
   * The act primitives. Each throws when its target cannot be resolved — the
   * driver turns that into a typed `target_not_found` result rather than
   * letting a Playwright timeout message reach the model.
   */
  clickAt(point: ActPoint, options?: { button?: "left" | "right" }): Promise<void>;
  clickSelector(selector: string): Promise<void>;
  hoverAt(point: ActPoint): Promise<void>;
  hoverSelector(selector: string): Promise<void>;
  /** Type into the focused element (a click usually precedes this). */
  typeText(text: string): Promise<void>;
  /** Type into a specific element, replacing its current value. */
  fillSelector(selector: string, text: string): Promise<void>;
  /** Press one key or chord ("Enter", "Control+A"). */
  press(key: string): Promise<void>;
  scrollBy(delta: { dx: number; dy: number }): Promise<void>;
  dragTo(from: ActPoint, to: ActPoint): Promise<void>;
  selectOption(selector: string, value: string): Promise<void>;
  /** Focus this tab in the window (what a human sees, and what `activate_tab` does). */
  bringToFront(): Promise<void>;
  /**
   * The accessibility tree, uncapped — the driver applies the L9 budget.
   *
   * `rootSelector` scopes the tree to one element, which is how a caller
   * retrieves a subtree the budget omitted. Resolves `null` when the tree is
   * unavailable AND when a `rootSelector` matches nothing: the driver
   * distinguishes those two by whether it asked for a root, and reports an
   * unmatched selector as an error rather than as an empty page.
   */
  a11ySnapshot(rootSelector?: string): Promise<A11yNode | null>;
  /** The console ring buffer this page has accumulated, oldest first. */
  consoleEntries(): readonly ConsoleEntry[];
  /**
   * Discard console entries captured at or after `since` (ms since epoch).
   *
   * Exists for the human handoff: the console ring fills from an eager page
   * listener that knows nothing about the lease, so entries logged while a
   * person was signing in would otherwise be readable the instant they hand
   * control back. Dropping the window is the difference between "private" and
   * "delayed".
   */
  dropConsoleSince(since: number): void;
  /**
   * The page's WebMCP bridge, attached lazily on first use (attaching a CDP
   * session to every tab that may never invoke a page tool is wasted work).
   * Resolves `null` when this build cannot speak the domain at all.
   */
  webmcp(): Promise<WebMcpBridge | null>;
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
