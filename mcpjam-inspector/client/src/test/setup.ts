/**
 * Global test setup for client-side tests.
 * This file is automatically loaded before all tests run.
 */
import { vi, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { transferableAbortController } from "node:util";
import "@testing-library/jest-dom/vitest";

/**
 * Bridge jsdom's `AbortSignal` across to Node's `Request`.
 *
 * Two realms meet in this environment: jsdom implements `AbortController`, so
 * the global is jsdom's, while `Request` — which jsdom does not implement —
 * is Node's, from undici. undici validates `init.signal` with a brand check
 * against NODE's AbortSignal. Node 22 let a jsdom signal through; Node 24
 * rejects it outright:
 *
 *   TypeError: RequestInit: Expected signal ("AbortSignal {}") to be an
 *   instance of AbortSignal.
 *
 * React Router's data router builds `new Request(url, { signal })` on every
 * navigation, so on Node 24 every `router.navigate()` rejected and the
 * router's location never moved. Those tests failed as "the click did
 * nothing"; the real cause showed up only as an unhandled rejection in the run
 * summary, and only on CI, which pins Node 24 while local checkouts are
 * commonly on 22.
 *
 * The fix is deliberately NOT to swap the global for Node's class. jsdom's
 * `addEventListener(type, fn, { signal })` brand-checks the other way, so
 * doing that trades this failure for ~80 component-test failures. Only the
 * `Request` boundary is wrong, so only the `Request` boundary is patched: a
 * foreign signal is mirrored onto a Node one that forwards abort (and reason),
 * leaving both realms intact and cancellation working.
 */
const NodeAbortController = transferableAbortController()
  .constructor as typeof AbortController;
const NodeAbortSignal = Object.getPrototypeOf(
  new NodeAbortController().signal
).constructor as typeof AbortSignal;
const RealmRequest = globalThis.Request;

class BridgedSignalRequest extends RealmRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const signal = init?.signal;
    if (!signal || signal instanceof NodeAbortSignal) {
      super(input, init);
      return;
    }
    const bridge = new NodeAbortController();
    if (signal.aborted) {
      bridge.abort(signal.reason);
    } else {
      signal.addEventListener("abort", () => bridge.abort(signal.reason), {
        once: true,
      });
    }
    super(input, { ...init, signal: bridge.signal });
  }
}
globalThis.Request = BridgedSignalRequest;

// Cleanup after each test to prevent state leakage
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

// Mock window.matchMedia (required for responsive components)
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock ResizeObserver (required for some UI components). A plain class — NOT
// a vi.fn() — so a suite-level vi.restoreAllMocks() can't strip its
// implementation and break every later test that mounts a measuring
// component (Radix Switch/Slider use it via useSize).
global.ResizeObserver = class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// cmdk / Command dialogs call scrollIntoView on active items
Element.prototype.scrollIntoView = vi.fn();

// Radix UI primitives (Select, etc.) call Pointer Capture APIs that JSDOM lacks
Element.prototype.hasPointerCapture = vi.fn(() => false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

// CodeMirror measures DOM Range geometry, which JSDOM does not implement.
if (typeof Range !== "undefined") {
  const rect = {
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;

  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: vi.fn(() => rect),
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: vi.fn(() => ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    })),
  });
}

// Mock IntersectionObserver (required for lazy loading/virtual lists)
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
  root: null,
  rootMargin: "",
  thresholds: [],
}));

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  };
})();
Object.defineProperty(window, "localStorage", { value: localStorageMock });

// Mock fetch globally (can be overridden in individual tests)
global.fetch = vi.fn().mockImplementation(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(""),
    status: 200,
    headers: new Headers(),
  }),
);

// Suppress console errors during tests (can be enabled for debugging)
const originalError = console.error;
console.error = (...args: unknown[]) => {
  // Filter out React act() warnings and other noisy messages
  const message = args[0];
  if (
    typeof message === "string" &&
    (message.includes("act(") ||
      message.includes("Warning: ReactDOM.render") ||
      message.includes("Warning: An update to"))
  ) {
    return;
  }
  originalError.apply(console, args);
};

// Export for use in tests that need to reset localStorage
export { localStorageMock };

/**
 * jsdom draws nothing.
 *
 * `HTMLCanvasElement.getContext` is unimplemented (it warns and returns null)
 * and `createImageBitmap` does not exist at all, so the browser pane — which
 * paints frames onto a canvas from bitmaps decoded off the main thread — has
 * no way to exercise its own paint path under test. These are ENVIRONMENT
 * shims, not behaviour: nothing here decides anything, and the component code
 * runs exactly as it does in a browser.
 *
 * Deliberately not the `canvas` npm package: it is a native build, and this
 * suite needs a surface to call `drawImage` on rather than real rasterisation.
 */
