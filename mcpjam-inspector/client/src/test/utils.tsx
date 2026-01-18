/**
 * Test utilities for React component testing.
 * Provides custom render functions with common providers.
 */
import React, { ReactElement, ReactNode } from "react";
import { render, RenderOptions, RenderResult } from "@testing-library/react";
import { vi } from "vitest";

// Re-export everything from testing-library
export * from "@testing-library/react";
export { default as userEvent } from "@testing-library/user-event";

/**
 * Options for customizing the test render
 */
interface CustomRenderOptions extends Omit<RenderOptions, "wrapper"> {
  /** Additional providers to wrap the component */
  providers?: Array<React.ComponentType<{ children: ReactNode }>>;
}

/**
 * Creates a wrapper component with all specified providers
 */
function createWrapper(
  providers: Array<React.ComponentType<{ children: ReactNode }>>
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return providers.reduceRight(
      (acc, Provider) => <Provider>{acc}</Provider>,
      children
    );
  };
}

/**
 * Custom render function that wraps components with common providers.
 * Use this instead of the default render from @testing-library/react.
 *
 * @example
 * // Basic usage
 * const { getByText } = renderWithProviders(<MyComponent />);
 *
 * @example
 * // With custom providers
 * const { getByText } = renderWithProviders(<MyComponent />, {
 *   providers: [ThemeProvider, AuthProvider],
 * });
 */
export function renderWithProviders(
  ui: ReactElement,
  options: CustomRenderOptions = {}
): RenderResult {
  const { providers = [], ...renderOptions } = options;

  const Wrapper = providers.length > 0 ? createWrapper(providers) : undefined;

  return render(ui, { wrapper: Wrapper, ...renderOptions });
}

/**
 * Helper to wait for async state updates.
 * Useful when testing components that fetch data.
 *
 * @example
 * await waitForLoadingToFinish();
 * expect(screen.getByText("Data loaded")).toBeInTheDocument();
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
 * fireEvent.click(submitButton);
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
