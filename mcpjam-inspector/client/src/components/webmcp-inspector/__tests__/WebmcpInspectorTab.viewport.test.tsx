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
import { render, screen, act, fireEvent } from "@testing-library/react";
import { WebmcpInspectorTab } from "../WebmcpInspectorTab";
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";
import type {
  WebMcpInputEvent,
  WebMcpSessionPublic,
} from "@/shared/webmcp-inspector-protocol";

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

  it("hides the stale picture when Live view is switched off", async () => {
    stubViewportActions({ screencastAccepted: true });
    useWebmcpInspectorStore.setState({ lastScreenshot: "old-capture" });
    render(<WebmcpInspectorTab />);
    await act(async () => {});
    expect(
      screen.getByAltText("Live view of the inspected page"),
    ).toBeInTheDocument();

    await act(async () => {
      screen.getByRole("button", { name: "Live view" }).click();
    });

    // Holding the screenshot would freeze the pane on an old picture still
    // labelled "live", and the "Live view is off" line would never appear
    // because a source was present.
    expect(screen.queryByAltText("Live view of the inspected page")).toBeNull();
    expect(screen.getByText(/Live view is off/)).toBeInTheDocument();
  });

  it("polls down the silent path, not the error-clearing one", async () => {
    const { captureScreenshot } = stubViewportActions({
      screencastAccepted: false,
    });
    render(<WebmcpInspectorTab />);
    await act(async () => {});
    // What that flag then protects — an error banner surviving a poll — is the
    // store's behaviour and is asserted there, against the real action rather
    // than this spy.
    expect(captureScreenshot).toHaveBeenCalledWith({ silent: true });
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

  it("lets a keyboard user leave the pane with Escape", async () => {
    const sendInput = vi.fn(async () => {});
    useWebmcpInspectorStore.setState({
      session: session({
        viewportTransport: { kind: "frame-stream", width: 1280, height: 800 },
      }),
      sendInput,
    });
    stubViewportActions({ screencastAccepted: true });
    render(<WebmcpInspectorTab />);
    await act(async () => {});

    const pane = screen.getByLabelText(
      "The inspected page — click to interact",
    );
    await act(async () => {
      pane.focus();
    });
    expect(document.activeElement).toBe(pane);

    await act(async () => {
      fireEvent.keyDown(pane, { key: "Escape" });
      // The key-up too: a browser sends both, and forwarding only the release
      // would hand the page a key it never saw pressed.
      fireEvent.keyUp(pane, { key: "Escape" });
    });

    // Tab is FORWARDED — tabbing between fields is most of what people do to a
    // form — so Tab cannot also be the way out. Without a key that leaves, a
    // keyboard-only user would be trapped in the live view.
    expect(document.activeElement).not.toBe(pane);
    // And Escape itself never reaches the page, in either transition, so it
    // cannot close a dialog there on the way out.
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("sends a paste once, as text, and never as its keystrokes", async () => {
    const sendInput = vi.fn<(events: WebMcpInputEvent[]) => Promise<void>>(
      async () => {},
    );
    useWebmcpInspectorStore.setState({
      session: session({
        viewportTransport: { kind: "frame-stream", width: 1280, height: 800 },
      }),
      sendInput,
    });
    stubViewportActions({ screencastAccepted: true });
    render(<WebmcpInspectorTab />);
    await act(async () => {});

    const pane = screen.getByLabelText(
      "The inspected page — click to interact",
    );
    // The real sequence a browser produces: ctrl down, v down, the paste the
    // default action then fires, v up, ctrl up.
    await act(async () => {
      fireEvent.keyDown(pane, { key: "Control", ctrlKey: true });
      fireEvent.keyDown(pane, { key: "v", ctrlKey: true });
      fireEvent.paste(pane, {
        clipboardData: { getData: () => "pasted text" },
      });
      fireEvent.keyUp(pane, { key: "v", ctrlKey: true });
      fireEvent.keyUp(pane, { key: "Control", ctrlKey: false });
    });

    const sent: Array<Record<string, unknown>> = sendInput.mock.calls.flatMap(
      (call) => call[0],
    );
    // The clipboard reaches the page exactly once, as text.
    expect(sent.filter((event) => event.kind === "text")).toEqual([
      { kind: "text", text: "pasted text" },
    ]);
    // And the `v` itself never goes: with ctrl still held on the far side, a
    // forwarded `v` would make the remote page run its OWN paste too — from
    // the browser profile's clipboard, not the one the person copied into —
    // and the pasted text would land twice, or wrongly.
    expect(sent.filter((event) => event.key === "v")).toEqual([]);
    // Control is still tracked, so a click right after the paste is not a
    // ctrl-click and a later release is not a release of a key never pressed.
    expect(sent.map((event) => event.kind)).toEqual([
      "key_down",
      "text",
      "key_up",
    ]);
  });

  it("withholds the paste key-up even when Ctrl came up first", async () => {
    const sendInput = vi.fn<(events: WebMcpInputEvent[]) => Promise<void>>(
      async () => {},
    );
    useWebmcpInspectorStore.setState({
      session: session({
        viewportTransport: { kind: "frame-stream", width: 1280, height: 800 },
      }),
      sendInput,
    });
    stubViewportActions({ screencastAccepted: true });
    render(<WebmcpInspectorTab />);
    await act(async () => {});

    const pane = screen.getByLabelText(
      "The inspected page — click to interact",
    );
    await act(async () => {
      fireEvent.keyDown(pane, { key: "Control", ctrlKey: true });
      fireEvent.keyDown(pane, { key: "v", ctrlKey: true });
      // Ctrl released BEFORE V — an ordinary thing to do, and it makes the `v`
      // key-up look like a plain keystroke to anything reading only this
      // event's modifiers.
      fireEvent.keyUp(pane, { key: "Control", ctrlKey: false });
      fireEvent.keyUp(pane, { key: "v", ctrlKey: false });
    });

    const sent: Array<Record<string, unknown>> = sendInput.mock.calls.flatMap(
      (call) => call[0],
    );
    // No `v` in either direction. A lone key-up would hand the page a release
    // for a key it never saw pressed.
    expect(sent.filter((event) => event.key === "v")).toEqual([]);
    expect(sent.map((event) => `${event.kind}:${event.key}`)).toEqual([
      "key_down:Control",
      "key_up:Control",
    ]);
  });

  it("does not swallow an ordinary key-up after a paste lost focus", async () => {
    const sendInput = vi.fn<(events: WebMcpInputEvent[]) => Promise<void>>(
      async () => {},
    );
    useWebmcpInspectorStore.setState({
      session: session({
        viewportTransport: { kind: "frame-stream", width: 1280, height: 800 },
      }),
      sendInput,
    });
    stubViewportActions({ screencastAccepted: true });
    render(<WebmcpInspectorTab />);
    await act(async () => {});

    const pane = screen.getByLabelText(
      "The inspected page — click to interact",
    );
    await act(async () => {
      pane.focus();
      fireEvent.keyDown(pane, { key: "Control", ctrlKey: true });
      fireEvent.keyDown(pane, { key: "v", ctrlKey: true });
      // Focus leaves before the `v` key-up arrives — alt-tab, or anything that
      // takes focus mid-shortcut. The key-up is then never delivered here.
      fireEvent.blur(pane);
    });
    sendInput.mockClear();

    // Back on the pane, an ORDINARY `v`: no modifier, so its key-down IS
    // forwarded and its key-up must be too.
    await act(async () => {
      pane.focus();
      fireEvent.keyDown(pane, { key: "v" });
      fireEvent.keyUp(pane, { key: "v" });
    });

    const sent: Array<Record<string, unknown>> = sendInput.mock.calls.flatMap(
      (call) => call[0],
    );
    // A withheld key surviving the blur would swallow this release and leave
    // `v` held in the page for the rest of the session — the exact thing
    // withholding the paste transitions exists to prevent.
    expect(sent.map((event) => `${event.kind}:${event.key}`)).toEqual([
      "key_down:v",
      "key_up:v",
    ]);
  });

  it("releases held input when the screen unmounts without a blur", async () => {
    const sendInput = vi.fn(async () => {});
    useWebmcpInspectorStore.setState({
      session: session({
        viewportTransport: { kind: "frame-stream", width: 1280, height: 800 },
      }),
      sendInput,
    });
    stubViewportActions({ screencastAccepted: true });
    const view = render(<WebmcpInspectorTab />);
    await act(async () => {});

    const pane = screen.getByLabelText(
      "The inspected page — click to interact",
    );
    await act(async () => {
      fireEvent.keyDown(pane, { key: "Shift" });
    });
    sendInput.mockClear();

    view.unmount();
    await act(async () => {});

    // Tabbing away from this screen fires no blur on the pane, so without an
    // explicit release the page would believe Shift was held for the rest of
    // the session and every later click would be a shift-click.
    expect(sendInput).toHaveBeenCalledWith([{ kind: "key_up", key: "Shift" }]);
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
