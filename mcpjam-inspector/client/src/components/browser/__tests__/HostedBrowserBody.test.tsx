/**
 * The hosted pane.
 *
 * The pointer arithmetic and the take-control bar are `BrowserPaneSurface`'s
 * and are tested there. What is here is everything the HOSTED engine does
 * differently: a browser that already exists rather than one to install, a
 * lease whose ownership only the server can confirm, a socket whose token
 * expires mid-view, and a metered box that must not be held awake for a
 * picture nobody is looking at.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({
  /** What `/session` answers, or an error to throw. */
  session: null as unknown,
  sessionError: null as { status: number } | null,
  lease: { took: true, lease: { state: "held" }, yours: true } as unknown,
  inputs: [] as unknown[],
  leaseCalls: [] as string[],
  mints: 0,
  invalidations: 0,
  streamArgs: [] as unknown[],
  sockets: [] as Array<{
    readyState: number;
    sent: string[];
    send(data: string): void;
    close(): void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number }) => void;
    onopen?: () => void;
  }>,
}));

vi.mock("@/lib/hosted-browser/client", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/hosted-browser/client")
  >("@/lib/hosted-browser/client");
  return {
    ...actual,
    createBrowserTokenCache: () => ({
      get: async () => {
        api.mints += 1;
        return `tok-${api.mints}`;
      },
      invalidate: () => {
        api.invalidations += 1;
      },
    }),
    fetchHostedBrowserSession: async () => {
      if (api.sessionError) {
        throw new actual.HostedBrowserError("nope", api.sessionError.status);
      }
      return api.session;
    },
    actOnHostedBrowserLease: async (
      _tokens: unknown,
      { action }: { action: string },
    ) => {
      api.leaseCalls.push(action);
      return api.lease;
    },
    sendHostedBrowserInput: async (_tokens: unknown, args: unknown) => {
      api.inputs.push(args);
      return { ok: true as const };
    },
    openHostedBrowserFrameStream: (streamArgs: unknown) => {
      api.streamArgs.push(streamArgs);
      const socket = {
        readyState: 1,
        sent: [] as string[],
        send(data: string) {
          this.sent.push(data);
        },
        close: () => {},
      };
      api.sockets.push(socket);
      return { socket: socket as never, close: () => {} };
    },
  };
});

// The desktop view is a Convex-backed component of its own, tested where it
// lives. What matters here is that picking VNC hands the pane over to it.
vi.mock("@/components/computer/BrowserPanel", () => ({
  BrowserPanel: () => <div data-testid="vnc-panel" />,
}));

import { HostedBrowserBody } from "../HostedBrowserBody";
import {
  encodeFrameStreamRecord,
  FRAME_STREAM_KIND,
} from "@/shared/browserd-frame-stream";

const RUNNING = {
  bootId: "boot-1",
  contextMode: "persistent" as const,
  lease: { state: "free" as const },
  yours: false,
};

beforeEach(() => {
  api.session = RUNNING;
  api.sessionError = null;
  api.lease = { took: true, lease: { state: "held" }, yours: true };
  api.inputs = [];
  api.leaseCalls = [];
  api.mints = 0;
  api.invalidations = 0;
  api.sockets = [];
  api.streamArgs = [];
});

// Restored HERE rather than at the end of each test body: an assertion that
// fails mid-test never reaches its own cleanup, and fake timers or a stubbed
// visibility leaking into the next test turn one failure into a cascade that
// hides which one was real.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const mintToken = async () => ({ token: "t", expiresAt: Date.now() + 60_000 });

function renderBody(over: Record<string, unknown> = {}) {
  return render(
    <HostedBrowserBody
      projectId="proj-1"
      mintToken={mintToken}
      {...(over as never)}
    />,
  );
}

/** The socket most recently handed to the pane. */
const socket = () => api.sockets[api.sockets.length - 1]!;

