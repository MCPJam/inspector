import { describe, expect, it, vi } from "vitest";
import {
  createElectronInputShield,
  type ShieldView,
  type ShieldViewConstructor,
  type ShieldWindow,
} from "../input-shield";
import { createContextSurface } from "../agent-surface";

/**
 * A `WebContentsView` narrowed to what the shield touches, plus a way for a
 * test to deliver an input event the way Electron's main process does.
 */
function fakeShieldView() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const view = {
    bounds: null as unknown,
    background: "",
    closed: false,
    loaded: [] as string[],
    setBounds(next: unknown) {
      view.bounds = next;
    },
    setBackgroundColor(color: string) {
      view.background = color;
    },
    webContents: {
      loadURL(url: string) {
        view.loaded.push(url);
        return Promise.resolve();
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        listeners.set(event, handler);
        return undefined;
      },
      close() {
        view.closed = true;
      },
      isDestroyed: () => view.closed,
    },
  };
  const emit = (input: { type: string; key?: string }) =>
    listeners.get("input-event")?.({}, input);
  return { view, emit };
}

function fakeWindow() {
  const children: unknown[] = [];
  const window = {
    children,
    destroyed: false,
    contentView: {
      addChildView: (view: unknown) => {
        children.push(view);
      },
      removeChildView: (view: unknown) => {
        const at = children.indexOf(view);
        if (at >= 0) children.splice(at, 1);
      },
    },
    isDestroyed: () => window.destroyed,
  };
  return window as unknown as ShieldWindow & typeof window;
}

function build() {
  const made: ReturnType<typeof fakeShieldView>[] = [];
  const View = function (this: unknown) {
    const fake = fakeShieldView();
    made.push(fake);
    return fake.view;
  } as unknown as ShieldViewConstructor;
  const window = fakeWindow();
  const onGesture = vi.fn();
  const shield = createElectronInputShield(View, window, onGesture);
  return { shield: shield!, window, onGesture, made };
}

describe("the native input shield", () => {
  it("covers the rectangle it is given, on top of what is already there", () => {
    const { shield, window } = build();
    // The browser view is parented first; the shield must land after it, or it
    // intercepts nothing and looks identical from the outside.
    window.contentView.addChildView({ id: "browser" } as never);
    shield.cover({ x: 4, y: 8, width: 100, height: 50 });
    expect(window.children).toHaveLength(2);
    expect((window.children[1] as ShieldView & { bounds: unknown }).bounds).toEqual({
      x: 4,
      y: 8,
      width: 100,
      height: 50,
    });
  });

  it("is transparent and runs nothing", () => {
    // A scrim would hide the page the person is watching; a script would be a
    // renderer this app has to reason about.
    const { shield, made } = build();
    shield.cover({ x: 0, y: 0, width: 10, height: 10 });
    expect(made[0]?.view.background).toBe("#00000000");
    expect(made[0]?.view.loaded).toEqual(["about:blank"]);
  });

  it("reports a click, a wheel and a keystroke", () => {
    const { shield, onGesture, made } = build();
    shield.cover({ x: 0, y: 0, width: 10, height: 10 });
    made[0]?.emit({ type: "mouseDown" });
    made[0]?.emit({ type: "mouseWheel" });
    made[0]?.emit({ type: "keyDown", key: "a" });
    expect(onGesture).toHaveBeenCalledTimes(3);
  });

  it("ignores a pointer merely crossing the window", () => {
    // Taking the agent's browser because a mouse passed over it on the way to
    // the chat box is the native version of taking it on a hover.
    const { shield, onGesture, made } = build();
    shield.cover({ x: 0, y: 0, width: 10, height: 10 });
    for (const type of ["mouseMove", "mouseEnter", "mouseLeave", "mouseUp"]) {
      made[0]?.emit({ type });
    }
    expect(onGesture).not.toHaveBeenCalled();
  });

  it("ignores a lone modifier, and a key release", () => {
    const { shield, onGesture, made } = build();
    shield.cover({ x: 0, y: 0, width: 10, height: 10 });
    for (const key of ["Shift", "Control", "Alt", "Meta"]) {
      made[0]?.emit({ type: "keyDown", key });
    }
    // The key that went down already took the browser.
    made[0]?.emit({ type: "keyUp", key: "a" });
    expect(onGesture).not.toHaveBeenCalled();
  });

  it("survives a listener that throws", () => {
    // The shield is the only thing between a stray click and the agent's page.
    const View = function () {
      return fakeShieldView().view;
    } as unknown as ShieldViewConstructor;
    void View;
    const { shield, made } = build();
    shield.cover({ x: 0, y: 0, width: 10, height: 10 });
    const throwing = createElectronInputShield(
      (function () {
        return made[0]!.view;
      } as unknown) as ShieldViewConstructor,
      fakeWindow(),
      () => {
        throw new Error("nope");
      },
    );
    throwing?.cover({ x: 0, y: 0, width: 10, height: 10 });
    expect(() => made[0]?.emit({ type: "mouseDown" })).not.toThrow();
  });

  it("re-parents a shield whose renderer died under it", () => {
    // A crashed renderer is replaced by `ensure()`. If the replacement is
    // treated as still attached it is merely positioned, belongs to no window,
    // and covers nothing — while `isShielded()` goes on reporting true and
    // every click reaches the agent's page.
    const { shield, window, made } = build();
    shield.cover({ x: 0, y: 0, width: 10, height: 10 });
    expect(window.children).toHaveLength(1);
    made[0]!.view.closed = true; // the renderer goes away
    shield.cover({ x: 0, y: 0, width: 10, height: 10 });
    expect(made).toHaveLength(2);
    expect(window.children).toContain(made[1]!.view);
  });

  it("comes out, and closes its renderer on dispose", () => {
    // An invisible view left behind outlives the browser it was covering and
    // goes on eating clicks in that rectangle.
    const { shield, window, made } = build();
    shield.cover({ x: 0, y: 0, width: 10, height: 10 });
    shield.remove();
    expect(window.children).toHaveLength(0);
    shield.dispose();
    expect(made[0]?.view.closed).toBe(true);
  });

  it("does nothing to a window that has gone", () => {
    const { shield, window } = build();
    window.destroyed = true;
    expect(() =>
      shield.cover({ x: 0, y: 0, width: 10, height: 10 }),
    ).not.toThrow();
    expect(window.children).toHaveLength(0);
  });
});

