/**
 * Test utilities for client-side testing.
 * Provides helper functions for common testing patterns.
 *
 * Note: React component testing utilities (renderWithProviders, etc.)
 * require @testing-library/react to be installed. These utilities
 * are currently disabled. Install @testing-library/react to enable them.
 */
import { vi } from "vitest";

/**
 * Helper to wait for async state updates.
 * Useful when testing components that fetch data.
 *
 * @example
 * await waitForLoadingToFinish();
 */
export async function waitForLoadingToFinish(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Creates a mock function that tracks calls and can be awaited.
 * Useful for testing async handlers.
 *
 * @example
 * const onSubmit = createAsyncMock();
 * somethingThatCallsOnSubmit();
 * await onSubmit.waitForCall();
 * expect(onSubmit).toHaveBeenCalledWith({ name: "test" });
 */
export function createAsyncMock<T = unknown>() {
  let resolvePromise: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  const mockFn = vi.fn().mockImplementation((value: T) => {
    resolvePromise(value);
    return value;
  });

  return Object.assign(mockFn, {
    waitForCall: () => promise,
  });
}

/**
 * Generates a unique test ID for use in data-testid attributes.
 *
 * @example
 * const testId = generateTestId("button");
 * // Returns something like "button-abc123"
 */
export function generateTestId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Helper to wait for an element to be removed from the DOM.
 *
 * @example
 * await waitForRemoval(() => document.querySelector(".loading"));
 */
export async function waitForRemoval(
  queryFn: () => Element | null,
  timeout = 1000
): Promise<void> {
  const startTime = Date.now();
  while (queryFn() !== null) {
    if (Date.now() - startTime > timeout) {
      throw new Error("Element was not removed within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Creates a deferred promise that can be resolved/rejected externally.
 * Useful for controlling async behavior in tests.
 *
 * @example
 * const deferred = createDeferred<string>();
 * const promise = someAsyncOperation(deferred.promise);
 * deferred.resolve("result");
 * await promise;
 */
export function createDeferred<T>() {
  let resolve: (value: T) => void;
  let reject: (error: Error) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    promise,
    resolve: resolve!,
    reject: reject!,
  };
}

/**
 * Waits for a specified amount of time.
 * Use sparingly - prefer waiting for specific conditions when possible.
 *
 * @example
 * await delay(100); // Wait 100ms
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates a spy on console methods that can be restored after the test.
 *
 * @example
 * const consoleSpy = spyOnConsole("error");
 * someCodeThatLogsError();
 * expect(consoleSpy).toHaveBeenCalled();
 * consoleSpy.mockRestore();
 */
export function spyOnConsole(method: "log" | "warn" | "error" | "info") {
  return vi.spyOn(console, method).mockImplementation(() => {});
}
