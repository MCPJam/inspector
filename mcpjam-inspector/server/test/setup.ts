/**
 * Global test setup for server-side tests.
 *
 * Console output is suppressed locally for cleaner test output,
 * but preserved in CI for debugging failed tests.
 *
 * Set VERBOSE_TESTS=1 to see console output locally.
 */
import { vi, afterEach, beforeAll, afterAll } from "vitest";

const isCI = process.env.CI === "true";
const isVerbose = process.env.VERBOSE_TESTS === "1";
const shouldSuppressConsole = !isCI && !isVerbose;

// Store original console methods
const originalConsole = {
  log: console.log,
  debug: console.debug,
  error: console.error,
  warn: console.warn,
};

// Suppress console output during tests (only locally)
// In CI, we want to see all output for debugging failures
if (shouldSuppressConsole) {
  beforeAll(() => {
    console.log = vi.fn();
    console.debug = vi.fn();
    console.error = vi.fn();
    console.warn = vi.fn();
  });

  afterAll(() => {
    console.log = originalConsole.log;
    console.debug = originalConsole.debug;
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
  });
}

afterEach(() => {
  vi.clearAllMocks();
});
