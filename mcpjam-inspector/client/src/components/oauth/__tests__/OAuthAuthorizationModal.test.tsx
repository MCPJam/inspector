import { act, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthAuthorizationModal } from "../OAuthAuthorizationModal";

const hint = vi.hoisted(() => ({
  showOAuthCallbackHint: vi.fn(),
  dismissOAuthCallbackHint: vi.fn(),
}));
vi.mock("@/lib/oauth/callback-hint", () => hint);

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
      />
    );

    await waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith(
        "https://auth.example.com/authorize"
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
    const openSpy = vi
      .spyOn(window, "open")
      .mockImplementation(() => popupWindow);

    openExternal.mockRejectedValue(new Error("system browser unavailable"));

    const { unmount } = render(
      <OAuthAuthorizationModal
        open={true}
        onOpenChange={onOpenChange}
        authorizationUrl="https://auth.example.com/authorize"
      />
    );

    try {
      await waitFor(() => {
        expect(openExternal).toHaveBeenCalledWith(
          "https://auth.example.com/authorize"
        );
      });
      await waitFor(() => {
        expect(openSpy).toHaveBeenCalled();
      });

      expect(openSpy).toHaveBeenCalledWith(
        "https://auth.example.com/authorize",
        expect.stringMatching(/^oauth_authorization_/),
        expect.any(String)
      );
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
    } finally {
      unmount();
      consoleErrorSpy.mockRestore();
    }
  });

  it("resets modal state when the fallback popup is blocked", async () => {
    const onOpenChange = vi.fn();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.spyOn(window, "open").mockImplementation(() => null);

    openExternal.mockRejectedValue(new Error("system browser unavailable"));

    render(
      <OAuthAuthorizationModal
        open={true}
        onOpenChange={onOpenChange}
        authorizationUrl="https://auth.example.com/authorize"
      />
    );

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    consoleErrorSpy.mockRestore();
  });
});

describe("OAuthAuthorizationModal callback hint", () => {
  let popup: { closed: boolean };

  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <OAuthAuthorizationModal
        open={open}
        onOpenChange={setOpen}
        authorizationUrl="https://auth.example.com/authorize"
      />
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    window.isElectron = false;
    popup = { closed: false };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows the hint when the popup closes with no code back", () => {
    render(<Harness />);

    popup.closed = true;
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(hint.showOAuthCallbackHint).toHaveBeenCalledWith("try again");
  });

  it("stays quiet when the code came back before the popup closed", () => {
    render(<Harness />);

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: { type: "OAUTH_CALLBACK", code: "code" },
        }),
      );
    });
    popup.closed = true;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(hint.showOAuthCallbackHint).not.toHaveBeenCalled();
  });
});