/** Push a frame down the pane's socket so the picture renders. */
async function deliverFrame() {
  await waitFor(() => expect(api.sockets.length).toBeGreaterThan(0));
  act(() => {
    socket().onmessage?.({
      data: JSON.stringify({
        type: "frame",
        frame: {
          data: "Zm9v",
          deviceWidth: 1024,
          deviceHeight: 768,
          scale: 1,
          ts: 1,
          seq: 1,
        },
      }),
    });
  });
  return screen.findByTestId("rail-browser-frame");
}

describe("the hosted pane — finding a browser", () => {
  it("offers to open one when the computer has none", async () => {
    api.sessionError = { status: 409 };
    renderBody();
    expect(await screen.findByTestId("hosted-browser-idle")).toBeTruthy();
    // And no socket: there is nothing to watch.
    expect(api.sockets).toHaveLength(0);
  });

  it("says so when the computer itself cannot be reached", async () => {
    // Distinct from "no browser yet": one is an offer, the other is a fault,
    // and a button labelled "Open the browser" over an unreachable machine is
    // a promise nothing can keep.
    api.sessionError = { status: 503 };
    renderBody();
    expect(
      await screen.findByTestId("hosted-browser-unavailable"),
    ).toBeTruthy();
  });

  it("watches a browser that is already running", async () => {
    renderBody();
    await deliverFrame();
    expect(screen.getByText("The agent is driving")).toBeTruthy();
  });

  it("stops watching when the browser goes away", async () => {
    // 4404 means the row is gone. Retrying at a machine with nothing to show
    // would spin; offering to open one is the honest next step.
    renderBody();
    await deliverFrame();
    api.sessionError = { status: 409 };
    act(() => socket().onclose?.({ code: 4404 }));
    expect(await screen.findByTestId("hosted-browser-idle")).toBeTruthy();
  });
});

describe("the hosted pane — who has control", () => {
  it("BELIEVES THE SERVER about whose lease it is", async () => {
    // The holder is a user id the client never sees. A pane that tracked "I
    // acquired it" in its own state would forget across a reload and then tell
    // somebody who still holds a parked lease that a stranger has it — with no
    // way to hand it back, since only the holder may.
    api.session = {
      ...RUNNING,
      lease: { state: "parked", holderKind: "human" },
      yours: true,
    };
    renderBody();
    expect(await screen.findByText("You have control")).toBeTruthy();
    expect(screen.getByText("Hand back")).toBeTruthy();
  });

  it("does not offer to take a browser somebody else holds", async () => {
    api.session = {
      ...RUNNING,
      lease: { state: "held", holderKind: "human" },
      yours: false,
    };
    renderBody();
    expect(await screen.findByText("Someone else has control")).toBeTruthy();
    expect(screen.queryByText("Take control")).toBeNull();
  });

  it("takes control and reopens the stream the take just revoked", async () => {
    // Acquiring the lease revokes every watcher the daemon had — including
    // this pane's own stream. Without the reopen the person who just took
    // control watches a frozen picture.
    renderBody();
    await deliverFrame();
    const before = api.sockets.length;
    await userEvent.click(await screen.findByText("Take control"));
    expect(api.leaseCalls).toEqual(["acquire"]);
    await waitFor(() => expect(api.sockets.length).toBeGreaterThan(before));
  });

  it("hands it back", async () => {
    api.session = { ...RUNNING, lease: { state: "held" }, yours: true };
    api.lease = { took: true, lease: { state: "free" }, yours: false };
    renderBody();
    await userEvent.click(await screen.findByText("Hand back"));
    expect(api.leaseCalls).toEqual(["resume"]);
    await screen.findByText("The agent is driving");
  });
});

