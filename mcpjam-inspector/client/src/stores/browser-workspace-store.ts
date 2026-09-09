/**
 * Where the browser sits in the Playground, and how big it is.
 *
 * LIFTED OUT OF THE RAIL, and that is the whole change. The browser used to be
 * a tab inside the right rail — one of three, beside Logs and Shell, in a
 * 30%-wide column whose visibility was `useState` in `PlaygroundTab`. That is
 * a fine place for a log viewer and a bad one for a browser: a page rendered
 * at 30% of a workspace is a page in its mobile layout, and every time
 * somebody looked at the logs the browser's own visibility state was decided
 * by a component that did not know a browser existed.
 *
 * So the browser gets its own panel beside chat, and its layout lives here:
 *
 *   - A STORE, not React state, because three unrelated things move it. The
 *     agent starting to browse opens it. The person dragging the divider
 *     sizes it. The rail's own controls collapse and restore it. State that
 *     three callers write and two components read is state that belongs
 *     outside both of them.
 *   - PERSISTED, because a layout somebody chose is a preference and not a
 *     session detail. Coming back to a workspace that has forgotten how wide
 *     you made the browser is the kind of small betrayal that makes people
 *     stop resizing things.
 *   - SEPARATE FROM THE SESSION. Collapsing the panel must not close the
 *     browser: an agent mid-login whose browser was torn down because
 *     somebody wanted more room for chat has lost the login. What a hidden
 *     panel DOES stop is claiming — the watch that defers the idle reap and
 *     the measurement that drives the session viewport — and that is the
 *     `visible` flag's whole job.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

/** How much of the workspace the browser takes when it first opens. */
export const DEFAULT_BROWSER_PANEL_SIZE = 60;
/** Small enough to be a sliver, large enough to still be a browser. */
export const MIN_BROWSER_PANEL_SIZE = 25;
export const MAX_BROWSER_PANEL_SIZE = 85;

export interface BrowserWorkspaceState {
  /** Is the browser panel on screen? */
  open: boolean;
  /** Its share of the workspace, as a percentage. */
  size: number;
  /**
   * Is the browser filling the app window?
   *
   * "Expanded" is the CURRENT window, deliberately, and not a new one:
   * separate browser windows are explicitly out of scope, and a person who
   * expands a browser to look at something wants it back where it was
   * afterwards — which a second window makes into a window-management task.
   */
  expanded: boolean;
  /**
   * Did the workspace already collapse the Sessions rail for this browser?
   *
   * Recorded so it happens ONCE. Opening the browser takes the room from the
   * rail, which is the right trade the first time; doing it again every time
   * the panel reopens would fight a person who deliberately put the rail back.
   */
  collapsedRailForBrowser: boolean;
  openBrowser: () => void;
  closeBrowser: () => void;
  setSize: (size: number) => void;
  setExpanded: (expanded: boolean) => void;
  noteRailCollapsed: () => void;
}

const STORAGE_KEY = "mcpjam.playground.browserWorkspace";

export const useBrowserWorkspaceStore = create<BrowserWorkspaceState>()(
  persist(
    (set) => ({
      open: false,
      size: DEFAULT_BROWSER_PANEL_SIZE,
      expanded: false,
      collapsedRailForBrowser: false,
      openBrowser: () =>
        set((state) =>
          // Idempotent, because the thing that calls it is "the agent used the
          // browser" — which happens on every tool call, not once per session.
          state.open ? state : { ...state, open: true },
        ),
      closeBrowser: () =>
        set((state) =>
          state.open || state.expanded
            ? // Collapsing an EXPANDED browser puts it away entirely rather
              // than leaving it expanded-but-hidden, which is a state that
              // only becomes visible the confusing way: reopening it later
              // takes over the whole window with no obvious cause.
              { ...state, open: false, expanded: false }
            : state,
        ),
      setSize: (size) =>
        set((state) => {
          const clamped = Math.min(
            MAX_BROWSER_PANEL_SIZE,
            Math.max(MIN_BROWSER_PANEL_SIZE, Math.round(size)),
          );
          return state.size === clamped ? state : { ...state, size: clamped };
        }),
      setExpanded: (expanded) =>
        set((state) =>
          state.expanded === expanded ? state : { ...state, expanded },
        ),
      noteRailCollapsed: () =>
        set((state) =>
          state.collapsedRailForBrowser
            ? state
            : { ...state, collapsedRailForBrowser: true },
        ),
    }),
    {
      name: STORAGE_KEY,
      // `open` and `expanded` are deliberately NOT persisted, and the two
      // omissions have different reasons. A workspace that reopened the
      // browser on load would start a browser session nobody asked for, on a
      // metered box, before the person had said anything. And a workspace that
      // restored `expanded` would open covering the chat somebody came back to
      // read, with the control to undo it off in the corner of a panel they
      // did not expect.
      partialize: (state) => ({
        size: state.size,
        collapsedRailForBrowser: state.collapsedRailForBrowser,
      }),
    },
  ),
);
