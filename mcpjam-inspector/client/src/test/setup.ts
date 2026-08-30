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
