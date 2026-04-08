import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import OAuthDesktopReturnNotice, {
  redirectBrowserCallbackToElectron,
} from "../OAuthDesktopReturnNotice";

describe("OAuthDesktopReturnNotice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.isElectron = false;
  });

  it("tries to return browser callbacks to Electron automatically", () => {
    const replace = vi.fn();

    redirectBrowserCallbackToElectron("mcpjam://oauth/callback?code=123", {
      replace,
    });

    expect(replace).toHaveBeenCalledWith("mcpjam://oauth/callback?code=123");
  });

  it("shows the desktop return message", () => {
    window.isElectron = true;

    render(
      <OAuthDesktopReturnNotice returnToElectronUrl="mcpjam://oauth/callback?code=123" />,
    );

    expect(screen.getByText("Continue in MCPJam Desktop")).toBeInTheDocument();
  });

  it("does not redirect again inside Electron", () => {
    const replace = vi.fn();
    window.isElectron = true;

    redirectBrowserCallbackToElectron("mcpjam://oauth/callback?code=123", {
      replace,
    });

    expect(replace).not.toHaveBeenCalled();
  });
});
