/**
 * Mount/It gating for the catalog registration hook: the registry must be
 * empty on surfaces where the end user is not the inspector operator — the
 * standalone chatbox chat route passes `enabled: false` — and must follow
 * `enabled` toggles across rerenders. Also guards the removal of the
 * browser-native WebMCP mirror: registering the catalog must never touch
 * `document.modelContext` / `navigator.modelContext`.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRegisterUiTools } from "../use-register-ui-tools";
import { useUiToolsRegistry } from "../ui-tools-registry";

describe("useRegisterUiTools", () => {
  beforeEach(() => {
    useUiToolsRegistry.setState({
      tools: new Map(),
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

  describe("browser-native WebMCP exposure (removed)", () => {
    const documentRegisterTool = vi.fn();
    const navigatorRegisterTool = vi.fn();

    beforeEach(() => {
      // Fake native WebMCP surfaces on BOTH homes (`document.modelContext`
      // preferred, `navigator.modelContext` the deprecated fallback). If any
      // mirroring code is reintroduced, one of these spies records a call.
      Object.defineProperty(document, "modelContext", {
        configurable: true,
        value: { registerTool: documentRegisterTool },
      });
      Object.defineProperty(navigator, "modelContext", {
        configurable: true,
        value: { registerTool: navigatorRegisterTool },
      });
    });

    afterEach(() => {
      delete (document as { modelContext?: unknown }).modelContext;
      delete (navigator as { modelContext?: unknown }).modelContext;
    });

    it("registering the catalog makes zero native registerTool calls", () => {
      const { unmount } = renderHook(() => useRegisterUiTools());
      expect(useUiToolsRegistry.getState().tools.size).toBeGreaterThan(0);
      expect(documentRegisterTool).not.toHaveBeenCalled();
      expect(navigatorRegisterTool).not.toHaveBeenCalled();
      unmount();
      expect(documentRegisterTool).not.toHaveBeenCalled();
      expect(navigatorRegisterTool).not.toHaveBeenCalled();
    });
  });
});
