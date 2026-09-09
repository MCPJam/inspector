import { ipcMain, WebContentsView } from "electron";
import type { BrowserWindow } from "electron";
import log from "electron-log";
// Safe to import statically, unlike the rest of the server graph: this module
// is deliberately import-free at module scope — reaching it through
// `electron-context.ts` would drag in the page, the CDP adapter and
// `utils/logger.ts`, which initialises Sentry and Axiom as a side effect of
// being loaded. See that file's header, and `agent-windows.js` beside it.
import {
  contextSurfaceFor,
  type ContextSurface,
  type SurfaceWindow,
} from "../../../server/services/browserd/electron/agent-surface.js";

/**
 * The privileged half of "show the agent's browser in the rail".
 *
 * ── Why this channel exists ──────────────────────────────────────────────
 * On the desktop app the agent's browser is a real `WebContentsView` in this
 * process. Sending it to the pane as JPEGs over a socket — encode, base64,
 * parse, decode, paint — is a round trip through three format changes to show
 * somebody a page their own machine already has. Parenting the view into the
 * app's own window at the rail's bounds skips all of it: no encoder, no socket,
 * and input latency that is a repaint rather than a round trip.
 *
 * Only the MAIN PROCESS can reparent a view, so the renderer has to ask. What
 * it may say is deliberately tiny: a boot id, a holder name, whether it wants
 * the view on screen, and a rectangle. It cannot name a window, a `webContents`
 * or a partition, so the worst a compromised renderer can do through here is
 * put the agent's own browser in the wrong place in the app's own window.
 *
 * ── What this handler is NOT ─────────────────────────────────────────────
 * It is not the input gate. `visible: true` is a REQUEST; the surface answers
 * to the daemon's lease (`daemon/lease.ts`'s `onChange`), which is the same
 * authority that already refuses the model's commands. A renderer that asks to
 * be shown while somebody else holds the browser is refused here and told so —
 * a client-side gate is not a gate, and this is the client's side of it.
 *
 * The sender-identity check is the same one `local-harness-listeners.ts` uses,
 * and for the same reason: an IPC channel that moves a live browser view into
 * the app's window is exactly the kind a stray webview must not reach.
 */

/** What the renderer is allowed to say about where it wants the view. */
export interface AgentBrowserViewportRequest {
  bootId: string;
  /** This pane's lease identity, compared against the daemon's holder. */
  holder?: string;
  takeover?: boolean;
  /** Does the pane want the page on screen at all? */
  visible: boolean;
  /** The rail's slot, in the RENDERER's CSS pixels. */
  bounds?: { x: number; y: number; width: number; height: number };
}

/** What it gets back: what actually happened, never what it asked for. */
export interface AgentBrowserViewportResult {
  /** Is a view parented into the window right now? */
  shown: boolean;
  /** May this person's clicks reach the page? The LEASE decides. */
  inputAllowed: boolean;
  /**
   * Why not, when `shown` is false and the pane asked for it.
   *
   * `unknown` — no browser by that boot id (a stale pane, or a browser that
   * was reaped). `no_window` — the app has no window to put it in.
   * `bad_bounds` — the rectangle was not a rectangle. `lease` — somebody else
   * holds this browser, and a visible native view of a page they are typing
   * into is an observation.
   */
  reason?: "unknown" | "no_window" | "bad_bounds" | "lease";
}

/**
 * The most a renderer may ask for, in device-independent pixels.
 *
 * Not a safety boundary — the clamp to the window's content size below is —
 * but a bound on the arithmetic, so a pane that measured itself during a
 * layout glitch cannot ask for a view a million pixels wide.
 */
const MAX_DIMENSION = 20_000;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * The renderer's rectangle, in the window's coordinates, or null.
 *
 * TWO conversions, both load-bearing. `getZoomFactor()` because the renderer
 * measured in ITS CSS pixels and a zoomed rail's numbers are smaller than the
 * window's by exactly that factor — without it the page sits inside its slot at
 * 110% zoom and overhangs it at 90%. And a clamp to the window's content size,
 * because `setBounds` will happily put a live browser view over the app's own
 * chrome if asked.
 */
