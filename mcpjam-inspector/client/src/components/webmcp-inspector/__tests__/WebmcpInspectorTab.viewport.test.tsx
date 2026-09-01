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
import {
  frameStatsReport,
  resetFrameStatsFlagForTests,
} from "@/lib/webmcp-inspector/frame-stats";
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

/** A `liveFrame` in the store's normalized shape. */
function liveFrame(src: string, seq = 1, scale = 1) {
  return {
    src,
    rung: "ws" as const,
    deviceWidth: 1280 * scale,
    deviceHeight: 800 * scale,
    // The page's own coordinate space, which is what the pane lays out and
    // scales clicks against however many device pixels the capture used.
    cssWidth: 1280,
    cssHeight: 800,
    ts: 1,
    seq,
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
      frameTransport: { rung: "none", attempts: 0, latched: false },
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
        liveFrame: liveFrame("data:image/jpeg;base64,paint"),
      });
    });
    expect(
      screen.getByAltText("Live view of the inspected page"),
    ).toHaveAttribute("src", "data:image/jpeg;base64,paint");
    view.unmount();
  });

  it("renders the frame's src verbatim, whatever transport minted it", async () => {
    stubViewportActions({ screencastAccepted: true });
    const view = render(<WebmcpInspectorTab />);
    await act(async () => {});

    // A blob URL from the binary socket. The pane must not re-wrap it as a
    // data URI, and must not know which transport produced it — that
    // indifference is what lets the transport change without touching the
    // letterbox and coordinate arithmetic below it.
    await act(async () => {
      useWebmcpInspectorStore.setState({
        liveFrame: liveFrame("blob:http://localhost/abc-123"),
      });
    });
    expect(
      screen.getByAltText("Live view of the inspected page"),
    ).toHaveAttribute("src", "blob:http://localhost/abc-123");

    // …and a data URI from SSE, through the same prop.
    await act(async () => {
      useWebmcpInspectorStore.setState({
        liveFrame: liveFrame("data:image/jpeg;base64,sse", 2),
      });
    });
    expect(
      screen.getByAltText("Live view of the inspected page"),
    ).toHaveAttribute("src", "data:image/jpeg;base64,sse");
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
      liveFrame: liveFrame("data:image/jpeg;base64,paint"),
    });
    stubViewportActions({ screencastAccepted: true });

    render(<WebmcpInspectorTab />);
    await act(async () => {});

    const pane = screen.getByLabelText(
      "The inspected page — click to interact",
    );
    expect(pane).toHaveAttribute("tabindex", "0");
  });

  it("hands the store's promise to the forwarder, as its in-flight clock", async () => {
    let settle!: () => void;
    const sendInput = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
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
    // Seeded AFTER mount: the tab's `reconnect()` effect runs a full teardown
    // for a session with no live stream, which clears the frame.
    await act(async () => {
      useWebmcpInspectorStore.setState({
        liveFrame: liveFrame("data:image/jpeg;base64,paint"),
      });
    });

    const pane = screen.getByLabelText(
      "The inspected page — click to interact",
    );
    // The geometry closure reads the <img>'s rect, which jsdom reports as
    // zero-sized; give it a real one so the wheel maps into the frame.
    const image = screen.getByAltText("Live view of the inspected page");
    image.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1280, height: 800 }) as DOMRect;

    await act(async () => {
      pane.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -100, bubbles: true }),
      );
    });
    expect(sendInput).toHaveBeenCalledTimes(1);

    await act(async () => {
      pane.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -50, bubbles: true }),
      );
      pane.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -50, bubbles: true }),
      );
    });
    // Held, because the first request has not settled. If the tab wrapped
    // `sendInput` in `void`, the forwarder would see no in-flight work and put
    // one request on the wire per wheel event.
    expect(sendInput).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle();
    });
    expect(sendInput).toHaveBeenCalledTimes(2);
    expect(sendInput.mock.calls[1]![0]).toEqual([
      expect.objectContaining({ kind: "wheel", deltaY: -100 }),
    ]);
  });

  /**
   * The three paint-recording tests differ only in their TAIL — what happens
   * between the decode and the animation frame that would have shown it. The
   * flag key, the stubbed `requestAnimationFrame` and the mount are stated
   * once here so a change to any of them lands in one place.
   */
  describe("frame-stats paint recording", () => {
    /** Callbacks the pane queued for the next frame, to run by hand. */
    let queued: Array<() => void>;

    beforeEach(() => {
      localStorage.setItem("webmcp:frame-stats", "1");
      resetFrameStatsFlagForTests();
      queued = [];
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
        queued.push(() => cb(0));
        return queued.length;
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      localStorage.removeItem("webmcp:frame-stats");
      // Clears the cached flag AND the samples, so the next test starts empty.
      resetFrameStatsFlagForTests();
    });

    /** jsdom leaves `currentSrc` unset; the pane reads it to name the frame. */
    function setCurrentSrc(image: HTMLElement, value: string) {
      Object.defineProperty(image, "currentSrc", {
        value,
        configurable: true,
      });
    }

    /** Mount the pane with one frame decoded but not yet shown. */
    async function mountDecodedFrame(src = "data:image/jpeg;base64,paint") {
      stubViewportActions({ screencastAccepted: true });
      const view = render(<WebmcpInspectorTab />);
      await act(async () => {});
      await act(async () => {
        useWebmcpInspectorStore.setState({ liveFrame: liveFrame(src) });
      });
      const image = screen.getByAltText("Live view of the inspected page");
      setCurrentSrc(image, src);
      await act(async () => {
        fireEvent.load(image);
      });
      return { view, image };
    }

    const runQueuedFrames = () =>
      act(async () => {
        queued.forEach((run) => run());
      });

    it("records a paint on the next animation frame, not on decode", async () => {
      await mountDecodedFrame();

      // `load` means DECODED, not shown. Recording there reports a number
      // consistently smaller than the thing being measured.
      expect(frameStatsReport().captureToPaint.n).toBe(0);
      await runQueuedFrames();
      expect(frameStatsReport().captureToPaint.n).toBe(1);
    });

    it("does not record a frame superseded before it was shown", async () => {
      const { image } = await mountDecodedFrame();

      // A newer frame replaced it before the compositor ever showed this one,
      // so it never was a paint.
      setCurrentSrc(image, "data:image/jpeg;base64,newer");
      await runQueuedFrames();
      expect(frameStatsReport().captureToPaint.n).toBe(0);
    });

    it("does not record a paint for a pane that unmounted before the frame", async () => {
      const { view } = await mountDecodedFrame();

      // The screen goes away between the decode and the frame that would have
      // shown it. Nothing was painted, so nothing should be recorded.
      view.unmount();
      await runQueuedFrames();
      expect(frameStatsReport().captureToPaint.n).toBe(0);
    });
  });

  it("scales a click against the frame's CSS size, not its device pixels", async () => {
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
    await act(async () => {
      // A frame captured at two device pixels per CSS pixel: 2560x1600 of
      // picture describing a 1280x800 page.
      useWebmcpInspectorStore.setState({
        liveFrame: liveFrame("data:image/jpeg;base64,retina", 1, 2),
      });
    });

    const pane = screen.getByLabelText(
      "The inspected page — click to interact",
    );
    const image = screen.getByAltText("Live view of the inspected page");
    image.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1280, height: 800 }) as DOMRect;

    await act(async () => {
      fireEvent.pointerDown(pane, { clientX: 640, clientY: 400, button: 0 });
    });

    // The middle of the pane is the middle of the PAGE — 640,400 — and not the
    // middle of the picture's device pixels, which would be 1280,800: a
    // coordinate outside the page entirely, and one that would put every click
    // on a retina session at double where the person pointed.
    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ kind: "mouse_down", x: 640, y: 400 }),
    ]);
  });

  /**
   * The badge that says the pane is not on the path it should be.
   *
   * Everything about the fallback ladder is silent by design — that is what
   * keeps a pane painting through a dead socket — which leaves a session
   * quietly running on the slowest transport it has and nobody any the wiser.
   * The badge is the one place that shows up.
   */
  describe("transport badge", () => {
    async function renderWith(frameTransport: {
      rung: "ws" | "sse-frames" | "poll" | "none";
      attempts: number;
      latched: boolean;
    }) {
      useWebmcpInspectorStore.setState({
        session: session({
          viewportTransport: { kind: "frame-stream", width: 1280, height: 800 },
        }),
      });
      stubViewportActions({ screencastAccepted: true });
      render(<WebmcpInspectorTab />);
      await act(async () => {});
      // Seeded AFTER mount: the tab's `reconnect()` effect tears the stream
      // down for a session with no live socket, which resets the very field
      // this is about.
      await act(async () => {
        useWebmcpInspectorStore.setState({ frameTransport });
      });
    }

    it("says nothing while the socket is carrying frames", async () => {
      await renderWith({ rung: "ws", attempts: 0, latched: false });
      expect(screen.queryByText(/^Frames:/)).toBeNull();
    });

    it("says nothing while the ladder is still retrying", async () => {
      // Degraded, but about to be fine. A badge that flickered on every
      // reconnect would train people to ignore it.
      await renderWith({ rung: "sse-frames", attempts: 2, latched: false });
      expect(screen.queryByText(/^Frames:/)).toBeNull();
    });

    it("names the fallback once the ladder has given up", async () => {
      await renderWith({ rung: "sse-frames", attempts: 4, latched: true });
      const badge = screen.getByText("Frames: SSE");
      // The attempt count rides in the tooltip rather than the badge: the
      // number matters to whoever is diagnosing it, not to the person reading
      // the header.
      expect(badge).toHaveAttribute("title", expect.stringContaining("4"));
    });

    it("names the screenshot poll", async () => {
      await renderWith({ rung: "poll", attempts: 0, latched: false });
      expect(screen.getByText("Frames: polling")).toBeInTheDocument();
    });
  });

  it("tells the store when it falls back to polling screenshots", async () => {
    // The server refuses `set_screencast` — every server older than it does —
    // and the pane starts its own screenshot loop. Without this report the
    // store would describe a pane painting from screenshots as one with no
    // transport at all.
    useWebmcpInspectorStore.setState({
      session: session({
        viewportTransport: { kind: "frame-stream", width: 1280, height: 800 },
      }),
    });
    stubViewportActions({ screencastAccepted: false });
    const view = render(<WebmcpInspectorTab />);
    await act(async () => {});

    expect(useWebmcpInspectorStore.getState().frameTransport.rung).toBe("poll");

    view.unmount();
    await act(async () => {});
    // And stops saying so when the pane goes away, or the next session would
    // inherit a poll that is not running.
    expect(useWebmcpInspectorStore.getState().frameTransport.rung).not.toBe(
      "poll",
    );
  });

  it("leaves a native-window session view-only", async () => {
    useWebmcpInspectorStore.setState({
      liveFrame: liveFrame("data:image/jpeg;base64,paint"),
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