if (typeof HTMLCanvasElement !== "undefined") {
  const canvasPrototype = HTMLCanvasElement.prototype as unknown as {
    getContext(id: string): unknown;
  };
  /**
   * One context per canvas, as a real browser gives.
   *
   * Components hold on to the object `getContext` returned and set properties
   * on it (`fillStyle`, `lineWidth`); a fresh one per call would silently
   * discard every one of those.
   */
  const contexts = new WeakMap<object, unknown>();

  /**
   * The 2D state a caller can READ BACK, with the value the spec gives it.
   *
   * Not a nicety. A proxy that answered every unknown member with a function
   * turned `ctx.globalAlpha * 0.5` into `NaN` and `ctx.font` into something no
   * `String.prototype` method would take — silently, on a component that had
   * simply never assigned that property first. A shim that makes reads
   * nonsense is worse than one that throws, because the test still passes.
   */
  const STATE_DEFAULTS: Readonly<Record<string, unknown>> = {
    direction: "inherit",
    fillStyle: "#000000",
    filter: "none",
    font: "10px sans-serif",
    fontKerning: "auto",
    fontStretch: "normal",
    fontVariantCaps: "normal",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "low",
    letterSpacing: "0px",
    lineCap: "butt",
    lineDashOffset: 0,
    lineJoin: "miter",
    lineWidth: 1,
    miterLimit: 10,
    shadowBlur: 0,
    shadowColor: "rgba(0, 0, 0, 0)",
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    strokeStyle: "#000000",
    textAlign: "start",
    textBaseline: "alphabetic",
    textRendering: "auto",
    wordSpacing: "0px",
  };

  /**
   * The calls that DRAW, which under jsdom is the calls that do nothing.
   *
   * Listed rather than "anything not otherwise known": a proxy that invents a
   * member on demand answers `'roundRect' in ctx` with `true` on an engine
   * that has never had it, which turns a feature check into a lie.
   */
  const NO_OP_METHODS: ReadonlySet<string> = new Set([
    "arc",
    "arcTo",
    "beginPath",
    "bezierCurveTo",
    "clearRect",
    "clip",
    "closePath",
    "createConicGradient",
    "drawFocusIfNeeded",
    "drawImage",
    "ellipse",
    "fill",
    "fillRect",
    "fillText",
    "lineTo",
    "moveTo",
    "putImageData",
    "quadraticCurveTo",
    "rect",
    "reset",
    "resetTransform",
    "rotate",
    "roundRect",
    "scale",
    "setLineDash",
    "setTransform",
    "stroke",
    "strokeRect",
    "strokeText",
    "transform",
    "translate",
  ]);

  /**
   * Members whose RETURN VALUE a caller reads, plus the state stack.
   *
   * A shim that only implemented what one component needed is a shim that
   * breaks the next one — which is exactly what happened: this suite's canvas
   * components call `setTransform`, `beginPath`, `arc` and a dozen others, and
   * an object with three methods on it turned each of those into a
   * `TypeError` inside a mount effect.
   */
  const withValues = (
    canvas: object,
    assigned: Map<string, unknown>,
  ): Record<string, unknown> => {
    /** `save`/`restore` are state, not drawing: a no-op `restore` leaves the
     * caller's own `globalAlpha` applied to everything painted after it. */
    const stack: Array<Map<string, unknown>> = [];
    return {
      canvas,
      save: () => {
        stack.push(new Map(assigned));
      },
      restore: () => {
        const previous = stack.pop();
        assigned.clear();
        if (previous)
          for (const [key, value] of previous) assigned.set(key, value);
      },
      isContextLost: () => false,
      getContextAttributes: () => ({ alpha: true, desynchronized: false }),
      measureText: () => ({ width: 0 }),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4),
        width: w,
        height: h,
      }),
      createImageData: (w: number, h: number) => ({
        data: new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4),
        width: w,
        height: h,
      }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      createPattern: () => null,
      isPointInPath: () => false,
      isPointInStroke: () => false,
      getLineDash: () => [] as number[],
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    };
  };

  canvasPrototype.getContext = function getContext(id: string) {
    // Only 2D. jsdom has no WebGL either, and a component that asks for one
    // should take its own no-context path rather than be handed a fake.
    if (id !== "2d") return null;
    const existing = contexts.get(this as unknown as object);
    if (existing) return existing;
    /** Whatever the component assigned — `fillStyle`, `font`, `lineWidth`. */
    const assigned = new Map<string, unknown>();
    const values = withValues(this as unknown as object, assigned);
    const known = (property: string): boolean =>
      assigned.has(property) ||
      property in values ||
      property in STATE_DEFAULTS ||
      NO_OP_METHODS.has(property);
    const context = new Proxy(
      {},
      {
        get(_target, property) {
          // NO SYMBOLS, and `then` above all: a proxy that answers `then`
          // with a function is a THENABLE, so `await ctx` hands the no-op the
          // resolve callback and the promise never settles. A hang, in a
          // suite, from a shim that was only meant to draw nothing.
          if (typeof property === "symbol") return undefined;
          if (assigned.has(property)) return assigned.get(property);
          if (property in values) return values[property];
          if (property in STATE_DEFAULTS) return STATE_DEFAULTS[property];
          // Everything else that a 2D context really has is a drawing call,
          // and jsdom draws nothing.
          if (NO_OP_METHODS.has(property)) return () => {};
          return undefined;
        },
        set(_target, property, value) {
          if (typeof property === "symbol") return true;
          assigned.set(property, value);
          return true;
        },
        // TRUE ONLY FOR WHAT IS REALLY THERE. `'x' in ctx` is how a component
        // asks whether this engine supports something.
        has: (_target, property) =>
          typeof property === "string" && known(property),
      },
    );
    contexts.set(this as unknown as object, context);
    return context;
  };
}

if (typeof globalThis.createImageBitmap !== "function") {
  (
    globalThis as unknown as {
      createImageBitmap: (source: Blob) => Promise<ImageBitmap>;
    }
  ).createImageBitmap = async (source: Blob) =>
    ({
      // Enough of the shape for a pane to draw and close it. The real one
      // reports the picture's dimensions; a test that cares asserts on the
      // frame record's geometry instead, which is what the pane actually maps
      // clicks through.
      width: 1,
      height: 1,
      close: () => {},
      _size: source.size,
    }) as unknown as ImageBitmap;
}
