import { useRef } from "react";

/**
 * This tab's identity as a local-browser lease holder.
 *
 * Shared by the Browser pane (which acquires) and the Tools pane (which must
 * name the same holder to read the page while this tab has control). A second
 * key here would list "someone has the browser" for a hold that is ours.
 */
export const LOCAL_BROWSER_HOLDER_STORAGE_KEY = "mcpjam.localBrowser.holder";

/**
 * A lease identity that survives a reload but not the tab.
 *
 * `sessionStorage` can throw (a private window, blocked site data) and can
 * come back empty, so every path falls back to a fresh in-memory id: losing
 * stability costs a wedged lease until it expires, while throwing here would
 * take the whole pane down.
 */
export function usePaneHolderId(): string {
  const ref = useRef<string | null>(null);
  if (ref.current === null) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const minted = `rail-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    try {
      const stored = window.sessionStorage.getItem(
        LOCAL_BROWSER_HOLDER_STORAGE_KEY,
      );
      if (stored) {
        ref.current = stored;
      } else {
        window.sessionStorage.setItem(LOCAL_BROWSER_HOLDER_STORAGE_KEY, minted);
        ref.current = minted;
      }
    } catch {
      ref.current = minted;
    }
  }
  return ref.current;
}
