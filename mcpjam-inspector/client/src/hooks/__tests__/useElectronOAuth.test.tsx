import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useElectronOAuth } from "../useElectronOAuth";
import {
  readOAuthCallbackParams,
  resetOAuthCallbackInboxForTests,
} from "@/lib/oauth-callback-inbox";
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/app-navigation", () => ({ navigateApp: navigate }));
let callback: (url: string) => void;
beforeEach(() => {
  vi.clearAllMocks();
  resetOAuthCallbackInboxForTests();
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
    // Only the marker reaches the address bar; the answer waits in the inbox
    // for the callback readers (`lib/oauth-callback-inbox.ts`).
    expect(navigate).toHaveBeenCalledWith("/oauth/callback?oauth_pending=1", {
      replace: true,
      unscoped: true,
    });
    expect(JSON.stringify(navigate.mock.calls)).not.toContain("code=test");
    expect(window.location.href).toBe(before);
    window.history.replaceState({}, "", "/oauth/callback?oauth_pending=1");
    expect(readOAuthCallbackParams()?.toString()).toBe(
      "code=test&state=electron_mcp%3Aone&iss=issuer",
    );
    window.history.replaceState({}, "", before);
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
