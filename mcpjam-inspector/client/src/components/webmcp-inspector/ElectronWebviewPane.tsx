import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { WEBMCP_WEBVIEW_PARTITION } from "@/shared/webmcp-inspector-protocol";

/**
 * THE ONLY PLACE IN THE APP THAT TOUCHES A `<webview>`.
 *
 * That containment is deliberate and load-bearing. The tag is still shipped in
 * Electron 43 and its "not recommended" status has not moved in years, but it
 * carries no removal signal either — so the bet is hedged by geometry rather
 * than by avoiding it: the server only ever learns a `webContentsId`, so
 * migrating to `WebContentsView` later is a rewrite of this ONE component with
 * zero protocol change and zero provider change.
 *
 * NEVER REPARENT THE ELEMENT. Moving a `<webview>` in the DOM destroys its
 * guest and silently takes the session's surface with it — which is why the
 * element is rendered in one fixed position here and the pane is keyed per
 * session attempt by its caller rather than reused across them.
 *
 * The attributes are exactly three, and each one earns its place:
 *   - `src="about:blank"`, because the FIRST real navigation belongs to the
 *     provider: it happens inside the WebMCP probe callback, after the CDP
 *     domains are enabled, or tools registered during page load are never
 *     reported at all;
 *   - `partition`, which is the string `will-attach-webview` and the server's
 *     ownership check both test against;
 *   - `allowpopups`, without which `window.open` returns null and every
 *     sign-in flow in an inspected page breaks. The provider's window-open
 *     handler is what makes those popups safe (hardened, same partition, left
 *     open and un-driven).
 *
 * Not present, on purpose: `nodeintegration`, `preload`, `webpreferences`,
 * `disablewebsecurity`. `will-attach-webview` overrides all four anyway — this
 * element's attributes are a request, not a fact — but asking for something the
 * main process would strip is a lie in the source.
 */

/** How long to wait for the guest to exist before giving up on it. */
const READY_TIMEOUT_MS = 5_000;

export interface ElectronWebviewHandle {
  /**
   * The guest's `webContentsId`, once there is a guest.
   *
   * A promise rather than a getter because `getWebContentsId()` THROWS before
   * the guest attaches, and the attach is asynchronous — a caller reading it on
   * the same tick as the mount gets an exception rather than an id. Resolves on
   * the first `dom-ready`.
   */
  readyWebContentsId(): Promise<number>;
}

export interface ElectronWebviewPaneProps {
  /** Called on every main-frame navigation the guest performs. */
  onNavigate?: (url: string) => void;
  /** Called when the guest could not be brought up at all. */
  onError?: (message: string) => void;
}

/** The subset of the `<webview>` element this component uses. */
interface WebviewElement extends HTMLElement {
  getWebContentsId(): number;
  getURL(): string;
}

export const ElectronWebviewPane = forwardRef<
  ElectronWebviewHandle,
  ElectronWebviewPaneProps
>(function ElectronWebviewPane({ onNavigate, onError }, ref) {
  const elementRef = useRef<WebviewElement | null>(null);
  const [ready, setReady] = useState(false);
  /**
   * Resolvers waiting on the first `dom-ready`.
   *
   * A list rather than a single promise because the handle may be asked more
   * than once (a re-render between mount and attach), and because the id has to
   * be answerable BEFORE the element exists — the tab calls this immediately
   * after mounting the pane, which is the whole point of mount-then-start.
   */
  const waiters = useRef<
    Array<{ resolve: (id: number) => void; reject: (error: Error) => void }>
  >([]);
  /** Set once the guest exists, so a later ask answers without waiting. */
  const attachedId = useRef<number | undefined>(undefined);

  const settle = useCallback(() => {
    const element = elementRef.current;
    if (!element) return;
    let id: number;
    try {
      id = element.getWebContentsId();
    } catch {
      // `dom-ready` fired but the guest is not attached yet, which should not
      // happen — treated as "keep waiting" rather than as a failure, because
      // the timeout below is the honest way to give up.
      return;
    }
    attachedId.current = id;
    setReady(true);
    for (const waiter of waiters.current.splice(0)) waiter.resolve(id);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      readyWebContentsId: () =>
        new Promise<number>((resolve, reject) => {
          if (attachedId.current !== undefined) {
            resolve(attachedId.current);
            return;
          }
          waiters.current.push({ resolve, reject });
        }),
    }),
    [],
  );

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const onDomReady = () => settle();
    const onDidNavigate = () => onNavigate?.(element.getURL());
    element.addEventListener("dom-ready", onDomReady);
    element.addEventListener("did-navigate", onDidNavigate);
    // In-page (History API) navigations are not `did-navigate`, and a
    // single-page app does most of its navigating that way — a URL bar that
    // ignored them would go stale the moment someone clicked a link.
    element.addEventListener("did-navigate-in-page", onDidNavigate);

    // A guest that never attaches would otherwise leave the caller's
    // `readyWebContentsId()` pending forever, and the tab waiting on it with an
    // "Opening page…" overlay and no way out.
    const timer = setTimeout(() => {
      if (attachedId.current !== undefined) return;
      const failure = new Error(
        "The embedded browser did not start. Close this session and try again.",
      );
      for (const waiter of waiters.current.splice(0)) waiter.reject(failure);
      onError?.(failure.message);
    }, READY_TIMEOUT_MS);

    return () => {
      clearTimeout(timer);
      element.removeEventListener("dom-ready", onDomReady);
      element.removeEventListener("did-navigate", onDidNavigate);
      element.removeEventListener("did-navigate-in-page", onDidNavigate);
      // Anyone still waiting when the pane goes away gets an answer rather than
      // a promise nobody will ever settle.
      for (const waiter of waiters.current.splice(0)) {
        waiter.reject(new Error("The embedded browser was closed."));
      }
    };
  }, [settle, onNavigate, onError]);

  return (
    <div className="relative min-h-0 flex-1 border-b bg-muted/20">
      {/* `webview` is not in React's JSX intrinsics, and the ref types do not
          line up either — it is an Electron element, not a DOM standard one.
          The cast is contained here along with everything else about the tag. */}
      {createWebview({
        ref: (node: WebviewElement | null) => {
          elementRef.current = node;
        },
      })}
      {ready ? null : (
        <p className="absolute inset-0 flex items-center justify-center bg-background/80 text-xs text-muted-foreground">
          Opening page…
        </p>
      )}
    </div>
  );
});

/**
 * The element itself, in the one expression that has to lie to TypeScript.
 *
 * Kept apart from the component so the `any` is a single line with a name
 * rather than a cast in the middle of the tree, and so it is obvious that
 * NOTHING else in this file — or this app — constructs one.
 */
function createWebview(props: { ref: (node: never) => void }) {
  const Tag = "webview" as unknown as React.ElementType;
  return (
    <Tag
      {...props}
      src="about:blank"
      partition={WEBMCP_WEBVIEW_PARTITION}
      // Without it `window.open` returns null and sign-in flows break. The
      // provider's handler decides what actually opens.
      allowpopups="true"
      className="h-full w-full"
      style={{ display: "flex" }}
    />
  );
}
