import { act, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthAuthorizationModal } from "../OAuthAuthorizationModal";
import {
  OAUTH_POPUP_MARKER_TTL_MS,
  readOAuthPopupMarker,
} from "@/lib/oauth/popup-handoff-marker";

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
    const openSpy = vi
      .spyOn(window, "open")
      .mockImplementation(() => popupWindow);

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
      />,
    );

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    consoleErrorSpy.mockRestore();
  });
});

describe("OAuthAuthorizationModal callback hint", () => {
  let popup: { closed: boolean };
  const onCallback = vi.fn();

  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <OAuthAuthorizationModal
        open={open}
        onOpenChange={setOpen}
        authorizationUrl="https://auth.example.com/authorize?state=flow-state"
        onCallback={onCallback}
      />
    );
  }

  function postCallback(data: Record<string, unknown>) {
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { origin: window.location.origin, data }),
      );
    });
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
    localStorage.clear();
  });

  // A COOP provider page makes Chrome report the popup closed straight away
  // while the user is still signing in.
  it("keeps waiting when the popup reads as closed, then hints at the deadline", () => {
    render(<Harness />);

    popup.closed = true;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(hint.showOAuthCallbackHint).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(OAUTH_POPUP_MARKER_TTL_MS);
    });
    expect(hint.showOAuthCallbackHint).toHaveBeenCalledWith("try again");
  });

  it("hands the first matching code to the tab and stays quiet", () => {
    render(<Harness />);

    popup.closed = true;
    const message = {
      type: "OAUTH_CALLBACK",
      code: "code",
      state: "flow-state",
    };
    postCallback(message);
    postCallback(message);
    act(() => {
      vi.advanceTimersByTime(OAUTH_POPUP_MARKER_TTL_MS);
    });

    expect(onCallback).toHaveBeenCalledTimes(1);
    expect(onCallback).toHaveBeenCalledWith(
      expect.objectContaining({ code: "code", state: "flow-state" }),
    );
    expect(hint.showOAuthCallbackHint).not.toHaveBeenCalled();
  });

  it("ignores a code whose state belongs to another sign-in", () => {
    render(<Harness />);

    postCallback({ type: "OAUTH_CALLBACK", code: "code", state: "other" });

    expect(onCallback).not.toHaveBeenCalled();
  });

  it("hands a provider error to the tab", () => {
    render(<Harness />);

    postCallback({
      type: "OAUTH_CALLBACK",
      state: "flow-state",
      error: "access_denied",
      errorDescription: "The user denied access",
    });

    expect(onCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "access_denied",
        errorDescription: "The user denied access",
        code: undefined,
      }),
    );
  });

  // Mirrors OAuthFlowTab: Authorize sets `open`, or asks for a reopen while
  // the modal is already open.
  function AuthorizeHarness({
    url = "https://auth.example.com/authorize?state=flow-state",
  }) {
    const [open, setOpen] = useState(false);
    const [reopenRequest, setReopenRequest] = useState(0);
    return (
      <>
        <button
          onClick={() =>
            open ? setReopenRequest((request) => request + 1) : setOpen(true)
          }
        >
          Authorize
        </button>
        <span data-testid="open">{String(open)}</span>
        <OAuthAuthorizationModal
          open={open}
          onOpenChange={setOpen}
          authorizationUrl={url}
          onCallback={onCallback}
          reopenRequest={reopenRequest}
        />
      </>
    );
  }

  function clickAuthorize(getByText: (text: string) => HTMLElement) {
    act(() => {
      getByText("Authorize").click();
    });
  }

  it("reopens the popup when Authorize is clicked again while sign-in is pending", () => {
    const { getByText } = render(<AuthorizeHarness />);
    clickAuthorize(getByText);
    expect(window.open).toHaveBeenCalledTimes(1);

    // The user closed the popup, or COOP makes it read as closed.
    popup.closed = true;
    clickAuthorize(getByText);

    expect(window.open).toHaveBeenCalledTimes(2);
    expect(vi.mocked(window.open).mock.calls[1][0]).toBe(
      "https://auth.example.com/authorize?state=flow-state",
    );
    expect(readOAuthPopupMarker("flow-state")).not.toBeNull();
    postCallback({ type: "OAUTH_CALLBACK", code: "code", state: "flow-state" });
    expect(onCallback).toHaveBeenCalledTimes(1);
  });

  it("closes at the deadline so Authorize starts a new sign-in", () => {
    const { getByText, getByTestId } = render(<AuthorizeHarness />);
    clickAuthorize(getByText);
    popup.closed = true;

    act(() => {
      vi.advanceTimersByTime(OAUTH_POPUP_MARKER_TTL_MS);
    });
    expect(getByTestId("open").textContent).toBe("false");
    expect(hint.showOAuthCallbackHint).toHaveBeenCalledWith("try again");

    clickAuthorize(getByText);
    expect(getByTestId("open").textContent).toBe("true");
    expect(window.open).toHaveBeenCalledTimes(2);
    postCallback({ type: "OAUTH_CALLBACK", code: "code", state: "flow-state" });
    expect(onCallback).toHaveBeenCalledTimes(1);
  });

  it("ignores an answer with no state when the URL had none", () => {
    render(
      <OAuthAuthorizationModal
        open
        onOpenChange={() => {}}
        authorizationUrl="https://auth.example.com/authorize"
        onCallback={onCallback}
      />,
    );

    postCallback({ type: "OAUTH_CALLBACK", code: "code" });

    expect(onCallback).not.toHaveBeenCalled();
  });

  it("writes the state marker before the popup opens and deletes it once used", () => {
    vi.mocked(window.open).mockImplementation(() => {
      expect(readOAuthPopupMarker("flow-state")).toMatchObject({
        flow: "debugger",
      });
      return popup as unknown as Window;
    });
    render(<Harness />);

    postCallback({ type: "OAUTH_CALLBACK", code: "code", state: "flow-state" });

    expect(window.open).toHaveBeenCalledTimes(1);
    expect(readOAuthPopupMarker("flow-state")).toBeNull();
  });
});
