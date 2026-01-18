/**
 * Global test setup for client-side tests.
 * This file is automatically loaded before all tests run.
 */
import { vi, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Cleanup after each test to prevent state leakage
afterEach(() => {
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

// Mock ResizeObserver (required for some UI components)
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

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
  })
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
