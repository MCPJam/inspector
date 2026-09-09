/**
 * The native surface's rules.
 *
 * Everything here is about a REAL view the user can click into, which is what
 * makes it different from every other pane in this codebase: a picture cannot
 * leak, and a native view showing a page somebody else is typing a password
 * into is exactly the observation the lease exists to prevent. So the gate is
 * the daemon's lease, and these pin what it decides.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  contextSurfaceCount,
  contextSurfaceFor,
  createContextSurface,
  forgetContextSurface,
  registerContextSurface,
  resetContextSurfacesForTests,
  type SurfaceView,
} from "../agent-surface";

/** A `WebContentsView` double that records where it was put. */
function fakeView(name: string) {
  const view = {
    name,
    bounds: undefined as unknown,
    setBounds(next: unknown) {
      view.bounds = next;
    },
    webContents: { id: name.length },
  };
  return view as unknown as SurfaceView & { name: string; bounds: unknown };
}

/** A `BaseWindow` double whose child list is observable. */
function fakeWindow() {
  const children: SurfaceView[] = [];
  let destroyed = false;
  return {
    children,
    contentView: {
      addChildView(view: SurfaceView) {
        if (!children.includes(view)) children.push(view);
      },
      removeChildView(view: SurfaceView) {
        const at = children.indexOf(view);
        if (at >= 0) children.splice(at, 1);
      },
    },
    isDestroyed: () => destroyed,
    destroy() {
      destroyed = true;
    },
  };
}

const BOUNDS = { x: 8, y: 40, width: 1024, height: 768 };

beforeEach(() => resetContextSurfacesForTests());

describe("which view is on screen", () => {
  it("shows the newest tab, because that is the one Chromium shows", () => {
    const surface = createContextSurface();
    const holder = fakeWindow();
    const first = fakeView("a");
    const second = fakeView("b");
    surface.registerTab(first);
    surface.show({ holder, bounds: BOUNDS });
    expect(holder.children).toEqual([first]);
    surface.registerTab(second);
    expect(holder.children).toEqual([second]);
    expect(second.bounds).toEqual(BOUNDS);
  });

  it("follows the model's activate_tab", () => {
    const surface = createContextSurface();
    const holder = fakeWindow();
    const first = fakeView("a");
    const second = fakeView("b");
    surface.registerTab(first);
    surface.registerTab(second);
    surface.show({ holder, bounds: BOUNDS });
    surface.setActive(first);
    expect(holder.children).toEqual([first]);
  });

  it("falls back to the most recent remaining tab when one closes", () => {
    const surface = createContextSurface();
    const holder = fakeWindow();
    const first = fakeView("a");
    const second = fakeView("b");
    surface.registerTab(first);
    surface.registerTab(second);
    surface.show({ holder, bounds: BOUNDS });
    surface.forget(second);
    expect(holder.children).toEqual([first]);
  });

  it("shows nothing at all once the last tab is gone", () => {
    const surface = createContextSurface();
    const holder = fakeWindow();
    const only = fakeView("a");
    surface.registerTab(only);
    surface.show({ holder, bounds: BOUNDS });
    surface.forget(only);
    expect(holder.children).toEqual([]);
    expect(surface.isShown()).toBe(false);
  });

  it("re-positions without reparenting when the pane moves", () => {
    // The pane sends geometry whenever its rail moves; a surface that
    // reparented on each would tear the page down and rebuild it several times
    // a drag.
    const surface = createContextSurface();
    const holder = fakeWindow();
    const view = fakeView("a");
    surface.registerTab(view);
    surface.show({ holder, bounds: BOUNDS });
    const moved = { ...BOUNDS, x: BOUNDS.x + 120, y: BOUNDS.y + 30 };
    surface.show({ holder, bounds: moved });
    expect(holder.children).toEqual([view]);
    expect(view.bounds).toMatchObject({ x: moved.x, y: moved.y });
  });

  it("does NOT resize the page when the pane's measurement changes", () => {
    // On Electron a view's bounds ARE its CSS viewport, so the old version of
    // this — bounds straight from the pane — meant dragging the window changed
    // the coordinate space the agent was reasoning in, with no revision bump
    // and no stale-observation refusal to catch it.
    const requested: Array<{ width: number; height: number }> = [];
    const surface = createContextSurface({
      onViewportRequest: (size) => {
        requested.push(size);
      },
    });
    const holder = fakeWindow();
    const view = fakeView("a");
    surface.registerTab(view);
    surface.show({ holder, bounds: BOUNDS });
    surface.show({ holder, bounds: { ...BOUNDS, width: 600 } });

    expect(view.bounds).toMatchObject({ width: BOUNDS.width });
    // Reported, so the session can decide — which is a different thing from
    // applied.
    expect(requested).toContainEqual({ width: 600, height: BOUNDS.height });
  });

  it("takes the page to a new size only when the session says so", () => {
    const surface = createContextSurface();
    const holder = fakeWindow();
    const view = fakeView("a");
    surface.registerTab(view);
    surface.show({ holder, bounds: BOUNDS });
    surface.setViewport({ width: 1400, height: 900 });
    expect(view.bounds).toEqual({
      x: BOUNDS.x,
      y: BOUNDS.y,
      width: 1400,
      height: 900,
    });
  });

  it("gives a newly activated tab the session's size, not the pane's", () => {
    const surface = createContextSurface();
    const holder = fakeWindow();
    const first = fakeView("a");
    surface.registerTab(first);
    surface.show({ holder, bounds: { ...BOUNDS, width: 600 } });
    surface.setViewport({ width: 1400, height: 900 });

    const second = fakeView("b");
    surface.registerTab(second);
    // Two tabs in one session rendering at two sizes has no honest number to
    // publish for either.
    expect(second.bounds).toMatchObject({ width: 1400, height: 900 });
  });

  it("takes the view back out when the pane hides", () => {
    const surface = createContextSurface();
    const holder = fakeWindow();
    const view = fakeView("a");
    surface.registerTab(view);
    surface.show({ holder, bounds: BOUNDS });
    surface.hide();
    expect(holder.children).toEqual([]);
  });
});

