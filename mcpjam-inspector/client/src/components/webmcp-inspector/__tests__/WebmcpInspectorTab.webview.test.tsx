/**
 * The `electron-webview` transport's arms on this screen.
 *
 * The kind exists because the surface is the CLIENT's: a real Chromium view
 * mounted in the app, already painting on the viewer's screen. Everything this
 * screen does for a server-painted session is therefore wrong for it — asking
 * for a screencast starts an encoder nobody reads, polling screenshots costs a
 * round trip per second for a picture already on screen, and offering "Live
 * view: off" offers to turn off something that cannot be turned off.
 *
 * Each assertion below fails if its arm is removed, which is the only way to
 * know the arm is load-bearing rather than decorative.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { WebmcpInspectorTab } from "../WebmcpInspectorTab";
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";
import type { WebMcpSessionPublic } from "@/shared/webmcp-inspector-protocol";

class FakeEventSource {
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  close() {}
}
vi.stubGlobal("EventSource", FakeEventSource as never);

function webviewSession(): WebMcpSessionPublic {
  return {
    sessionId: "session-webview",
    status: "ready",
    url: "https://shop.test/",
    createdAt: 1_000,
    expiresAt: 2_000,
    hardExpiresAt: 3_000,
    viewportTransport: { kind: "electron-webview" },
    protocolVersion: 1,
  };
}

function stubViewportActions() {
  const setScreencast = vi.fn(async () => true);
  const captureScreenshot = vi.fn(async () => {});
  useWebmcpInspectorStore.setState({ setScreencast, captureScreenshot });
  return { setScreencast, captureScreenshot };
}

describe("WebmcpInspectorTab — electron-webview transport", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    useWebmcpInspectorStore.setState({
      session: webviewSession(),
      tools: [],
      activity: [],
      pending: [],
      starting: false,
      error: undefined,
      liveFrame: undefined,
      lastScreenshot: undefined,
      chatEnabled: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never asks for a screencast and never polls screenshots", async () => {
    vi.useFakeTimers();
    const { setScreencast, captureScreenshot } = stubViewportActions();

    const view = render(<WebmcpInspectorTab />);
    await act(async () => {});
    // Not "accepted false, so fall back to the poll" — asked at all.
    expect(setScreencast).not.toHaveBeenCalled();
    expect(captureScreenshot).not.toHaveBeenCalled();

    // And no timer was armed behind it: a poll here would push a round-trip
    // screenshot every second for a page already painting on this screen.
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(captureScreenshot).not.toHaveBeenCalled();

    // Nothing to withdraw on the way out, either.
    view.unmount();
    await act(async () => {});
    expect(setScreencast).not.toHaveBeenCalled();
  });

  it("hides the Live view toggle, which has nothing to toggle", async () => {
    stubViewportActions();
    render(<WebmcpInspectorTab />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Live view" })).toBeNull();
  });

  it("tells the viewer the page is right here rather than in a window", async () => {
    stubViewportActions();
    render(<WebmcpInspectorTab />);
    await act(async () => {});
    expect(
      screen.getByText(/running right here, in the app/),
    ).toBeInTheDocument();
    // The exact trap the exhaustive branch exists to close: a new kind
    // inheriting the window arm's copy.
    expect(screen.queryByText(/A browser window is open on this machine/))
      .toBeNull();
  });
});
