/**
 * The pane's two jobs: ask for frames only while someone is looking, and show
 * SOMETHING whatever the server can do.
 *
 * The fallback is the part worth pinning down. A server too old to know
 * `set_screencast` answers 400, and the person running it should see their page
 * via the screenshot poll rather than an empty box and an error about a command
 * they never typed.
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

function session(
  overrides: Partial<WebMcpSessionPublic> = {},
): WebMcpSessionPublic {
  return {
    sessionId: "session-1",
    status: "ready",
    url: "https://shop.test/",
    createdAt: 1_000,
    expiresAt: 2_000,
    hardExpiresAt: 3_000,
    viewportTransport: { kind: "native-window" },
    protocolVersion: 1,
    ...overrides,
  };
}

/** Spies for the two store actions the pane drives. */
function stubViewportActions(options: { screencastAccepted: boolean }) {
  const setScreencast = vi.fn(async () => options.screencastAccepted);
  const captureScreenshot = vi.fn(async () => {});
  useWebmcpInspectorStore.setState({ setScreencast, captureScreenshot });
  return { setScreencast, captureScreenshot };
}

describe("WebmcpInspectorTab — viewport", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    useWebmcpInspectorStore.setState({
      session: session(),
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

  it("asks for the stream while the pane is up, and withdraws on unmount", async () => {
    const { setScreencast, captureScreenshot } = stubViewportActions({
      screencastAccepted: true,
    });

    const view = render(<WebmcpInspectorTab />);
    await act(async () => {});
    expect(setScreencast).toHaveBeenCalledWith(true);
    // The stream is the primary path: nothing polls while it is working.
    expect(captureScreenshot).not.toHaveBeenCalled();

    view.unmount();
    await act(async () => {});
    // A session left encoding frames for a pane nobody is looking at is
    // exactly what demand-driving exists to avoid.
    expect(setScreencast).toHaveBeenLastCalledWith(false);
  });

  it("falls back to the screenshot poll when the server refuses the command", async () => {
    vi.useFakeTimers();
    const { setScreencast, captureScreenshot } = stubViewportActions({
      screencastAccepted: false,
    });

    render(<WebmcpInspectorTab />);
    await act(async () => {});

    expect(setScreencast).toHaveBeenCalledWith(true);
    // One immediately, so the pane is not blank for a whole second…
    expect(captureScreenshot).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(2_100);
    });
    // …then on the interval.
    expect(captureScreenshot.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("polls rather than asking a hosted session for a screencast", async () => {
    useWebmcpInspectorStore.setState({
      session: session({
        viewportTransport: {
          kind: "remote-interactive-url",
          url: "https://desktop.test/stream",
        },
      }),
    });
    const { setScreencast, captureScreenshot } = stubViewportActions({
      screencastAccepted: true,
    });

    render(<WebmcpInspectorTab />);
    await act(async () => {});

    // The hosted browser paints in a datacenter and shows itself through the
    // Browser panel. There is no CDP screencast on this side to ask for.
    expect(setScreencast).not.toHaveBeenCalled();
    expect(captureScreenshot).toHaveBeenCalled();
  });

  it("stops asking once Live view is switched off", async () => {
    const { setScreencast } = stubViewportActions({ screencastAccepted: true });
    render(<WebmcpInspectorTab />);
    await act(async () => {});
    setScreencast.mockClear();

    await act(async () => {
      screen.getByRole("button", { name: "Live view" }).click();
    });
    expect(setScreencast).toHaveBeenCalledWith(false);
    expect(setScreencast).not.toHaveBeenCalledWith(true);
  });

  it("renders the live frame, and falls back to the last screenshot", async () => {
    stubViewportActions({ screencastAccepted: true });
    useWebmcpInspectorStore.setState({ lastScreenshot: "manual" });

    const view = render(<WebmcpInspectorTab />);
    await act(async () => {});
    // No frame yet: the middle rung of the chain is what keeps the pane from
    // being a hole for the first few hundred milliseconds.
    expect(
      screen.getByAltText("Live view of the inspected page"),
    ).toHaveAttribute("src", "data:image/jpeg;base64,manual");

    await act(async () => {
      useWebmcpInspectorStore.setState({
        liveFrame: {
          data: "paint",
          deviceWidth: 1280,
          deviceHeight: 800,
          ts: 1,
        },
      });
    });
    expect(
      screen.getByAltText("Live view of the inspected page"),
    ).toHaveAttribute("src", "data:image/jpeg;base64,paint");
    view.unmount();
  });

  it("says it is waiting when there is nothing to show yet", async () => {
    stubViewportActions({ screencastAccepted: true });
    render(<WebmcpInspectorTab />);
    await act(async () => {});
    expect(screen.getByText(/Waiting for the first frame/)).toBeInTheDocument();
  });

  it("shows no pane at all once the session has closed", async () => {
    useWebmcpInspectorStore.setState({ session: undefined });
    const { setScreencast } = stubViewportActions({ screencastAccepted: true });
    render(<WebmcpInspectorTab />);
    await act(async () => {});
    expect(screen.queryByAltText("Live view of the inspected page")).toBeNull();
    expect(setScreencast).not.toHaveBeenCalled();
  });

  it("drives the page only for a frame-stream session", async () => {
    const sendInput = vi.fn(async () => {});
    useWebmcpInspectorStore.setState({
      session: session({
        viewportTransport: { kind: "frame-stream", width: 1280, height: 800 },
      }),
      sendInput,
      liveFrame: { data: "paint", deviceWidth: 1280, deviceHeight: 800, ts: 1 },
    });
    stubViewportActions({ screencastAccepted: true });

    render(<WebmcpInspectorTab />);
    await act(async () => {});

    const pane = screen.getByLabelText(
      "The inspected page — click to interact",
    );
    expect(pane).toHaveAttribute("tabindex", "0");
  });

  it("leaves a native-window session view-only", async () => {
    useWebmcpInspectorStore.setState({
      liveFrame: { data: "paint", deviceWidth: 1280, deviceHeight: 800, ts: 1 },
    });
    stubViewportActions({ screencastAccepted: true });

    render(<WebmcpInspectorTab />);
    await act(async () => {});

    // Forwarding here would drive the page a SECOND time: the person already
    // has the real window in front of them, and every click would land twice.
    expect(
      screen.queryByLabelText("The inspected page — click to interact"),
    ).toBeNull();
    expect(
      screen.getByText(/Interact with it in the browser window/),
    ).toBeInTheDocument();
  });

  it("offers no Live view switch for a session that IS the pane", async () => {
    useWebmcpInspectorStore.setState({
      session: session({
        viewportTransport: { kind: "frame-stream", width: 1280, height: 800 },
      }),
    });
    stubViewportActions({ screencastAccepted: true });

    render(<WebmcpInspectorTab />);
    await act(async () => {});

    // Turning it off would leave a browser nobody can see or touch, with no way
    // back except closing the session.
    expect(screen.queryByRole("button", { name: "Live view" })).toBeNull();
  });

  it("asks for an in-app session by default, and a window on request", async () => {
    const startSession = vi.fn(async () => {});
    useWebmcpInspectorStore.setState({ session: undefined, startSession });
    stubViewportActions({ screencastAccepted: true });

    render(<WebmcpInspectorTab />);
    await act(async () => {});

    await act(async () => {
      screen.getByRole("button", { name: "Open browser" }).click();
    });
    expect(startSession).toHaveBeenLastCalledWith(expect.any(String), {
      display: "in-app",
    });

    await act(async () => {
      screen.getByRole("button", { name: "In app" }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Open browser" }).click();
    });
    // A Chrome window is one click away, and is what someone wants when they
    // need their own devtools open on the page.
    expect(startSession).toHaveBeenLastCalledWith(
      expect.any(String),
      undefined,
    );
  });
});