describe("the lease decides", () => {
  function shown() {
    const surface = createContextSurface();
    const holder = fakeWindow();
    const view = fakeView("a");
    surface.setPaneHolder("rail-1");
    surface.registerTab(view);
    surface.show({ holder, bounds: BOUNDS });
    return { surface, holder, view };
  }

  it("shows the page while the agent drives, and refuses input", () => {
    // Watching is the safe common case — the whole point of the pane — but
    // with nobody holding it the agent may be mid-turn, and two drivers on one
    // page is what the lease prevents.
    const { surface, holder } = shown();
    surface.setLease({ state: "free" });
    expect(holder.children).toHaveLength(1);
    expect(surface.inputAllowed()).toBe(false);
  });

  it("admits input once THIS pane holds it", () => {
    const { surface, holder } = shown();
    surface.setLease({ state: "held", holder: "rail-1" });
    expect(holder.children).toHaveLength(1);
    expect(surface.inputAllowed()).toBe(true);
  });

  it("HIDES the view when somebody else holds it", () => {
    // Not merely deafened. A visible native view of a page somebody else is
    // typing a password into is an observation.
    const { surface, holder } = shown();
    surface.setLease({ state: "held", holder: "rail-2" });
    expect(holder.children).toEqual([]);
    expect(surface.inputAllowed()).toBe(false);
  });

  it("keeps it hidden while their lease is PARKED", () => {
    // A parked lease still belongs to its holder: a timer running out is not
    // evidence the private moment ended.
    const { surface, holder } = shown();
    surface.setLease({ state: "parked", holder: "rail-2" });
    expect(holder.children).toEqual([]);
  });

  it("hides it from a script holder too", () => {
    // A script over CDP blocks the agent exactly as a person does, and its
    // page is no more this pane's to display.
    const { surface, holder } = shown();
    surface.setLease({ state: "held", holder: "cdp-script" });
    expect(holder.children).toEqual([]);
  });

  it("brings it back when they hand it over", () => {
    const { surface, holder } = shown();
    surface.setLease({ state: "held", holder: "rail-2" });
    expect(holder.children).toEqual([]);
    surface.setLease({ state: "free" });
    expect(holder.children).toHaveLength(1);
  });

  it("refuses input from a pane with no identity of its own", () => {
    // A pane that never told the surface who it is cannot be the holder, so it
    // cannot be admitted — the alternative is admitting anybody.
    const surface = createContextSurface();
    surface.setLease({ state: "held", holder: "rail-1" });
    expect(surface.inputAllowed()).toBe(false);
  });

  it("deafens the view while it is visible but not this pane's", () => {
    const refused: SurfaceView[] = [];
    const surface = createContextSurface({
      onVisibilityRefused: (view) => refused.push(view),
    });
    const holder = fakeWindow();
    const view = fakeView("a");
    surface.setPaneHolder("rail-1");
    surface.registerTab(view);
    surface.show({ holder, bounds: BOUNDS });
    surface.setLease({ state: "free" });
    expect(refused).toContain(view);
  });
});

describe("the registry", () => {
  it("addresses a surface only by boot id", () => {
    // What the renderer knows, and the only thing it may name: a renderer that
    // could address a surface by index could reach somebody else's browser by
    // guessing.
    const surface = createContextSurface();
    registerContextSurface("boot-1", surface);
    expect(contextSurfaceFor("boot-1")).toBe(surface);
    expect(contextSurfaceFor("boot-2")).toBeUndefined();
    expect(contextSurfaceCount()).toBe(1);
    forgetContextSurface("boot-1");
    expect(contextSurfaceFor("boot-1")).toBeUndefined();
  });
});

describe("teardown", () => {
  it("releases the view and refuses to show another", () => {
    const surface = createContextSurface();
    const holder = fakeWindow();
    const view = fakeView("a");
    surface.registerTab(view);
    surface.show({ holder, bounds: BOUNDS });
    surface.dispose();
    expect(holder.children).toEqual([]);
    surface.show({ holder, bounds: BOUNDS });
    expect(holder.children).toEqual([]);
  });

  it("survives a window destroyed underneath it", () => {
    const surface = createContextSurface();
    const holder = fakeWindow();
    const view = fakeView("a");
    surface.registerTab(view);
    surface.show({ holder, bounds: BOUNDS });
    holder.destroy();
    expect(() => surface.hide()).not.toThrow();
  });
});
