import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerAgentBrowserListeners,
  resolveViewportBounds,
  type AgentBrowserViewportResult,
} from "./agent-browser-listeners.js";
import {
  createContextSurface,
  registerContextSurface,
  resetContextSurfacesForTests,
  type ContextSurface,
  type SurfaceView,
} from "../../../server/services/browserd/electron/agent-surface.js";

// `electron-log` writes to a real log file the moment it is loaded, and there
// is no Electron here to give it an app path.
vi.mock("electron-log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
// A plain Node process resolves `electron` to a STRING (the path to a binary),
// so the named imports would be undefined. Only `ipcMain` and
// `WebContentsView` are touched, and both are injected by every test here.
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  WebContentsView: undefined,
}));

/** A `contentView` that records what was parented into it. */
function fakeWindow(
  options: { id?: number; contentSize?: [number, number] } = {},
) {
  const children: SurfaceView[] = [];
  const bounds: Array<{ x: number; y: number; width: number; height: number }> =
    [];
  return {
    children,
    bounds,
    zoom: 1,
    webContents: {
      id: options.id ?? 7,
      getZoomFactor: () => window_.zoom,
    },
    contentView: {
      addChildView: (view: SurfaceView) => {
        if (!children.includes(view)) children.push(view);
      },
      removeChildView: (view: SurfaceView) => {
        const at = children.indexOf(view);
        if (at >= 0) children.splice(at, 1);
      },
    },
    getContentSize: () => options.contentSize ?? [1200, 800],
    isDestroyed: () => false,
    destroy: () => {},
  };
}
let window_: ReturnType<typeof fakeWindow>;

function fakeView(): SurfaceView & {
  bounds?: { x: number; y: number; width: number; height: number };
} {
  const view: SurfaceView & {
    bounds?: { x: number; y: number; width: number; height: number };
  } = {
    setBounds(next) {
      view.bounds = next;
    },
    webContents: { id: 42, isDestroyed: () => false },
  };
  return view;
}

/** Register the handlers over a fake `ipcMain` and hand back the two of them. */
function install(
  options: {
    mainWindow?: ReturnType<typeof fakeWindow> | null;
    surfaces?: Map<string, ContextSurface>;
    supported?: boolean;
  } = {},
) {
  const handlers = new Map<string, (event: any, request: any) => unknown>();
  const surfaces = options.surfaces ?? new Map<string, ContextSurface>();
  registerAgentBrowserListeners(
    () => (options.mainWindow ?? window_) as never,
    {
      surfaceFor: (bootId) => surfaces.get(bootId),
      nativeSurfaceSupported: () => options.supported ?? true,
      ipc: {
        handle: (
          channel: string,
          listener: (event: any, request: any) => unknown,
        ) => {
          handlers.set(channel, listener);
        },
      } as never,
    },
  );
  const senderId = (options.mainWindow ?? window_)?.webContents.id ?? 7;
  return {
    surfaces,
    capability: (id = senderId) =>
      handlers.get("agent-browser:capability")!(
        { sender: { id } },
        undefined,
      ) as {
        available: boolean;
      },
    setViewport: (request: unknown, id = senderId) =>
      handlers.get("agent-browser:set-viewport")!(
        { sender: { id } },
        request,
      ) as AgentBrowserViewportResult,
  };
}

const BOUNDS = { x: 10, y: 20, width: 300, height: 200 };

beforeEach(() => {
  resetContextSurfacesForTests();
  window_ = fakeWindow();
});

