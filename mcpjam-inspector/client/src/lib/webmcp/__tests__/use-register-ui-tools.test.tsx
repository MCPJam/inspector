/**
 * Mount gating for the catalog registration hook: the registry must be empty
 * on surfaces where the end user is not the inspector operator — the
 * standalone scenario chat route passes `enabled: false` — and must follow
 * `enabled` toggles across rerenders.
 *
 * This hook fills the REGISTRY and nothing else. Which of those tools reach a
 * browser-native WebMCP agent is the publisher's decision, tested in
 * `use-publish-native-ui-tools.test.tsx` and `native-tool-publisher.test.ts`;
 * the test below only holds the two apart, so registering the catalog can
 * never become a native side effect of its own.
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

  describe("registration is not publication", () => {
    const documentRegisterTool = vi.fn();
    const navigatorRegisterTool = vi.fn();

    beforeEach(() => {
      // Fake WebMCP surfaces on BOTH homes (`document.modelContext`
      // preferred, `navigator.modelContext` the deprecated alias).
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

    it("filling the registry publishes nothing by itself", () => {
      // Publication is `usePublishNativeUiTools`, mounted separately at the
      // App root, so a surface that registers tools without it (or with it
      // disabled) stays internal-only.
      const { unmount } = renderHook(() => useRegisterUiTools());
      expect(useUiToolsRegistry.getState().tools.size).toBeGreaterThan(0);
      expect(documentRegisterTool).not.toHaveBeenCalled();
      expect(navigatorRegisterTool).not.toHaveBeenCalled();
      unmount();
    });
  });
});
