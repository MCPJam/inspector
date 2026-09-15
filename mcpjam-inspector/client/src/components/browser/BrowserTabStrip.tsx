import { useEffect, useState } from "react";
import { Globe, Loader2, Plus, X } from "lucide-react";
import { cn } from "@mcpjam/design-system/cn";
import type { BrowserTabState } from "../../../../shared/browser-session-state";

/**
 * The tabs, as tabs.
 *
 * The old strip was read-only labels showing each tab's HOST, drawn only when
 * there were two or more, because switching tabs was the model's to do and a
 * clickable strip would have been a second, quieter path into the lease's
 * state machine. That reasoning was right while taking control was a button.
 * It stops being right the moment using the browser IS taking it: a strip you
 * cannot click is not a browser, and the thing it was protecting — one driver
 * at a time — is now enforced by the click itself acquiring the lease.
 *
 * So: titles, favicons, close buttons, a new-tab button, and one tab is still
 * a strip. A browser that grows its tab bar when you open a second tab makes
 * the page jump under the pointer at the exact moment somebody is aiming at
 * something.
 *
 * THE TITLE, NOT THE URL, with the host only as the fallback. The old strip
 * showed the host to keep reset tokens and share links off a screen somebody
 * else can see, and that concern is real — it is why the address field still
 * shows the host at rest. A title is not a URL and carries none of that; it is
 * also what every browser shows and what a person scans for.
 */

export interface BrowserDisplayTab extends BrowserTabState {
  clientName?: string;
  clientLogo?: string | null;
  unavailable?: boolean;
}

export interface BrowserTabStripProps {
  tabs: readonly BrowserDisplayTab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNewTab: () => void;
  /**
   * Are the controls live?
   *
   * False while the shell has no browser to drive — a session still starting,
   * a socket reconnecting. The strip stays VISIBLE and goes inert rather than
   * disappearing: a tab bar that vanishes on a reconnect is a browser that
   * looks like it crashed.
   */
  disabled?: boolean;
  newTabDisabled?: boolean;
}

export function BrowserTabStrip({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onNewTab,
  disabled = false,
  newTabDisabled = false,
}: BrowserTabStripProps) {
  return (
    <div
      role="tablist"
      aria-label="Browser tabs"
      data-testid="browser-tab-strip"
      className="flex min-w-0 shrink-0 items-center gap-1 overflow-x-auto px-2 pt-1.5"
    >
      {tabs.map((tab) => (
        <BrowserTab
          key={tab.id}
          tab={tab}
          active={tab.id === activeTabId}
          disabled={disabled}
          onActivate={() => onActivate(tab.id)}
          onClose={tab.unavailable ? undefined : () => onClose(tab.id)}
        />
      ))}
      <button
        type="button"
        onClick={onNewTab}
        disabled={disabled || newTabDisabled}
        aria-label="New tab"
        title="New tab"
        data-testid="browser-new-tab"
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
          "hover:bg-accent hover:text-accent-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:pointer-events-none disabled:opacity-50",
        )}
      >
        <Plus className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

function BrowserTab({
  tab,
  active,
  disabled,
  onActivate,
  onClose,
}: {
  tab: BrowserDisplayTab;
  active: boolean;
  disabled: boolean;
  onActivate: () => void;
  onClose?: (() => void) | undefined;
}) {
  const pageLabel = tabLabel(tab);
  const label = tab.clientName ? `${tab.clientName} · ${pageLabel}` : pageLabel;
  return (
    // A DIV rather than nested buttons: the close control lives inside the tab
    // and a button inside a button is invalid HTML that browsers resolve by
    // dropping one of them — usually the one you wanted.
    <div
      role="tab"
      aria-label={label}
      aria-selected={active}
      // The tab is the thing in the tab order; the close button is reachable
      // after it. `-1` while disabled keeps a dead control out of the sequence
      // rather than letting focus land somewhere that does nothing.
      tabIndex={disabled ? -1 : 0}
      title={label}
      data-testid="browser-tab"
      data-active={active ? "true" : undefined}
      onClick={disabled ? undefined : onActivate}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate();
        }
      }}
      className={cn(
        "group flex h-7 min-w-0 max-w-[11rem] shrink-0 cursor-default items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        disabled && "pointer-events-none opacity-60",
      )}
    >
      {tab.loading ? (
        <Loader2
          className="size-3.5 shrink-0 animate-spin"
          aria-label="Loading"
        />
      ) : (
        <TabIcon
          tab={
            tab.clientLogo && tab.clientName
              ? { ...tab, faviconUrl: tab.clientLogo }
              : tab
          }
        />
      )}
      {tab.clientName && (
        <span className="max-w-[7rem] shrink-0 truncate">
          {tab.clientName} ·
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{pageLabel}</span>
      {onClose ? (
        <button
          type="button"
          aria-label={`Close ${label}`}
          data-testid="browser-tab-close"
          onClick={(event) => {
            // Or the click closes the tab AND activates it, and the strip
            // spends a frame showing a tab that is on its way out.
            event.stopPropagation();
            onClose();
          }}
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors",
            "hover:bg-chrome-control-hover hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            // Revealed on hover and on focus, and ALWAYS on the active tab.
            // A control that only exists on hover is one a keyboard cannot
            // find, and `focus-visible` inside `group-hover` does not cover
            // the case where focus arrives without the pointer.
            active
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/**
 * The favicon, or a glyph.
 *
 * `onError` falls back rather than leaving a broken image, because a great
 * many declared favicons are 404s and a strip of broken-image icons is worse
 * than a strip of globes. The image is decorative — the tab's accessible name
 * is its title — so it is hidden from assistive technology entirely.
 */
function TabIcon({ tab }: { tab: BrowserTabState }) {
  /**
   * Did this URL fail to load?
   *
   * Hiding the broken image left an empty square where every other tab has an
   * icon, and a great many declared favicons are 404s — so that was the common
   * case, not the rare one. Reset when the URL changes: the last icon's failure
   * says nothing about the next one.
   */
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [tab.faviconUrl]);
  if (!tab.faviconUrl || failed) {
    return <Globe className="size-3.5 shrink-0 opacity-70" aria-hidden />;
  }
  return (
    <img
      src={tab.faviconUrl}
      alt=""
      aria-hidden
      // The page chose this URL. `referrerPolicy` keeps the URL of whatever
      // the agent is looking at out of the request for its icon.
      referrerPolicy="no-referrer"
      className="size-3.5 shrink-0 rounded-[2px] object-contain"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * What to call a tab.
 *
 * The title when the page set one, the host when it did not, and "New tab" for
 * a blank page — which is what `about:blank` is here, since that is where the
 * shell's own start page is drawn.
 */
export function tabLabel(tab: { url: string; title: string }): string {
  if (tab.title) return tab.title;
  if (!tab.url || tab.url === "about:blank") return "New tab";
  try {
    return new URL(tab.url).host || tab.url;
  } catch {
    return tab.url;
  }
}
