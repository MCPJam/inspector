/**
 * Mount/It gating for the catalog registration hook: the registry (and via
 * it the native mirror) must be empty on surfaces where the end user is not
 * the inspector operator — the standalone chatbox chat route passes
 * `enabled: false` — and must follow `enabled` toggles across rerenders.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/webmcp/native-mirror", () => ({
  mirrorUiToolToNative: vi.fn(() => null),
}));

import { useRegisterUiTools } from "../use-register-ui-tools";
import { useUiToolsRegistry } from "../ui-tools-registry";

describe("useRegisterUiTools", () => {
  beforeEach(() => {
    useUiToolsRegistry.setState({
      tools: new Map(),
      nativeDisposers: new Map(),
      shippedNames: new Set(),
    });
  });

  it("registers the catalog by default and unregisters on unmount", () => {
    const { unmount } = renderHook(() => useRegisterUiTools());
    expect(useUiToolsRegistry.getState().resolve("ui_navigate")).not.toBeNull();
    expect(useUiToolsRegistry.getState().tools.size).toBeGreaterThan(0);
    unmount();
    expect(useUiToolsRegistry.getState().tools.size).toBe(0);
  });

  it("registers nothing while disabled and follows enabled toggles", () => {
    const { rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) => useRegisterUiTools({ enabled }),
      { initialProps: { enabled: false } }
    );
    expect(useUiToolsRegistry.getState().tools.size).toBe(0);

    rerender({ enabled: true });
    expect(useUiToolsRegistry.getState().resolve("ui_navigate")).not.toBeNull();

    rerender({ enabled: false });
    expect(useUiToolsRegistry.getState().tools.size).toBe(0);
    unmount();
  });
});
