import {
  useCallback,
  useEffect,
  useReducer,
  type ReactNode,
} from "react";
import { cn } from "@mcpjam/design-system/cn";
import { BrowserTabStrip } from "@/components/browser/BrowserTabStrip";
import { BrowserNavigationBar } from "@/components/browser/BrowserNavigationBar";
import { BrowserStartPage } from "@/components/browser/BrowserStartPage";
import {
  addressFieldTarget,
  EMPTY_ADDRESS_FIELD,
  reduceAddressField,
  type AddressFieldEvent,
} from "@/lib/browser-shell/address-field";
import {
  activeTab as activeTabOf,
  isHeldBy,
  type BrowserSessionState,
} from "../../../../shared/browser-session-state";
import type { BrowserPaneCommand } from "../../../../shared/browser-pane-command";

/**
 * The browser, around whatever is drawing the page.
 *
 * ONE shell for three engines, wrapped around the rendering adapters rather
 * than replacing them. The local stream, the hosted H.264 stream and
 * Electron's native `WebContentsView` keep their transports — they are
 * genuinely different problems — but the tabs, the address, the history
 * buttons and the ownership status are the same browser in all three, and
 * three copies of "what should the forward button do" is three chances for
 * the desktop app's to be subtly wrong.
 *
 * The children are the PAGE AREA and nothing else: edge to edge beneath the
 * two control rows, with no padding of its own, because the panel's width is
 * the page's width and a shell that inset the picture by 12px would make every
 * responsive breakpoint land 24 pixels off where the person put the divider.
 */

export interface BrowserShellProps {
  state: BrowserSessionState;
  /** This pane's lease identity, for telling our hold from somebody else's. */
  holderId: string | null;
  /**
   * Send one command. The shell never touches the lease itself — using the
   * browser acquires it, and that happens inside this call.
   */
  onCommand: (command: BrowserPaneCommand) => void;
  /** Hand the browser back and let the agent continue from a fresh look. */
  onResumeAgent?: (() => void) | undefined;
  resuming?: boolean;
  /** The picture: a canvas, a video, or nothing at all on the native surface. */
  children?: ReactNode;
  /** The quality menu and the stats toggle, which differ per engine. */
  trailing?: ReactNode;
  /** A transient note over the page — a dropped click, a tab the agent opened. */
  notice?: string | null;
  error?: string | null;
  /**
   * Is there a browser to drive?
   *
   * False while a session is starting or a socket is reconnecting. The
   * controls go inert and stay visible: a tab bar that disappears on a
   * reconnect is a browser that looks like it crashed.
   */
  ready?: boolean;
}

export function BrowserShell({
  state,
  holderId,
  onCommand,
  onResumeAgent,
  resuming = false,
  children,
  trailing,
  notice,
  error,
  ready = true,
}: BrowserShellProps) {
  const [address, dispatchAddress] = useReducer(
    reduceAddressField,
    EMPTY_ADDRESS_FIELD,
  );
  const current = activeTabOf(state);
  const url = current?.url ?? "";

  // The browser's own URL, fed in as an event rather than read from props at
  // render time — which is what lets the reducer hold it back while somebody
  // is typing. @see address-field.ts
  useEffect(() => {
    dispatchAddress({ type: "url", url: aboutBlankIsEmpty(url) });
  }, [url]);

  const holding = isHeldBy(state, holderId);

  const onAddress = useCallback(
    (event: AddressFieldEvent) => {
      // The target is read from the state we are holding NOW, before the
      // reducer runs: `commit` is the event that clears the draft, so reading
      // afterwards would find nothing to navigate to. The reducer stays pure
      // and the effect stays here, which is the split that makes the field's
      // interleavings testable without a DOM.
      if (event.type === "commit") {
        const target = addressFieldTarget(address);
        if (target) onCommand({ op: "navigate", url: target });
      }
      dispatchAddress(event);
    },
    [address, onCommand],
  );

  const startPage = !current || isBlank(current.url);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <BrowserTabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        disabled={!ready}
        onActivate={(tabId) => onCommand({ op: "activate_tab", tabId })}
        onClose={(tabId) => onCommand({ op: "close_tab", tabId })}
        onNewTab={() => onCommand({ op: "create_tab" })}
      />
      <BrowserNavigationBar
        address={address}
        onAddress={onAddress}
        canGoBack={state.canGoBack}
        canGoForward={state.canGoForward}
        disabled={!ready}
        onBack={() => onCommand({ op: "back" })}
        onForward={() => onCommand({ op: "forward" })}
        onReload={() => onCommand({ op: "reload" })}
        control={state.control}
        holding={holding}
        {...(onResumeAgent && holding ? { onResumeAgent } : {})}
        resuming={resuming}
        {...(trailing ? { trailing } : {})}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {notice ? (
          <div
            data-testid="browser-notice"
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute inset-x-0 top-2 z-10 mx-auto w-fit rounded-md bg-foreground/85 px-2 py-1 text-[11px] text-background"
          >
            {notice}
          </div>
        ) : null}
        {startPage ? <BrowserStartPage /> : children}
      </div>
      {error ? (
        <div
          className={cn("shrink-0 px-3 pb-2 text-xs text-destructive")}
          data-testid="browser-error"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** Is this tab showing nothing? `about:blank` is where the start page lives. */
function isBlank(url: string): boolean {
  return !url || url === "about:blank";
}

/** A blank tab's address field is EMPTY, not the literal `about:blank`. */
function aboutBlankIsEmpty(url: string): string {
  return isBlank(url) ? "" : url;
}
