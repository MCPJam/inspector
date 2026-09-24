import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useElectronOAuth } from "../useElectronOAuth";
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/app-navigation", () => ({ navigateApp: navigate }));
let callback: (url: string) => void;
beforeEach(() => {
  vi.clearAllMocks();
  window.isElectron = true;
  window.electronAPI = {
    oauth: {
      onCallback: (fn: typeof callback) => {
        callback = fn;
      },
      removeCallback: vi.fn(),
    },
  } as any;
});
describe("Electron MCP return", () => {
  it("navigates without reloading and preserves state and issuer", () => {
    const before = window.location.href;
    renderHook(useElectronOAuth);
    act(() =>
      callback(
        "mcpjam://oauth/callback?flow=mcp&code=test&state=electron_mcp%3Aone&iss=issuer",
      ),
    );
    expect(navigate).toHaveBeenCalledWith(
      "/oauth/callback?code=test&state=electron_mcp%3Aone&iss=issuer",
      { replace: true, unscoped: true },
    );
    expect(window.location.href).toBe(before);
  });
  it("handles cancellation and ignores debugger and untrusted protocol URLs", () => {
    const { unmount } = renderHook(useElectronOAuth);
    act(() =>
      callback(
        "mcpjam://oauth/callback?state=electron_mcp%3Aone&error=access_denied",
      ),
    );
    expect(navigate).toHaveBeenCalledTimes(1);
    act(() => callback("mcpjam://oauth/callback?flow=debug&code=test"));
    act(() => callback("https://oauth/callback?flow=mcp&code=test"));
    expect(navigate).toHaveBeenCalledTimes(1);
    unmount();
    expect(window.electronAPI.oauth.removeCallback).toHaveBeenCalled();
  });
});
