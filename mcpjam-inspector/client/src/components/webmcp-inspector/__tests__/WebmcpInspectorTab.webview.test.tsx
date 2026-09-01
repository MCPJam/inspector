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
import { render, screen, act, fireEvent } from "@testing-library/react";
import { WebmcpInspectorTab } from "../WebmcpInspectorTab";
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";
import type { WebMcpSessionPublic } from "@/shared/webmcp-inspector-protocol";

/**
 * The `<webview>` the pane renders, as jsdom leaves it: an unknown element with
 * no Electron methods on it at all.
 *
 * That absence is the fidelity that matters. `getWebContentsId` does not exist
 * until the guest attaches — in a real Electron it exists and THROWS, which the
 * pane handles identically — so a test that pre-installed it would prove
 * nothing about mount-then-start, the ordering this whole path hangs on. It is
 * added here only at the moment `bringUpWebview` announces the guest.
 *
 * (`customElements.define` is not an option: a custom element name must contain
 * a dash, and `webview` does not.)
 */
type FakeWebview = HTMLElement & {
  getWebContentsId?: () => number;
  getURL?: () => string;
};

function mountedWebview(): FakeWebview | null {
  return document.querySelector("webview") as FakeWebview | null;
}

/** Attach the guest and announce it, as Chromium would. */
function bringUpWebview(id = 77): void {
  const element = mountedWebview();
  if (!element) throw new Error("no <webview> is mounted");
  element.getWebContentsId = () => id;
  element.getURL = () => "https://shop.test/cart";
  element.dispatchEvent(new Event("dom-ready"));
}

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

function inAppSession(): WebMcpSessionPublic {
  return {
    ...webviewSession(),
    viewportTransport: { kind: "frame-stream", width: 1280, height: 800 },
  };
}

describe("WebmcpInspectorTab — mounting the surface", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.isElectron = true;
    window.isElectronPackaged = false;
    useWebmcpInspectorStore.setState({
      session: undefined,
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
    delete window.isElectron;
    delete window.isElectronPackaged;
  });

  it("mounts the surface FIRST, then starts with the id it reports", async () => {
    const startSession = vi.fn(async () => {
      useWebmcpInspectorStore.setState({ session: webviewSession() });
    });
    useWebmcpInspectorStore.setState({ startSession });
    render(<WebmcpInspectorTab />);
    await act(async () => {});
    // Nothing is mounted before the person asks.
    expect(mountedWebview()).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
    });
    expect(mountedWebview()).not.toBeNull();
    // The server ATTACHES rather than launches, so it cannot be asked to start
    // before there is something to attach to.
    expect(startSession).not.toHaveBeenCalled();

    await act(async () => {
      bringUpWebview();
      await Promise.resolve();
    });
    expect(startSession).toHaveBeenCalledWith("http://localhost:3000", {
      display: "in-app",
      webContentsId: 77,
    });
  });

  it("gives up with a sentence when the guest never attaches", async () => {
    vi.useFakeTimers();
    try {
      const startSession = vi.fn(async () => {});
      useWebmcpInspectorStore.setState({ startSession });
      render(<WebmcpInspectorTab />);
      await act(async () => {});
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
      });
      expect(mountedWebview()).not.toBeNull();

      await act(async () => {
        // The pane's own 5s bound. Without it the screen would sit behind an
        // "Opening page…" overlay forever, with no way back.
        vi.advanceTimersByTime(6_000);
        await Promise.resolve();
      });
      expect(startSession).not.toHaveBeenCalled();
      expect(screen.getByText(/embedded browser did not start/)).toBeInTheDocument();
      // And the dead surface is taken down rather than left on screen.
      expect(mountedWebview()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the surface down when the session closes", async () => {
    const startSession = vi.fn(async () => {
      useWebmcpInspectorStore.setState({ session: webviewSession() });
    });
    useWebmcpInspectorStore.setState({ startSession });
    render(<WebmcpInspectorTab />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
    });
    await act(async () => {
      bringUpWebview();
      await Promise.resolve();
    });
    expect(mountedWebview()).not.toBeNull();

    await act(async () => {
      // A crash, an idle sweep, or our own close — all arrive as this.
      useWebmcpInspectorStore.setState({
        session: { ...webviewSession(), status: "closed" },
      });
    });
    // The surface has nothing left to be attached to.
    expect(mountedWebview()).toBeNull();
  });

  it("degrades to the streamed pane when the server ignores the surface", async () => {
    // An older server strips `webContentsId` and answers `frame-stream`. The
    // client must render what it was HANDED, not what it asked for.
    const startSession = vi.fn(async () => {
      useWebmcpInspectorStore.setState({ session: inAppSession() });
    });
    useWebmcpInspectorStore.setState({
      startSession,
      setScreencast: vi.fn(async () => true),
      captureScreenshot: vi.fn(async () => {}),
    });
    render(<WebmcpInspectorTab />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
    });
    await act(async () => {
      bringUpWebview();
      await Promise.resolve();
    });

    expect(screen.getByText(/running in the pane below/)).toBeInTheDocument();
  });

  it("hides the destination toggle in the packaged app", async () => {
    window.isElectronPackaged = true;
    render(<WebmcpInspectorTab />);
    await act(async () => {});
    // "Chrome window" cannot work there — forge ships no node_modules and
    // `playwright` is externalized — so the button would only ever error.
    expect(screen.queryByRole("button", { name: "In app" })).toBeNull();
  });

  it("keeps the destination toggle in a dev run", async () => {
    render(<WebmcpInspectorTab />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "In app" })).toBeInTheDocument();
  });
});

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