describe("resolveViewportBounds", () => {
  it("scales the renderer's CSS pixels by the zoom factor", () => {
    // The renderer measured in ITS pixels. At 110% zoom those are BIGGER than
    // the window's, so a view placed at the raw numbers sits inside its slot —
    // the page visibly not filling the rail it is supposed to be in.
    expect(resolveViewportBounds(BOUNDS, 1.5, [2000, 2000])).toEqual({
      x: 15,
      y: 30,
      width: 450,
      height: 300,
    });
  });

  it("clamps to the window's content size", () => {
    // `setBounds` will happily paint a live browser over the app's own chrome,
    // or off the bottom of the window entirely.
    expect(
      resolveViewportBounds(
        { x: 100, y: 100, width: 900, height: 900 },
        1,
        [500, 400],
      ),
    ).toEqual({ x: 100, y: 100, width: 400, height: 300 });
  });

  it("refuses anything that is not a rectangle", () => {
    for (const bad of [
      undefined,
      null,
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 10, height: -5 },
      { x: Number.NaN, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 },
      { x: 0, y: 0, width: 1_000_000, height: 10 },
      // Entirely off the bottom of the window: nothing of it is on screen.
      { x: 0, y: 900, width: 100, height: 100 },
    ]) {
      expect(resolveViewportBounds(bad as never, 1, [800, 800])).toBeNull();
    }
  });

  it("keeps a negative origin, which is an ordinary scrolled slot", () => {
    // The window clips it, exactly as the rail's own overflow would clip a
    // canvas. Refusing it would make the view vanish the moment a person
    // scrolled the pane a pixel.
    expect(
      resolveViewportBounds(
        { x: -40, y: -10, width: 300, height: 200 },
        1,
        [800, 800],
      ),
    ).toEqual({ x: -40, y: -10, width: 300, height: 200 });
  });

  it("survives a zoom factor Electron could not answer", () => {
    expect(resolveViewportBounds(BOUNDS, Number.NaN, undefined)).toEqual(
      BOUNDS,
    );
    expect(resolveViewportBounds(BOUNDS, 0, undefined)).toEqual(BOUNDS);
  });
});

describe("agent-browser:capability", () => {
  it("says whether this Electron can place a view", () => {
    expect(install({ supported: true }).capability()).toEqual({
      available: true,
    });
    expect(install({ supported: false }).capability()).toEqual({
      available: false,
    });
  });

  it("refuses a sender that is not the main window", () => {
    // The same check `local-harness:pick-workspace` makes. A channel that moves
    // a live browser view into the app's window is exactly the kind a stray
    // webview must not reach.
    expect(install().capability(999)).toEqual({ available: false });
  });
});

