import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthAuthorizationModal } from "../OAuthAuthorizationModal";

describe("OAuthAuthorizationModal", () => {
  const openExternal = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    window.isElectron = true;
    window.electronAPI = {
      app: {
        openExternal,
      },
    } as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes immediately after Electron opens the system browser", async () => {
    const onOpenChange = vi.fn();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    openExternal.mockResolvedValue(undefined);

    render(
      <OAuthAuthorizationModal
        open={true}
        onOpenChange={onOpenChange}
        authorizationUrl="https://auth.example.com/authorize"
      />,
    );

    await waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith(
        "https://auth.example.com/authorize",
      );
    });
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    expect(openSpy).not.toHaveBeenCalled();
  });

  it("falls back to the popup flow when Electron browser launch fails", async () => {
    const onOpenChange = vi.fn();
    const popupWindow = { closed: false } as Window;
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const openSpy = vi.spyOn(window, "open").mockImplementation(
      () => popupWindow,
    );

    openExternal.mockRejectedValue(new Error("system browser unavailable"));

    const { unmount } = render(
      <OAuthAuthorizationModal
        open={true}
        onOpenChange={onOpenChange}
        authorizationUrl="https://auth.example.com/authorize"
      />,
    );

    try {
      await waitFor(() => {
        expect(openExternal).toHaveBeenCalledWith(
          "https://auth.example.com/authorize",
        );
      });
      await waitFor(() => {
        expect(openSpy).toHaveBeenCalled();
      });

      expect(openSpy).toHaveBeenCalledWith(
        "https://auth.example.com/authorize",
        expect.stringMatching(/^oauth_authorization_/),
        expect.any(String),
      );
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
    } finally {
      unmount();
      consoleErrorSpy.mockRestore();
    }
  });
});
