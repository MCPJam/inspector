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

import type { ConsoleEntry } from "./observation-budget";
import type { PendingDialog } from "./dialogs";
import type { NetworkEntry } from "./network";
import type { CdpLike, WebMcpBridge } from "./webmcp-bridge";

/**
 * Where an act is aimed. Coordinates are in the canonical observation
 * viewport (L5), so the model never does scaling math; a selector is resolved
 * by the page. `a11yRef` is deliberately NOT here yet — stable refs need
 * backendNodeId plumbing, and a ref that silently drifts is worse than one
 * the model cannot use.
 */
export type ActPoint = { x: number; y: number };

/*
 * NO `a11ySnapshot` HERE. The tree used to be an engine method, because
 * Playwright had one (`ariaSnapshot`) and Electron had to grow an equivalent.
 * It is now read from `Accessibility.getFullAXTree` through `cdp()`, by one
 * function both engines share — which is what makes a ref mean the same thing
 * on both, and what lets a node id survive from an observation to the act that
 * uses it. An engine method would have to answer for node identity itself, and
 * the YAML one of them answered in had none.
 */

/** One browser tab. Methods mirror the subset of Playwright's Page browserd uses. */
export interface DriverPage {
  /** Navigate and wait for the document to commit (domcontentloaded). */
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  goBack(): Promise<void>;
  /**
   * The other direction. A no-op when there is nothing ahead in the history,
   * which is what Playwright's `goForward` already does — it resolves with a
   * null response rather than throwing — so the driver has nothing to special-
   * case and the pane's disabled button is the only guard anybody sees.
   */
  goForward(): Promise<void>;
  /**
   * Change the page's CSS-pixel viewport.
   *
   * OPTIONAL, and the optionality is load-bearing rather than convenience: an
   * engine that cannot resize is still a perfectly good engine for a `fixed`
   * session, which is every eval and every unattended run. The driver refuses
   * a resize the page cannot do instead of reporting a size the page is not
   * actually rendering at — a viewport nobody applied, published as if they
   * had, is exactly the disagreement between the number and the picture that
   * the whole responsive path exists to avoid.
   */
  setViewportSize?(size: { width: number; height: number }): Promise<void>;
  /**
   * The act primitives. Each throws when its target cannot be resolved — the
   * driver turns that into a typed `target_not_found` result rather than
   * letting a Playwright timeout message reach the model.
   */
  clickAt(
    point: ActPoint,
    options?: { button?: "left" | "right" },
  ): Promise<void>;
  clickSelector(selector: string): Promise<void>;
  hoverAt(point: ActPoint): Promise<void>;
  hoverSelector(selector: string): Promise<void>;
  /** Type into the focused element (a click usually precedes this). */
  typeText(text: string): Promise<void>;
  /**
   * Type into a specific element, replacing its current value.
   *
   * CONTRACT, in Playwright's own words because it is the reference engine:
   *
   *   - a `<select>` REJECTS with "not an `<input>`, `<textarea>` or
   *     `[contenteditable]`" — a list that does NOT offer `<select>`;
   *   - anything else unfillable REJECTS with a list that DOES.
   *
   * The one-item difference is load-bearing: `fill_form` falls back to
   * `selectOption` on the first and must not on the second, or a `fill` aimed
   * at a button is answered with whatever `selectOption` then fails for.
   *
   * An engine that fills by synthesising keystrokes has to check for itself,
   * because those keystrokes land on a `<select>` and change nothing at all —
   * and on a button they land after a CLICK, which is a side effect nobody
   * asked for. An engine that fails silently makes the fallback unreachable
   * there while it works everywhere else.
   */
  fillSelector(selector: string, text: string): Promise<void>;
  /** Press one key or chord ("Enter", "Control+A"). */
  press(key: string): Promise<void>;
  scrollBy(delta: { dx: number; dy: number }): Promise<void>;
  dragTo(from: ActPoint, to: ActPoint): Promise<void>;
  selectOption(selector: string, value: string): Promise<void>;
  /** Focus this tab in the window (what a human sees, and what `activate_tab` does). */
  bringToFront(): Promise<void>;
  /**
   * The page's readable text, markdown-ish and uncapped — the driver applies
   * the byte budget.
   *
   * One shared in-page function (`PAGE_TEXT_FN`) on every engine, for the same
   * reason the DOM signal is shared: two engines that describe one page
   * differently make an observation recorded on one meaningless on the other.
   */
  pageText(): Promise<string>;
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
   * How many console messages and page errors this page has EVER captured.
   *
   * Monotonic across the ring's own eviction and across a handoff purge, which
   * is the property that makes it a cursor: two ledger rows' values bracket the
   * window of console output a command produced, and the reader fetches that
   * window on demand instead of every row carrying a copy of the page's log.
   *
   * The counters keep climbing when entries are DROPPED, on purpose — the gap
   * between what a cursor promises and what the ring can still hand back is
   * real, and hiding it by decrementing would turn "48 messages you can no
   * longer read" into "nothing happened".
   *
   * Optional: an engine or a test fake that does not track them omits the
   * method, and the ledger simply records no cursor rather than a wrong one.
   */
  consoleCursor?(): { console: number; errors: number };
  /**
   * The dialog this page is currently blocked on, if any.
   *
   * A JavaScript dialog stops the renderer, so this is asked BEFORE anything
   * that would touch the page — a settle that runs against a blocked renderer
   * simply burns its whole budget and reports the page unsettled, which is a
   * true statement that explains nothing.
   *
   * Optional, like `consoleCursor`: an engine that does not track dialogs
   * omits it, and the driver behaves exactly as it did before rather than
   * refusing everything.
   */
  /**
   * What this page asked the network for, oldest first.
   *
   * Optional for the same reason `consoleCursor` is: an engine that does not
   * track requests omits it, and the observe mode reports that this browser
   * cannot answer rather than that the page made no requests. Those are very
   * different facts and a model acts differently on each.
   */
  networkEntries?(): readonly NetworkEntry[];
  /** Discard requests captured at or after `since` — the handoff purge. */
  dropNetworkSince?(since: number): void;
  /** How many requests this page has EVER captured. Monotonic, like console. */
  networkCursor?(): number;
  pendingDialog?(): PendingDialog | null;
  /**
   * Answer the pending dialog, unblocking the renderer.
   *
   * Resolves `false` when there was nothing to answer — a dialog the page
   * closed on its own, or a race with another answer. Never throws for that
   * case, because "it is already gone" is success from the caller's side.
   */
  resolveDialog?(accept: boolean, promptText?: string): Promise<boolean>;
  /**
   * The page's WebMCP bridge, attached lazily on first use (attaching a CDP
   * session to every tab that may never invoke a page tool is wasted work).
   * Resolves `null` when this build cannot speak the domain at all.
   */
  webmcp(): Promise<WebMcpBridge | null>;
  /**
   * A raw CDP session on this page, or `null` where one cannot be had (a unit
   * fake, a build without the plumbing).
   *
   * The viewport is written against this rather than against Playwright, so
   * one screencast-and-input implementation serves the local engine's
   * Playwright session, the hosted daemon's, and Electron's
   * `webContents.debugger` — none of which share anything else.
   */
  cdp(): Promise<CdpLike | null>;
  /** Resolve after a brief window with no in-flight requests, or on abort. */
  waitForNetworkIdle(signal: AbortSignal): Promise<void>;
  /** Resolve after one rendered frame, or on abort. */
  requestAnimationFrame(signal: AbortSignal): Promise<void>;
  /** A structural signal of the current DOM, for the L3 state token. */
  domStructureSignal(): Promise<string>;
  /**
   * A screenshot at the canonical observation viewport, base64-encoded.
   *
   * JPEG on every engine. This comment said PNG for a while and no engine ever
   * produced one: every act and navigate result carries a capture, and a
   * full-viewport PNG of a real page runs 100-400 KB, which becomes tens of
   * thousands of tokens once it reaches the model as image content. Consumers
   * sniff the format from the bytes, so the format is not part of the
   * contract — but a comment that names the wrong one invites a "fix" that
   * makes two engines disagree.
   */
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
