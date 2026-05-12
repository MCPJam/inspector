import { StrictMode } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import OAuthDesktopReturnNotice, {
  desktopReturnRuntime,
  redirectBrowserCallbackToElectron,
  resetDesktopReturnAttemptsForTests,
} from "../OAuthDesktopReturnNotice";

describe("OAuthDesktopReturnNotice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetDesktopReturnAttemptsForTests();
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

  it("only launches the Electron callback once in StrictMode", () => {
    const redirectSpy = vi
      .spyOn(desktopReturnRuntime, "redirect")
      .mockImplementation(() => {});

    render(
      <StrictMode>
        <OAuthDesktopReturnNotice returnToElectronUrl="mcpjam://oauth/callback?code=456" />
      </StrictMode>,
    );

    expect(redirectSpy).toHaveBeenCalledTimes(1);
    expect(redirectSpy).toHaveBeenCalledWith(
      "mcpjam://oauth/callback?code=456",
    );
  });
});