describe("the hosted pane — the socket", () => {
  it("waits and comes back when somebody else takes the browser", async () => {
    // 4409 is TEMPORARY. Surfacing it as an error about a browser that is fine
    // would be wrong, and giving up would leave the pane dark after they hand
    // it back.
    vi.useFakeTimers();
    renderBody();
    await vi.waitFor(() => expect(api.sockets.length).toBe(1));
    act(() => socket().onclose?.({ code: 4409 }));
    expect(screen.getByText(/Somebody else has taken control/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(api.sockets.length).toBeGreaterThan(1);
    vi.useRealTimers();
  });

  it("WAITS OUT the backoff after a refusal instead of reconnecting at once", async () => {
    // The socket effect keys off the session object, and its cleanup cancels
    // the pending backoff. So a re-read that builds a fresh object for an
    // unchanged row reconnects immediately AND throws the delay away — and the
    // re-read after a 4409 is exactly the one that finds the lease still held.
    // Refused, re-read, reconnect, with no delay, for as long as somebody else
    // is typing: a hot loop against the daemon.
    vi.useFakeTimers();
    renderBody();
    await vi.waitFor(() => expect(api.sockets.length).toBe(1));

    act(() => socket().onclose?.({ code: 4409 }));
    // Let the lease re-read this triggers settle, WITHOUT reaching the backoff.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(api.sockets.length).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(api.sockets.length).toBe(2);
    vi.useRealTimers();
  });

  it("mints a fresh token when the old one expires mid-view", async () => {
    // A token lasts about a minute, so a 4401 is the NORMAL way a long watch
    // ends. Reconnecting is what keeps the pane from going dark once a minute.
    vi.useFakeTimers();
    renderBody();
    await vi.waitFor(() => expect(api.sockets.length).toBe(1));
    act(() => socket().onclose?.({ code: 4401 }));
    expect(api.invalidations).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(api.sockets.length).toBe(2);
    vi.useRealTimers();
  });

  it("gives up on a token that keeps being refused", async () => {
    // Bounded, so a token rejected for some reason OTHER than expiry cannot
    // mint against the same answer forever.
    vi.useFakeTimers();
    renderBody();
    await vi.waitFor(() => expect(api.sockets.length).toBe(1));
    for (let i = 0; i < 8; i += 1) {
      // A REFUSED socket opens first. The server accepts the upgrade and only
      // then closes, because after an upgrade there is no status left to send
      // — so `open` genuinely fires before `close(4401)` in a browser, and a
      // cap reset there could never bind. Without this line the double was
      // kinder than the network and the loop below stayed bounded on its own.
      act(() => socket().onopen?.());
      act(() => socket().onclose?.({ code: 4401 }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
    }
    expect(api.sockets.length).toBeLessThanOrEqual(6);
    expect(screen.getByText(/no longer authorized/)).toBeTruthy();
    vi.useRealTimers();
  });

  it("forgives past refusals once a frame actually arrives", async () => {
    // The counter is CONSECUTIVE. A watch that runs for hours crosses several
    // token expiries, and each one is a refusal followed by a working
    // reconnect — so evidence the stream works has to clear the count, or a
    // long, healthy session eventually locks itself out.
    //
    // THREE, a frame, THREE, because the cap is five: without the reset that
    // is six in a row and the pane gives up, so the assertion below can
    // actually fail. Four refusals each followed by a frame — which is what
    // this test used to do — never reaches five either way, and proved
    // nothing.
    vi.useFakeTimers();
    const refuse = async () => {
      act(() => socket().onclose?.({ code: 4401 }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
    };
    const frame = () =>
      act(() =>
        socket().onmessage?.({
          data: JSON.stringify({
            type: "frame",
            frame: {
              data: "AAAA",
              deviceWidth: 1024,
              deviceHeight: 768,
              scale: 1,
              ts: 1,
              seq: 1,
            },
          }),
        }),
      );

    renderBody();
    await vi.waitFor(() => expect(api.sockets.length).toBe(1));

    for (let i = 0; i < 3; i += 1) await refuse();
    frame();
    for (let i = 0; i < 3; i += 1) await refuse();

    expect(screen.queryByText(/no longer authorized/)).toBeNull();
  });

  it("does not wipe the take-control message with a background re-read", async () => {
    // A 4409 close re-reads the session, and that read's success path clears
    // `error`. Sharing one field, the message set a tick earlier vanished
    // before anyone could read it: a dark pane, no explanation, and a fresh
    // flicker of it every three seconds.
    renderBody();
    await waitFor(() => expect(api.sockets.length).toBeGreaterThan(0));
    act(() => socket().onclose?.({ code: 4409 }));

    await waitFor(() =>
      expect(screen.getByText(/Somebody else has taken control/)).toBeTruthy(),
    );
    // Still there after the re-read this close kicked off has settled.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/Somebody else has taken control/)).toBeTruthy();
  });
});

describe("the hosted pane — a lease that changes underneath it", () => {
  it("asks again when the picture comes back after somebody else had it", async () => {
    // A 4409 says they took it; NOTHING says they handed it back. Without
    // this, the pane reconnects and shows frames again while still reporting
    // "Someone else has control" with no way to take it — until a reload.
    vi.useFakeTimers();
    try {
      api.session = {
        ...RUNNING,
        lease: { state: "held", holderKind: "human" },
        yours: false,
      };
      renderBody();
      await vi.waitFor(() => expect(api.sockets.length).toBe(1));
      act(() => socket().onclose?.({ code: 4409 }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });

      // They hand it back, and the reconnected socket starts delivering.
      api.session = { ...RUNNING, lease: { state: "free" }, yours: false };
      act(() => {
        socket().onmessage?.({
          data: JSON.stringify({
            type: "frame",
            frame: {
              data: "Zm9v",
              deviceWidth: 1024,
              deviceHeight: 768,
              scale: 1,
              ts: 2,
              seq: 2,
            },
          }),
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(screen.getByText("The agent is driving")).toBeTruthy();
      expect(screen.getByText("Take control")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops claiming a hold the server stopped renewing", async () => {
    // A heartbeat can be refused — the hold parked and somebody else took it,
    // or the browser relaunched. Ignoring the answer left the pane offering
    // input and a Hand back against a lease the server no longer recognises,
    // so every keystroke went nowhere with nothing to explain it.
    vi.useFakeTimers();
    try {
      api.session = { ...RUNNING, lease: { state: "held" }, yours: true };
      renderBody();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(screen.getByText("You have control")).toBeTruthy();

      api.lease = {
        took: false,
        lease: { state: "held", holderKind: "human" },
        yours: false,
      };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      expect(api.leaseCalls).toContain("heartbeat");
      expect(screen.getByText("Someone else has control")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a control notice the browser it described has outlived", async () => {
    // "Somebody else has taken control" rendered over an offer to START a
    // browser is a sentence about a session that no longer exists — and it
    // reads as the reason the button is there.
    vi.useFakeTimers();
    try {
      renderBody();
      await vi.waitFor(() => expect(api.sockets.length).toBe(1));
      act(() => socket().onclose?.({ code: 4409 }));
      expect(screen.getByText(/Somebody else has taken control/)).toBeTruthy();

      api.sessionError = { status: 409 };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      act(() => socket().onclose?.({ code: 4404 }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(screen.getByTestId("hosted-browser-idle")).toBeTruthy();
      expect(screen.queryByText(/Somebody else has taken control/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("HANDS THE BROWSER BACK when the pane goes away", async () => {
    // `pagehide` covers the tab closing, not this component unmounting — which
    // the rail does on every engine switch. A hold that stops being
    // heartbeaten PARKS rather than frees, on purpose, so the agent stayed
    // blocked on a browser nobody was watching, and only the holder may hand
    // one back.
    api.session = { ...RUNNING, lease: { state: "held" }, yours: true };
    const view = renderBody();
    expect(await screen.findByText("You have control")).toBeTruthy();
    api.leaseCalls = [];
    view.unmount();
    await waitFor(() => expect(api.leaseCalls).toEqual(["resume"]));
  });
});

describe("the hosted pane — what keeps the box awake", () => {
  it("says somebody is looking, but only while somebody is", async () => {
    // The ping is the ONLY evidence the server has. A pane behind the Logs tab
    // stays connected — dropping the socket would stop the screencast — so
    // without this it would hold a metered cloud box awake for a picture
    // nobody has on screen, and the person pays for it.
    vi.useFakeTimers();
    const view = renderBody({ active: true });
    await vi.waitFor(() => expect(api.sockets.length).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const whileWatching = socket().sent.length;
    expect(whileWatching).toBeGreaterThan(0);

    view.rerender(
      <HostedBrowserBody
        projectId="proj-1"
        mintToken={mintToken}
        active={false}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(socket().sent.length).toBe(whileWatching);
    vi.useRealTimers();
  });

  it("does not ping from a background browser tab either", async () => {
    vi.useFakeTimers();
    const hidden = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    renderBody({ active: true });
    await vi.waitFor(() => expect(api.sockets.length).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(socket().sent).toHaveLength(0);
    hidden.mockRestore();
    vi.useRealTimers();
  });
});

describe("the hosted pane — driving it", () => {
  it("forwards a keystroke only while it holds the browser", async () => {
    api.session = { ...RUNNING, lease: { state: "held" }, yours: true };
    renderBody();
    const image = await deliverFrame();
    (image.parentElement as HTMLElement).focus();
    await userEvent.keyboard("k");
    await waitFor(() => expect(api.inputs).toHaveLength(1));
    expect(api.inputs[0]).toMatchObject({
      events: [{ type: "text", text: "k" }],
    });
  });

  it("sends nothing while the agent is driving", async () => {
    renderBody();
    const image = await deliverFrame();
    (image.parentElement as HTMLElement).focus();
    await userEvent.keyboard("k");
    expect(api.inputs).toHaveLength(0);
  });

  it("puts a keystroke on the socket once the relay says it can", async () => {
    // The socket is ordered and already open; a POST spends a whole round trip
    // buying an ordering it already has.
    api.session = { ...RUNNING, lease: { state: "held" }, yours: true };
    renderBody();
    const image = await deliverFrame();
    act(() => {
      socket().onmessage?.({
        data: JSON.stringify({ type: "hello", features: ["input"] }),
      });
    });
    (image.parentElement as HTMLElement).focus();
    await userEvent.keyboard("k");
    await waitFor(() =>
      expect(
        socket()
          .sent.map((raw) => JSON.parse(raw))
          .some((m) => m.type === "input"),
      ).toBe(true),
    );
    const message = socket()
      .sent.map((raw) => JSON.parse(raw))
      .find((m) => m.type === "input");
    expect(message).toMatchObject({
      type: "input",
      seq: 1,
      events: [{ type: "text", text: "k" }],
    });
    // And NOT over HTTP: one release of fallback, not two paths at once.
    expect(api.inputs).toHaveLength(0);
  });

  it("falls back to POST against a relay that never advertised input", async () => {
    // A new client against an old server for one release. The relay's `hello`
    // is the only thing that says the socket can take input; absent it, the
    // POST route is still there.
    api.session = { ...RUNNING, lease: { state: "held" }, yours: true };
    renderBody();
    const image = await deliverFrame();
    act(() => {
      socket().onmessage?.({
        data: JSON.stringify({ type: "hello", features: [], codecs: ["jpeg"] }),
      });
    });
    (image.parentElement as HTMLElement).focus();
    await userEvent.keyboard("k");
    await waitFor(() => expect(api.inputs).toHaveLength(1));
    expect(
      socket()
        .sent.map((raw) => JSON.parse(raw))
        .some((m) => m.type === "input"),
    ).toBe(false);
  });

  it("goes back to POST when the socket drops mid-hold", async () => {
    // A reconnect must not inherit the previous connection's answer: the new
    // socket has said nothing yet, and input sent into it would vanish.
    api.session = { ...RUNNING, lease: { state: "held" }, yours: true };
    renderBody();
    const image = await deliverFrame();
    act(() => {
      socket().onmessage?.({
        data: JSON.stringify({ type: "hello", features: ["input"] }),
      });
    });
    act(() => {
      socket().readyState = 3;
    });
    (image.parentElement as HTMLElement).focus();
    await userEvent.keyboard("k");
    await waitFor(() => expect(api.inputs).toHaveLength(1));
  });
});

/**
 * V-4b. One socket carries bytes for pixels and text for control. The pane has
 * to read both without being told which is coming.
 */
describe("the hosted pane — the binary wire", () => {
  it("paints a frame that arrived as bytes", async () => {
    renderBody();
    await waitFor(() => expect(api.sockets.length).toBeGreaterThan(0));
    act(() => {
      socket().onmessage?.({
        data: encodeFrameStreamRecord({
          kind: FRAME_STREAM_KIND.frame,
          deviceWidth: 1024,
          deviceHeight: 768,
          scale: 1,
          ts: Date.now(),
          seq: 11,
          jpeg: new Uint8Array([1, 2, 3, 4]),
        }).buffer as ArrayBuffer,
      } as never);
    });
    expect(await screen.findByTestId("rail-browser-frame")).toBeTruthy();
  });

  it("still reads control messages as text on the same socket", async () => {
    renderBody();
    await waitFor(() => expect(api.sockets.length).toBeGreaterThan(0));
    act(() => {
      socket().onmessage?.({
        data: JSON.stringify({ type: "hello", features: ["input"] }),
      });
    });
    // Proved by the input path taking the socket, which only `hello` unlocks.
    api.lease = { took: true, lease: { state: "held" }, yours: true };
    act(() => {
      socket().onmessage?.({
        data: encodeFrameStreamRecord({
          kind: FRAME_STREAM_KIND.frame,
          deviceWidth: 1024,
          deviceHeight: 768,
          scale: 1,
          ts: Date.now(),
          seq: 1,
          jpeg: new Uint8Array([1, 2, 3, 4]),
        }).buffer as ArrayBuffer,
      } as never);
    });
    const image = await screen.findByTestId("rail-browser-frame");
    expect(image).toBeTruthy();
  });

  it("asks for the binary wire", async () => {
    renderBody();
    // The socket opens after a token mint, so this is not synchronous.
    await waitFor(() => expect(api.streamArgs.length).toBeGreaterThan(0));
    expect(api.streamArgs.at(-1)).toMatchObject({ wire: "binary" });
  });
});

/**
 * V-5. The video stream grabs the X display, so a model `activate_tab` changes
 * the picture out from under a watching person — and kiosk mode, which is what
 * makes "the display IS the page" true for the encoder, takes Chromium's own
 * tab strip away. These pin the two things that put it back.
 */
describe("the hosted pane — which tab is on screen", () => {
  /** Push a heartbeat carrying the daemon's tab snapshot. */
  function beat(tabs: {
    active?: string;
    list?: Array<{ id: string; url: string }>;
  }) {
    act(() => {
      socket().onmessage?.({
        data: encodeFrameStreamRecord({
          kind: FRAME_STREAM_KIND.heartbeat,
          stats: { tabs },
        }).buffer as ArrayBuffer,
      } as never);
    });
  }

  it("draws the strip Chromium's kiosk mode removed", async () => {
    renderBody();
    await waitFor(() => expect(api.sockets.length).toBeGreaterThan(0));
    beat({
      active: "b",
      list: [
        { id: "a", url: "https://example.com/one" },
        { id: "b", url: "https://other.test/two" },
      ],
    });
    const strip = await screen.findByTestId("pane-tab-strip");
    // The HOST, not the path: a strip is a few characters wide, and a path
    // carries reset tokens and account ids that have no business on screen.
    expect(strip.textContent).toContain("example.com");
    expect(strip.textContent).toContain("other.test");
    expect(strip.textContent).not.toContain("/two");
  });

  it("stays out of the way when there is only one tab", async () => {
    renderBody();
    await waitFor(() => expect(api.sockets.length).toBeGreaterThan(0));
    beat({ active: "a", list: [{ id: "a", url: "https://example.com/" }] });
    expect(screen.queryByTestId("pane-tab-strip")).toBeNull();
  });

  it("says so when the agent switches the tab under a watcher", async () => {
    renderBody();
    await waitFor(() => expect(api.sockets.length).toBeGreaterThan(0));
    const tabs = [
      { id: "a", url: "https://example.com/" },
      { id: "b", url: "https://other.test/" },
    ];
    // The first reading is not a switch: naming the tab somebody just opened
    // the pane on would be a notification about nothing.
    beat({ active: "a", list: tabs });
    expect(screen.queryByTestId("pane-notice")).toBeNull();
    beat({ active: "b", list: tabs });
    const notice = (await screen.findByTestId("pane-notice")).textContent ?? "";
    // The HOST, not the URL. A path carries reset tokens, share links and
    // account ids, and this notice is the one thing on screen large enough to
    // read from the next desk.
    expect(notice).toContain("other.test");
    expect(notice).not.toContain("https://other.test/");
  });
});

/**
 * V-7. The tier menu. What it changes depends on which tier: a bitrate change
 * is a message on the open socket, and a change of TRANSPORT is a reconnect —
 * reconnecting for a bitrate change would drop the picture to buy nothing.
 */
describe("the hosted pane — quality tiers", () => {
  async function openMenu() {
    const trigger = await screen.findByTestId("pane-settings");
    fireEvent.pointerDown(
      trigger,
      new MouseEvent("pointerdown", { bubbles: true }) as never,
    );
    fireEvent.click(trigger);
  }

  it("sends a bitrate change on the socket it already has", async () => {
    renderBody();
    await deliverFrame();
    const before = api.sockets.length;
    await openMenu();
    fireEvent.click(await screen.findByTestId("pane-tier-saver"));
    await waitFor(() =>
      expect(
        socket()
          .sent.map((raw) => JSON.parse(raw))
          .some((m) => m.type === "quality" && m.tier === "saver"),
      ).toBe(true),
    );
    // No reconnect: the picture stays up.
    expect(api.sockets).toHaveLength(before);
  });

  it("reconnects when the TRANSPORT changes", async () => {
    // `mjpeg` is the JPEG path forced, which is a different stream — the pane
    // has to ask for it, not merely stop decoding.
    renderBody();
    await deliverFrame();
    const before = api.sockets.length;
    await openMenu();
    fireEvent.click(await screen.findByTestId("pane-tier-mjpeg"));
    await waitFor(() => expect(api.sockets.length).toBeGreaterThan(before));
  });

  it("tells the DAEMON when auto steps the quality down", async () => {
    // Auto used to move only the pane's own state, so a viewer on a link that
    // could not carry the stream was labelled "Data saver" while the encoder
    // went on producing exactly the bitrate that was being dropped.
    renderBody();
    await deliverFrame();
    // Three consecutive readings, because the controller refuses to act on
    // one: half the frames offered are dropped each second.
    for (let n = 1; n <= 4; n += 1) {
      act(() => {
        socket().onmessage?.({
          data: JSON.stringify({
            type: "stats",
            framesIn: n * 20,
            dropped: n * 10,
            bytes: 0,
            subscribers: 1,
          }),
        });
      });
    }
    await waitFor(() =>
      expect(
        socket()
          .sent.map((raw) => JSON.parse(raw))
          .some((m) => m.type === "quality" && m.tier === "saver"),
      ).toBe(true),
    );
  });

  it("falls back to JPEG when the box says it cannot encode video", async () => {
    // A generic drop is worth retrying as-is; this one is not — retrying asks
    // a daemon that has already said it has no encoder for H.264 again,
    // forever, while the JPEG wire underneath works perfectly.
    vi.useFakeTimers();
    renderBody();
    await vi.waitFor(() => expect(api.sockets.length).toBe(1));
    act(() => socket().onclose?.({ code: 4415 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(api.sockets.length).toBe(2);
    const last = api.streamArgs[api.streamArgs.length - 1] as {
      codec?: string;
    };
    expect(last.codec).toBeUndefined();
    vi.useRealTimers();
  });

  it("offers the desktop view as the last resort it is", async () => {
    // The existing noVNC panel: the honest answer to "the new viewer is not
    // working for me", and only a hosted box has one.
    renderBody();
    await deliverFrame();
    await openMenu();
    fireEvent.click(await screen.findByTestId("pane-tier-vnc"));
    expect(await screen.findByTestId("vnc-panel")).toBeTruthy();
    expect(screen.queryByTestId("rail-browser-frame")).toBeNull();
  });
});
