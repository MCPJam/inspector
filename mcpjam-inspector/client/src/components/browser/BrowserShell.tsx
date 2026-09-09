import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
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
  type BrowserControlState,
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
  enabled?: boolean;
  state: BrowserSessionState;
  /** This pane's lease identity, for telling our hold from somebody else's. */
  holderId: string | null;
  /**
   * Who is driving, when the engine tracks it separately from the shell.
   *
   * BOTH exist because the two engines learn it differently and one of them
   * learns it first. The local body polls `/lease` on its own schedule and
   * knows the moment an acquire lands; the shell's state arrives on its own
   * poll a beat later. Deriving the status from the shell's copy alone would
   * make a person's own click show "the agent is driving" until the next
   * reconcile — which is the one moment the label must be right.
   *
   * Omitted by an engine with nothing better to say, and then the shell's own
   * state answers.
   */
  control?: BrowserControlState;
  holding?: boolean;
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
  /**
   * The engine's own empty or blocked state, shown INSTEAD of the page area.
   *
   * Wins over the start page, and the distinction matters: the start page
   * means "there is a browser and this tab is blank", while a placeholder
   * means "there is no browser" — an unauthorized machine, a Chromium that
   * needs downloading, a session that has gone. Showing "type an address
   * above" over a machine that has no browser to type into would be an
   * invitation to use a control that cannot work.
   */
  placeholder?: ReactNode;
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
  /**
   * The page area changed size.
   *
   * MEASURED HERE rather than in each engine's body, because this is the
   * element whose size the page should be: the area beneath the two control
   * rows, edge to edge. A body measuring its own container would include the
   * chrome and hand the session a viewport a few dozen pixels taller than the
   * page it is describing — which is exactly the kind of small, permanent
   * disagreement between the number and the picture that the whole responsive
   * path exists to avoid.
   *
   * Absent on an engine that cannot resize, in which case nothing observes.
   */
  onViewportMeasured?:
    | ((size: { width: number; height: number }) => void)
    | undefined;
}

export function BrowserShell({
  enabled = true,
  state,
  holderId,
  control: controlOverride,
  holding: holdingOverride,
  onCommand,
  onResumeAgent,
  resuming = false,
  children,
  trailing,
  placeholder,
  notice,
  error,
  ready = true,
  onViewportMeasured,
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

  const holding = holdingOverride ?? isHeldBy(state, holderId);
  const control = controlOverride ?? state.control;

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

  /**
   * Draw the start page only once the browser has actually said what it has.
   *
   * `seq` is what makes that a real question rather than a guess: it is zero
   * until the first snapshot lands, and non-zero forever after. Without the
   * check the shell covers the picture with "type an address above" for the
   * whole first poll interval of every session — and permanently on an engine
   * that cannot report its tabs at all, which is a browser showing a caption
   * where its page should be.
   */
  const startPage = state.seq > 0 && (!current || isBlank(current.url));

  // The page area's own size, watched only when somebody wants it.
  //
  // `ResizeObserver` rather than a window listener: the panel changes size
  // when a divider moves, when a rail collapses, when the app's own layout
  // reflows — and none of those is a window resize. Every one of them changes
  // the page's width, and a session that only heard about window resizes would
  // be describing a page whose layout had moved without it.
  const pageRef = useRef<HTMLDivElement | null>(null);
  const measuredRef = useRef(onViewportMeasured);
  measuredRef.current = onViewportMeasured;
  useEffect(() => {
    const element = pageRef.current;
    if (!enabled || !element || !onViewportMeasured) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      // Reported RAW. The coalescing, the debounce and the clamping all live
      // in the session barrier on the far side, which is the only place that
      // can order a resize against work in flight — doing any of it here would
      // be a second, quieter policy that the barrier then has to argue with.
      measuredRef.current?.({ width: box.width, height: box.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, onViewportMeasured]);

  if (!enabled) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {placeholder ?? children}
        {error ? (
          <div role="alert" className="px-3 text-xs text-destructive">
            {error}
          </div>
        ) : null}
      </div>
    );
  }

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
        control={control}
        holding={holding}
        {...(onResumeAgent && holding ? { onResumeAgent } : {})}
        resuming={resuming}
        {...(trailing ? { trailing } : {})}
      />
      <div ref={pageRef} className="relative min-h-0 flex-1 overflow-hidden">
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
        {placeholder ?? (startPage ? <BrowserStartPage /> : children)}
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
