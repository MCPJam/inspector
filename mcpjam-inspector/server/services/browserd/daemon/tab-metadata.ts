/**
 * What a tab strip needs to draw a tab, read over CDP.
 *
 * The title, the favicon and the two history flags were the four facts the
 * panes could not get. Not because they are hard — Chromium has all of them —
 * but because nothing carried them: the hosted stream had a `{id, url}` list
 * riding an 8 KiB heartbeat, the local stream carried frames only, and
 * Electron has no stream between the view and the window at all.
 *
 * OVER CDP, deliberately, and that is what makes one implementation serve all
 * three. `Page.getNavigationHistory` is answered identically by Playwright's
 * `CDPSession`, the hosted daemon's, and Electron's `webContents.debugger`, so
 * a strip that reads from here shows the same thing on a laptop, in a sandbox
 * and in the desktop app. The alternative — a `title()` on `DriverPage`, a
 * `canGoBack()` beside it — is three implementations of four getters, which is
 * three chances for the desktop app's forward button to be wrong in a way
 * nobody notices.
 *
 * `Page.getNavigationHistory` also answers the history question the page
 * itself cannot: `history.length` counts entries in both directions and says
 * nothing about which way you can go, so a forward button driven from it is
 * enabled on a fresh tab that has only ever gone forward.
 */

import type { CdpLike } from "./webmcp-bridge";

export interface TabMetadata {
  url: string;
  /** Empty when the document has none. @see BrowserTabState.title */
  title: string;
  faviconUrl?: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface NavigationHistory {
  currentIndex: number;
  entries: Array<{ id?: number; url?: string; title?: string }>;
}

/**
 * Read a tab's navigation history, or null when the session cannot answer.
 *
 * NULL rather than a throw. Every caller here is a strip refreshing itself on
 * a heartbeat, and a tab that closed between the list being taken and this
 * being asked is the ordinary case, not a fault: CDP answers with an error for
 * a target that is gone, and letting that propagate would take the whole
 * snapshot down because one tab closed at the wrong moment.
 */
async function navigationHistory(
  cdp: CdpLike,
): Promise<NavigationHistory | null> {
  try {
    const raw = (await cdp.send("Page.getNavigationHistory")) as
      | Partial<NavigationHistory>
      | undefined;
    if (
      typeof raw?.currentIndex !== "number" ||
      !Array.isArray(raw?.entries)
    ) {
      return null;
    }
    return { currentIndex: raw.currentIndex, entries: raw.entries };
  } catch {
    return null;
  }
}

/**
 * The page's declared favicon, absolute, or undefined.
 *
 * EVALUATED rather than guessed at `/favicon.ico`. The guess is wrong for most
 * of the modern web — a single-page app declares an SVG or a data: URL, and a
 * site behind a path prefix serves nothing at the root — and a wrong guess is
 * worse than nothing here: the strip would show a broken-image glyph for a
 * page that has a perfectly good icon, on every tab.
 *
 * The expression is deliberately tiny and side-effect free. It runs in the
 * page's own world, which is hostile content, so it reads one attribute and
 * returns a string; anything it returns is treated as untrusted and length-
 * capped by the caller.
 */
const FAVICON_EXPRESSION = `(() => {
  const link = document.querySelector(
    'link[rel~="icon" i], link[rel="shortcut icon" i], link[rel~="apple-touch-icon" i]'
  );
  return link ? link.href : "";
})()`;

/** Longest favicon URL we will carry. A data: URL can be a whole image. */
const MAX_FAVICON_CHARS = 2048;
/** Longest title. A page can set a novel as its title, and some do. */
const MAX_TITLE_CHARS = 256;

async function favicon(cdp: CdpLike): Promise<string | undefined> {
  try {
    const raw = (await cdp.send("Runtime.evaluate", {
      expression: FAVICON_EXPRESSION,
      returnByValue: true,
      // A page that has installed a Proxy on `document.querySelector` cannot
      // make this hang the strip; a page that throws is simply a page with no
      // icon.
      timeout: 1_000,
    })) as { result?: { value?: unknown } } | undefined;
    const value = raw?.result?.value;
    if (typeof value !== "string" || !value) return undefined;
    // Only schemes a renderer will actually paint. `javascript:` in an <img>
    // src does nothing, but it has no business being copied into the app's own
    // DOM, and the strip renders this straight into an `img`.
    if (
      !value.startsWith("https://") &&
      !value.startsWith("http://") &&
      !value.startsWith("data:image/")
    ) {
      return undefined;
    }
    if (value.length > MAX_FAVICON_CHARS) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Everything the strip needs for one tab.
 *
 * `fallbackUrl` is what the driver already knows from `page.url()`, used when
 * CDP cannot answer at all — a tab mid-teardown, an engine whose session has
 * detached. A strip entry with a URL and no title is a great deal better than
 * a strip entry that vanishes and comes back.
 */
export async function readTabMetadata(
  cdp: CdpLike | null,
  fallbackUrl: string,
  options: { favicon?: boolean } = {},
): Promise<TabMetadata> {
  if (!cdp) {
    return {
      url: fallbackUrl,
      title: "",
      canGoBack: false,
      canGoForward: false,
    };
  }
  const history = await navigationHistory(cdp);
  const current = history?.entries[history.currentIndex];
  const icon = options.favicon === false ? undefined : await favicon(cdp);
  return {
    url: current?.url ?? fallbackUrl,
    title: (current?.title ?? "").slice(0, MAX_TITLE_CHARS),
    ...(icon ? { faviconUrl: icon } : {}),
    // A history of one entry is a tab that has been nowhere. Chromium counts
    // the current document as an entry, so `currentIndex > 0` — not
    // `entries.length > 1` — is the question "is there something behind me".
    canGoBack: !!history && history.currentIndex > 0,
    canGoForward:
      !!history && history.currentIndex < history.entries.length - 1,
  };
}
