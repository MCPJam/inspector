import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildElectronDebugCallbackUrl } from "../OAuthDebugCallback";

describe("OAuthDebugCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.isElectron = false;
    window.name = "";
    window.history.replaceState(
      {},
      "",
      "/oauth/callback/debug?code=test-code&state=test-state",
    );
  });

  it("builds the Electron deep-link callback URL for browser returns", () => {
    expect(buildElectronDebugCallbackUrl()).toBe(
      "mcpjam://oauth/callback?flow=debug&code=test-code&state=test-state",
    );
  });
});