export function resolveViewportBounds(
  bounds: AgentBrowserViewportRequest["bounds"],
  zoomFactor: number,
  contentSize: [number, number] | undefined,
): { x: number; y: number; width: number; height: number } | null {
  if (!bounds || typeof bounds !== "object") return null;
  const { x, y, width, height } = bounds;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height)
  ) {
    return null;
  }
  const zoom = isFiniteNumber(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const scaled = {
    x: Math.round(x * zoom),
    y: Math.round(y * zoom),
    width: Math.round(width * zoom),
    height: Math.round(height * zoom),
  };
  if (scaled.width <= 0 || scaled.height <= 0) return null;
  if (scaled.width > MAX_DIMENSION || scaled.height > MAX_DIMENSION) {
    return null;
  }
  // A slot scrolled off the top of the rail is a negative origin, which is
  // ordinary rather than hostile: the view is clipped by the window, exactly
  // as the pane's own overflow would clip a canvas.
  const [contentWidth, contentHeight] = contentSize ?? [];
  if (isFiniteNumber(contentWidth) && isFiniteNumber(contentHeight)) {
    const right = Math.min(scaled.x + scaled.width, contentWidth);
    const bottom = Math.min(scaled.y + scaled.height, contentHeight);
    scaled.width = right - scaled.x;
    scaled.height = bottom - scaled.y;
    if (scaled.width <= 0 || scaled.height <= 0) return null;
  }
  return scaled;
}

/** Everything the handlers touch, injectable so a test needs no Electron. */
export interface AgentBrowserDeps {
  surfaceFor?: (bootId: string) => ContextSurface | undefined;
  /** Does this Electron have the constructors the native surface needs? */
  nativeSurfaceSupported?: () => boolean;
  ipc?: Pick<typeof ipcMain, "handle">;
}

export function registerAgentBrowserListeners(
  getMainWindow: () => BrowserWindow | null,
  deps: AgentBrowserDeps = {},
): void {
  const surfaceFor = deps.surfaceFor ?? contextSurfaceFor;
  const ipc = deps.ipc ?? ipcMain;
  // Asked of the Electron this app is actually running, not of its version: a
  // build without `WebContentsView` can still drive the browser through hidden
  // windows, and the pane must fall back rather than show a rail that never
  // paints.
  const supported =
    deps.nativeSurfaceSupported ??
    (() => typeof WebContentsView === "function");

  /** Is this event from the window we put the UI in, or from a stray frame? */
  const trusted = (event: { sender: { id: number } }, channel: string) => {
    const mainWindow = getMainWindow();
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
      log.warn(
        `Ignoring ${channel} from untrusted sender (id: ${event.sender.id})`,
      );
      return null;
    }
    return mainWindow;
  };

  /**
   * Can this renderer be shown a real browser at all?
   *
   * Asked BEFORE any browser exists, because it decides whether the pane opens
   * a frame socket — and a pane that opened one and then discovered it had a
   * native surface would have paid for an encode nobody looks at.
   */
  ipc.handle("agent-browser:capability", (event) => {
    if (!trusted(event, "agent-browser:capability")) {
      return { available: false } as const;
    }
    return { available: supported() } as const;
  });

  ipc.handle(
    "agent-browser:set-viewport",
    (event, request: AgentBrowserViewportRequest) => {
      const refused = (
        reason: AgentBrowserViewportResult["reason"],
      ): AgentBrowserViewportResult => ({
        shown: false,
        inputAllowed: false,
        ...(reason ? { reason } : {}),
      });
      const mainWindow = trusted(event, "agent-browser:set-viewport");
      if (!mainWindow) return refused("no_window");
      const bootId =
        request && typeof request.bootId === "string" ? request.bootId : "";
      if (!bootId) return refused("unknown");
      const surface = surfaceFor(bootId);
      // A boot id nobody registered is a pane looking at a browser that has
      // gone — a reap, a project switch, or an engine that never had views.
      // Reported rather than thrown: the pane's answer is to fall back to
      // frames, not to show an error over a browser that is simply not there.
      if (!surface) return refused("unknown");

      surface.setPaneHolder(
        typeof request.holder === "string" && request.holder
          ? request.holder
          : undefined,
        request.takeover === true,
      );

      if (!request.visible) {
        surface.hide();
        return { shown: false, inputAllowed: surface.inputAllowed() };
      }

      const bounds = resolveViewportBounds(
        request.bounds,
        mainWindow.webContents.getZoomFactor(),
        mainWindow.getContentSize() as [number, number],
      );
      if (!bounds) {
        // A rectangle that is not a rectangle — a pane measured mid-layout, a
        // slot scrolled entirely out of the window. The view comes OUT rather
        // than staying where it last was, or it would hang over whatever the
        // rail is showing now.
        surface.hide();
        return refused("bad_bounds");
      }

      surface.show({
        holder: mainWindow as unknown as SurfaceWindow,
        bounds,
      });
      const shown = surface.isShown();
      return {
        shown,
        inputAllowed: surface.inputAllowed(),
        // Not shown despite a good rectangle means the LEASE refused it, which
        // is the one refusal the pane has something to say about.
        ...(shown ? {} : { reason: "lease" as const }),
      };
    },
  );
}
