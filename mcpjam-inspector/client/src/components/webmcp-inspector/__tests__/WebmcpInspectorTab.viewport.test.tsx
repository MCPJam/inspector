vi.mock("@/hooks/useLocalBrowserConsent", () => ({
  useLocalBrowserConsent: () => ({
    granted: true,
    token: "test-consent",
    grant: vi.fn(async () => true),
  }),
}));
import { StrictMode } from "react";
import { waitFor } from "@testing-library/react";
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
import type { ReactNode } from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WebmcpInspectorTab } from "../WebmcpInspectorTab";
import {
  useWebmcpInspectorStore,
  webmcpFrameChannel,
} from "@/stores/webmcp-inspector-store";
import {
  frameStatsReport,
  resetFrameStatsFlagForTests,
} from "@/lib/webmcp-inspector/frame-stats";
import type {
  WebMcpInputEvent,
  WebMcpSessionPublic,
} from "@/shared/webmcp-inspector-protocol";

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children?: ReactNode }) => (
    <div data-testid="resizable-panel-group">{children}</div>
  ),
  ResizablePanel: ({ children }: { children?: ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

const loadedImages: Array<{ src: string; onload?: () => void }> = [];
class TestImage {
  private source = "";
  get src() {
    return this.source;
  }
  set src(value: string) {
    this.source = value;
    if (value) queueMicrotask(() => this.onload?.());
  }
  onload?: (() => void) | null;
  constructor() {
    loadedImages.push(this);
  }
}
/** The pane draws decoded frames straight onto its canvas. */
let drawImage = vi.fn();
const panelRenders = vi.hoisted(() => ({ activity: 0, tools: 0 }));
vi.mock("../ActivityTimeline", async (original) => {
  const actual = await original<typeof import("../ActivityTimeline")>();
  return {
    ...actual,
    ActivityTimeline: (
      props: Parameters<typeof actual.ActivityTimeline>[0],
    ) => {
      panelRenders.activity += 1;
      return <actual.ActivityTimeline {...props} />;
    },
  };
});
vi.mock("../WebmcpToolsSidebar", async (original) => {
  const actual = await original<typeof import("../WebmcpToolsSidebar")>();
  return {
    ...actual,
    WebmcpToolsSidebar: (
      props: Parameters<typeof actual.WebmcpToolsSidebar>[0],
    ) => {
      panelRenders.tools += 1;
      return <actual.WebmcpToolsSidebar {...props} />;
    },
  };
});

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

/**
 * Put a decoded picture on the channel, as the frame socket does.
 *
 * A bitmap rather than bytes: the socket decodes through the shared reader, so
 * by the time the pane sees a frame there is nothing left to load — which is
 * why these assert on the canvas rather than on an `<img>`.
 */
function publishFrame(seq = 1, scale = 1) {
  webmcpFrameChannel.publish({
    bitmap: { close: () => {} } as unknown as ImageBitmap,
    deviceWidth: 1280 * scale,
    deviceHeight: 800 * scale,
    scale,
    ts: 1,
    seq,
  });
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
    loadedImages.length = 0;
    vi.stubGlobal("Image", TestImage);
    drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as never);
    webmcpFrameChannel.publish(null);
    useWebmcpInspectorStore.setState({
      session: session(),
      tools: [],
      activity: [],
      pending: [],
      starting: false,
      error: undefined,
      frameTransport: { rung: "none", attempts: 0, latched: false },
      lastScreenshot: undefined,
      chatEnabled: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([0, 500])(
    "isolates 30 viewport frames from a workspace with %i activity rows",
    async (rows) => {
      stubViewportActions({ screencastAccepted: true });
      useWebmcpInspectorStore.setState({
        session: session({
          viewportTransport: { kind: "frame-stream", width: 1280, height: 800 },
        }),
        activity: Array.from({ length: rows }, (_, i) => ({
          id: `row-${i}`,
          ts: i,
          kind: "session_started" as const,
          url: "https://shop.test/",
        })),
      });
      render(<WebmcpInspectorTab />);
      await act(async () => {});
      const before = { ...panelRenders };
      drawImage.mockClear();
      for (let seq = 1; seq <= 30; seq++) {
        await act(async () => {
          publishFrame(seq);
        });
      }
      expect(panelRenders.activity - before.activity).toBe(0);
      expect(panelRenders.tools - before.tools).toBe(0);
      // …and every one of them reached the canvas. The frames are not merely
      // isolated from the workspace; they are still being drawn.
      expect(drawImage).toHaveBeenCalledTimes(30);
    },
  );

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

  it("neither streams nor polls for a hosted session — it has a live view", async () => {
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

    // The hosted browser paints in a datacenter, so there is no CDP screencast
    // on this side to ask for. It used to fall back to a screenshot every
    // second, which was proof of life rather than a viewport; the pane embeds
    // the browser's own live stream now, so neither is wanted.
    expect(setScreencast).not.toHaveBeenCalled();
    expect(captureScreenshot).not.toHaveBeenCalled();
  });

  it("hides the stale picture when Live view is switched off", async () => {
    stubViewportActions({ screencastAccepted: true });
    useWebmcpInspectorStore.setState({ lastScreenshot: "old-capture" });
    render(<WebmcpInspectorTab />);
    await act(async () => {});
    expect(
      screen.getByRole("img", { name: "Live view of the inspected page" }),
    ).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Live view" }));

    // Holding the screenshot would freeze the pane on an old picture still
    // labelled "live", and the "Live view is off" line would never appear
    // because a source was present.
    expect(
      screen.queryByRole("img", { name: "Live view of the inspected page" }),
    ).toBeNull();
    expect(screen.getByText(/Live view is off/)).toBeInTheDocument();
  });

  it("stops asking once Live view is switched off", async () => {
    const { setScreencast } = stubViewportActions({ screencastAccepted: true });
    render(<WebmcpInspectorTab />);
    await act(async () => {});
    setScreencast.mockClear();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Live view" }));
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
    await waitFor(() =>
      expect(loadedImages.at(-1)?.src).toBe("data:image/jpeg;base64,manual"),
    );

    // Then the first real frame arrives, decoded, and the canvas takes over.
    drawImage.mockClear();
    await act(async () => {
      publishFrame();
    });
    expect(drawImage).toHaveBeenCalled();
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
    expect(
      screen.queryByRole("img", { name: "Live view of the inspected page" }),
    ).toBeNull();
    expect(setScreencast).not.toHaveBeenCalled();
  });

  it("drives the page only for a frame-stream session", async () => {
    const sendInput = vi.fn(async () => {});
    useWebmcpInspectorStore.setState({
      session: session({
        viewportTransport: { kind: "frame-stream", width: 1280, height: 800 },
      }),
      sendInput,
    });
    stubViewportActions({ screencastAccepted: true });
    publishFrame();

    render(<WebmcpInspectorTab />);
    await act(async () => {});

    const pane = screen.getByLabelText(
      "The inspected page — click to interact",
    );
    expect(pane).toHaveAttribute("tabindex", "0");
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
      publishFrame(1, 2);
    });

    const pane = screen.getByLabelText(
      "The inspected page — click to interact",
    );
    const image = screen.getByRole("img", {
      name: "Live view of the inspected page",
    });
    image.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1280, height: 800 }) as DOMRect;

    await act(async () => {
      mouseDown(image, { clientX: 640, clientY: 400, button: 0 });
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
   * What the pane says when the socket has given up.
   *
   * The retries are silent by design — that is what keeps a pane showing the
   * last picture it was given through a reconnect — which leaves a session
   * with no live view and nobody any the wiser once they are spent. This is
   * the one place that shows up, and it points at the remedy that still works.
   */
  describe("live view notice", () => {
    async function renderWith(frameTransport: {
      rung: "ws" | "none";
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
      expect(screen.queryByText(/Live view is unavailable/)).toBeNull();
    });

    it("says nothing while the ladder is still retrying", async () => {
      // Degraded, but about to be fine, and the pane is still holding the last
      // picture it was given. A notice that flickered on every reconnect would
      // train people to ignore it.
      await renderWith({ rung: "none", attempts: 2, latched: false });
      expect(screen.queryByText(/Live view is unavailable/)).toBeNull();
    });

    it("points at the Screenshot button once the socket has given up", async () => {
      await renderWith({ rung: "none", attempts: 4, latched: true });
      expect(
        screen.getByText(/Live view is unavailable for this session/),
      ).toBeInTheDocument();
    });

    it("says the same when nothing ever paints, socket or no socket", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        // The ladder is fine and the socket is carrying: this is the session
        // whose daemon never selects a tab, so `set_screencast` keeps coming
        // back refused. Waiting it out is right — but not forever, and
        // "Waiting for the first frame…" offers nothing to click.
        await renderWith({ rung: "ws", attempts: 0, latched: false });
        expect(screen.queryByText(/Live view is unavailable/)).toBeNull();

        await act(async () => {
          vi.advanceTimersByTime(6_000);
        });
        expect(
          screen.getByText(/Live view is unavailable for this session/),
        ).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stays quiet when a frame arrives before the wait is up", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        await renderWith({ rung: "ws", attempts: 0, latched: false });
        await act(async () => {
          webmcpFrameChannel.publish({
            bitmap: undefined,
            data: "painted",
            deviceWidth: 1280,
            deviceHeight: 800,
            scale: 1,
            ts: 1,
            seq: 1,
          });
          vi.advanceTimersByTime(6_000);
        });
        expect(screen.queryByText(/Live view is unavailable/)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("does not stop the replacement session's stream on the way out", async () => {
    // Both sessions stream fine. What is under test is the CLEANUP a session
    // change triggers, which runs while the store already holds the new
    // session — so an unconditional stop there is aimed at the replacement.
    const captureScreenshot = vi.fn(async () => {});
    const setScreencast = vi.fn(async () => true);
    const streamKind = {
      kind: "frame-stream" as const,
      width: 1280,
      height: 800,
    };
    useWebmcpInspectorStore.setState({
      setScreencast,
      captureScreenshot,
      session: session({
        sessionId: "session-a",
        viewportTransport: streamKind,
      }),
    });
    render(<WebmcpInspectorTab />);
    await act(async () => {});
    expect(setScreencast.mock.calls).toEqual([[true]]);

    useWebmcpInspectorStore.setState({
      session: session({
        sessionId: "session-b",
        viewportTransport: streamKind,
      }),
    });
    await act(async () => {});

    // No `false` in between. It would be undone by the enable that follows it
    // — but only because the store's command queue preserves that order, and a
    // pane going dark is not a thing to leave resting on a coincidence.
    expect(setScreencast.mock.calls).toEqual([[true], [true]]);
  });

  it("leaves a native-window session view-only", async () => {
    publishFrame();
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

  it("lets a keyboard user leave the pane with Shift+Escape", async () => {
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
      fireEvent.keyDown(pane, { key: "Escape", shiftKey: true });
      // The key-up too: a browser sends both, and forwarding only the release
      // would hand the page a key it never saw pressed.
      fireEvent.keyUp(pane, { key: "Escape", shiftKey: true });
    });

    // Tab is FORWARDED — tabbing between fields is most of what people do to a
    // form — so Tab cannot also be the way out. Without a key that leaves, a
    // keyboard-only user would be trapped in the live view.
    expect(document.activeElement).not.toBe(pane);
    // And Escape itself never reaches the page, in either transition, so it
    // cannot close a dialog there on the way out.
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("keeps wheel input alive after Strict Mode replays effect setup", async () => {
    const sendInput = vi.fn(async () => {});
    useWebmcpInspectorStore.setState({
      session: session({
        viewportTransport: { kind: "frame-stream", width: 1280, height: 800 },
      }),
      sendInput,
    });
    stubViewportActions({ screencastAccepted: true });
    publishFrame();
    const view = render(
      <StrictMode>
        <WebmcpInspectorTab />
      </StrictMode>,
    );
    await act(async () => {});
    await act(async () => {
      publishFrame(2);
    });
    const canvas = screen.getByRole("img", {
      name: "Live view of the inspected page",
    });
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1280, height: 800 }) as DOMRect;
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 200,
      clientY: 200,
      deltaY: 120,
    });
    act(() => canvas.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(sendInput).toHaveBeenCalledWith([
        expect.objectContaining({ kind: "wheel", deltaY: 120 }),
      ]),
    );
    view.unmount();
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
      "text:undefined",
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
    expect(sendInput).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "key_up", key: "Shift" }),
    ]);
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

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "In app" }));
    await act(async () => {
      screen.getByRole("button", { name: "Open browser" }).click();
    });
    // A Chrome window is one click away, and is what someone wants when they
    // need their own devtools open on the page.
    expect(startSession).toHaveBeenLastCalledWith(expect.any(String), {
      projectId: undefined,
    });
  });
});

// jsdom does not generate the compatibility mouse event after a pointer event.
function mouseDown(element: Element, init?: MouseEventInit) {
  fireEvent.pointerDown(element, init);
  fireEvent.mouseDown(element, init);
}
function mouseUp(element: Element, init?: MouseEventInit) {
  fireEvent.pointerUp(element, init);
  fireEvent.mouseUp(element, init);
}