describe("agent-browser:set-viewport", () => {
  const withSurface = (holder = "rail-1") => {
    const surface = createContextSurface();
    const view = fakeView();
    surface.registerTab(view);
    surface.setLease({ state: "held", holder });
    registerContextSurface("boot-1", surface);
    const surfaces = new Map<string, ContextSurface>([["boot-1", surface]]);
    return { surface, view, api: install({ surfaces }) };
  };

  it("parents the view into the app's window at the pane's bounds", () => {
    const { view, api } = withSurface();
    const result = api.setViewport({
      bootId: "boot-1",
      holder: "rail-1",
      visible: true,
      bounds: BOUNDS,
    });
    expect(result).toEqual({ shown: true, inputAllowed: true });
    expect(window_.children).toContain(view);
    // POSITION from the pane, SIZE from the session. A view's bounds ARE its
    // CSS viewport on this engine, so taking the size from whatever the pane
    // measured would let dragging the window silently change the coordinate
    // space the agent is reasoning in — with no revision bump and no
    // stale-observation refusal to catch it.
    expect(view.bounds).toMatchObject({ x: BOUNDS.x, y: BOUNDS.y });
  });

  it("takes the view back out when the pane stops wanting it", () => {
    // The one piece of teardown that cannot be skipped: a native view is a
    // SIBLING of the renderer, so one left behind keeps painting a browser
    // over whatever the rail switched to.
    const { view, api } = withSurface();
    api.setViewport({
      bootId: "boot-1",
      holder: "rail-1",
      visible: true,
      bounds: BOUNDS,
    });
    expect(window_.children).toContain(view);
    expect(api.setViewport({ bootId: "boot-1", visible: false })).toEqual({
      shown: false,
      inputAllowed: false,
    });
    expect(window_.children).not.toContain(view);
  });

  it("hides rather than shows a browser somebody else holds", () => {
    // THE LEASE DECIDES, not the renderer. A visible native view of a page
    // another person is typing their password into is an observation, which is
    // the one thing the lease exists to prevent — so the answer is a refusal
    // the pane can explain, not a view it merely cannot click.
    const { view, api } = withSurface("someone-else");
    const result = api.setViewport({
      bootId: "boot-1",
      holder: "rail-1",
      visible: true,
      bounds: BOUNDS,
    });
    expect(result).toEqual({
      shown: false,
      inputAllowed: false,
      reason: "lease",
    });
    expect(window_.children).not.toContain(view);
  });

  it("shows but refuses input while the agent is driving", () => {
    // `free` means nobody has taken the browser and the AGENT may be mid-turn.
    // Watching is the safe common case; typing into it is not.
    const surface = createContextSurface();
    const view = fakeView();
    surface.registerTab(view);
    const api = install({
      surfaces: new Map<string, ContextSurface>([["boot-1", surface]]),
    });
    expect(
      api.setViewport({
        bootId: "boot-1",
        holder: "rail-1",
        visible: true,
        bounds: BOUNDS,
      }),
    ).toEqual({ shown: true, inputAllowed: false });
    expect(window_.children).toContain(view);
  });

  it("refuses a boot id nobody registered", () => {
    const api = install();
    expect(
      api.setViewport({ bootId: "nope", visible: true, bounds: BOUNDS }),
    ).toEqual({ shown: false, inputAllowed: false, reason: "unknown" });
    expect(api.setViewport({ visible: true } as never)).toMatchObject({
      reason: "unknown",
    });
  });

  it("refuses a sender that is not the main window, before anything moves", () => {
    const { view, api } = withSurface();
    expect(
      api.setViewport(
        { bootId: "boot-1", holder: "rail-1", visible: true, bounds: BOUNDS },
        999,
      ),
    ).toEqual({ shown: false, inputAllowed: false, reason: "no_window" });
    expect(window_.children).not.toContain(view);
  });

  it("takes the view out when the rectangle stops being one", () => {
    // A pane measured mid-layout, or scrolled entirely out of the window. The
    // view must not stay where it last was, or it hangs over whatever the rail
    // is showing now.
    const { view, api } = withSurface();
    api.setViewport({
      bootId: "boot-1",
      holder: "rail-1",
      visible: true,
      bounds: BOUNDS,
    });
    expect(
      api.setViewport({
        bootId: "boot-1",
        holder: "rail-1",
        visible: true,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      }),
    ).toEqual({ shown: false, inputAllowed: false, reason: "bad_bounds" });
    expect(window_.children).not.toContain(view);
  });

  it("applies the window's zoom factor to what the renderer measured", () => {
    // The renderer measures in ITS CSS pixels, and a zoomed rail's numbers are
    // smaller than the window's by exactly that factor — so a view positioned
    // from them sits inside its slot at 110% zoom and overhangs it at 90%.
    // Only the POSITION reaches the view; the size is the session's.
    const { view, api } = withSurface();
    window_.zoom = 2;
    api.setViewport({
      bootId: "boot-1",
      holder: "rail-1",
      visible: true,
      bounds: { x: 5, y: 6, width: 100, height: 50 },
    });
    expect(view.bounds).toMatchObject({ x: 10, y: 12 });
  });

  it("reports the zoomed SIZE as a viewport request rather than applying it", () => {
    // The size is a request the session decides on, through a barrier that
    // coalesces a drag and refuses to resize mid-action.
    const requested: Array<{ width: number; height: number }> = [];
    const surface = createContextSurface({
      onViewportRequest: (size) => requested.push(size),
    });
    surface.registerTab(fakeView());
    surface.setLease({ state: "held", holder: "rail-1" });
    const api = install({
      surfaces: new Map<string, ContextSurface>([["boot-1", surface]]),
    });
    window_.zoom = 2;
    api.setViewport({
      bootId: "boot-1",
      holder: "rail-1",
      visible: true,
      bounds: { x: 5, y: 6, width: 100, height: 50 },
    });
    expect(requested).toContainEqual({ width: 200, height: 100 });
  });
});