describe("the surface's use of the shield", () => {
  const bounds = { x: 0, y: 0, width: 100, height: 100 };

  function surfaceWith() {
    const covers: unknown[] = [];
    let removed = 0;
    const gestures: Array<() => void> = [];
    const surface = createContextSurface({
      onShieldGesture: () => gestures.forEach((fn) => fn()),
    });
    surface.setShieldFactory(({ onGesture }) => {
      gestures.push(onGesture);
      return {
        cover: (next) => covers.push(next),
        remove: () => {
          removed += 1;
        },
        dispose: () => {},
      };
    });
    return { surface, covers, removed: () => removed };
  }

  const view = () => ({
    setBounds: () => {},
    webContents: {},
  });

  it("shields the page while the agent is driving", () => {
    // The shield is up whenever input is not allowed, not only during the
    // transition — one that appeared after a click would never intercept the
    // click it exists for.
    const { surface, covers } = surfaceWith();
    surface.registerTab(view() as never);
    surface.show({ holder: fakeHolder(), bounds });
    expect(covers).toHaveLength(1);
  });

  it("uncovers the page the moment this pane holds the browser", () => {
    const { surface, removed } = surfaceWith();
    surface.registerTab(view() as never);
    surface.setPaneHolder("pane-1");
    surface.show({ holder: fakeHolder(), bounds });
    surface.setLease({ state: "held", holder: "pane-1" });
    expect(surface.isShielded()).toBe(false);
    expect(removed()).toBeGreaterThan(0);
  });

  it("takes the shield out when somebody else takes the browser", () => {
    // The surface stops being visible and the browser view is detached. A
    // shield left parented over it is an invisible rectangle over an app the
    // browser is no longer behind — the same failure `hide()` guards against,
    // reached by a different door.
    const { surface, removed } = surfaceWith();
    surface.registerTab(view() as never);
    surface.setPaneHolder("pane-1");
    surface.show({ holder: fakeHolder(), bounds });
    expect(surface.isShielded()).toBe(true);
    surface.setLease({ state: "held", holder: "somebody-else" });
    expect(surface.isShielded()).toBe(false);
    expect(removed()).toBeGreaterThan(0);
  });

  it("takes the shield out when the pane hides", () => {
    // A shield over a page nobody is showing eats the clicks meant for
    // whatever the pane switched to.
    const { surface, removed } = surfaceWith();
    surface.registerTab(view() as never);
    surface.show({ holder: fakeHolder(), bounds });
    surface.hide();
    expect(surface.isShielded()).toBe(false);
    expect(removed()).toBeGreaterThan(0);
  });

  it("reports a gesture up to whoever wired it", () => {
    // The surface does not acquire the lease itself: it has no client, and the
    // lease belongs to the daemon.
    const gestures: string[] = [];
    const surface = createContextSurface({
      onShieldGesture: () => gestures.push("gesture"),
    });
    let fire: (() => void) | undefined;
    surface.setShieldFactory(({ onGesture }) => {
      fire = onGesture;
      return { cover: () => {}, remove: () => {}, dispose: () => {} };
    });
    surface.registerTab(view() as never);
    surface.show({ holder: fakeHolder(), bounds });
    fire?.();
    expect(gestures).toEqual(["gesture"]);
  });

  it("works without a shield at all", () => {
    // A platform with no second view falls back to the behaviour that existed
    // before shields: a click reaches the page and does not take the browser.
    const surface = createContextSurface();
    surface.registerTab(view() as never);
    expect(() =>
      surface.show({ holder: fakeHolder(), bounds }),
    ).not.toThrow();
    expect(surface.isShielded()).toBe(false);
  });
});

function fakeHolder() {
  return {
    contentView: { addChildView: () => {}, removeChildView: () => {} },
    isDestroyed: () => false,
    destroy: () => {},
  } as never;
}
