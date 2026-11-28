import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useJsonRpcPanelVisibility } from "../use-json-rpc-panel";

describe("useJsonRpcPanelVisibility", () => {
  afterEach(() => localStorage.clear());

  it("opens by default without a stored preference", () => {
    const { result } = renderHook(() => useJsonRpcPanelVisibility());
    expect(result.current.isVisible).toBe(true);
  });

  it("starts minimized when defaultVisible is false", () => {
    const { result } = renderHook(() =>
      useJsonRpcPanelVisibility({ storageKey: "custom", defaultVisible: false })
    );
    expect(result.current.isVisible).toBe(false);
  });

  it("keeps a custom key's preference apart from the shared one", () => {
    localStorage.setItem("mcpjam-inspector-jsonrpc-panel-visible", "true");
    const { result } = renderHook(() =>
      useJsonRpcPanelVisibility({ storageKey: "custom", defaultVisible: false })
    );
    expect(result.current.isVisible).toBe(false);

    act(() => result.current.show());
    expect(localStorage.getItem("custom")).toBe("true");

    const { result: reopened } = renderHook(() =>
      useJsonRpcPanelVisibility({ storageKey: "custom", defaultVisible: false })
    );
    expect(reopened.current.isVisible).toBe(true);
  });
});
