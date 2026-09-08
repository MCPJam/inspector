import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({
  status: {
    installed: true,
    install: { status: "ready" as const },
    running: false,
    leaseHeld: false,
  },
  lease: { state: "free" as string, holder: undefined as string | undefined },
  installs: 0,
  inputs: [] as unknown[],
  ensures: [] as string[],
  /** Every "somebody is looking at this" the pane sent, by boot id. */
  watches: [] as string[],
  /** Make `watch` answer 404, as it does for a browser that has gone. */
  watchMissing: false,
  /** Holds the next lease answer open, so a test can move the pane under it. */
  leaseGate: null as Promise<void> | null,
  /** The last socket handed to the pane, so a test can deliver a frame. */
  socket: null as {
    readyState: number;
    send(data: string): void;
    close(): void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number }) => void;
    onopen?: () => void;
  } | null,
}));

vi.mock("@/lib/local-browser/client", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/local-browser/client")
  >("@/lib/local-browser/client");
  return {
    ...actual,
    fetchLocalBrowserStatus: async () => api.status,
    startLocalBrowserInstall: async () => {
      api.installs += 1;
      return { install: { status: "installing" as const, percent: 0 } };
    },
    ensureLocalBrowser: async (projectId: string) => {
      api.ensures.push(projectId);
      return {
        bootId: `boot-${projectId}`,
        contextMode: "persistent" as const,
        lease: api.lease,
      };
    },
    mintLocalBrowserFrameNonce: async () => ({
      nonce: "n".repeat(32),
      expiresAtMs: Date.now() + 60_000,
    }),
    actOnLocalBrowserLease: async ({ action, holder }: any) => {
      if (api.leaseGate) await api.leaseGate;
      api.lease =
        action === "resume"
          ? { state: "free", holder: undefined }
          : { state: "held", holder };
      return { lease: api.lease };
    },
    sendLocalBrowserInput: async (args: any) => {
      api.inputs.push(args);
      return { ok: true as const };
    },
    noteLocalBrowserWatch: async (args: any) => {
      api.watches.push(args.bootId);
      // The route is keyed by `bootId` and answers 404 when that browser has
      // gone — crashed, closed, or reaped.
      if (api.watchMissing) {
        throw new actual.LocalBrowserRequestError("No such local browser", 404);
      }
      // The route reports who holds the browser as well as that somebody is
      // watching it — which is how a refused pane hears about a hand-back.
      return { watching: true as const, lease: api.lease };
    },
    openLocalBrowserFrameStream: () => {
      const socket = {
        readyState: 1,
        send: () => {},
        close: () => {},
      };
      api.socket = socket;
      return { socket: socket as never, close: () => {} };
    },
  };
});

import { LocalBrowserBody } from "../LocalBrowserBody";

beforeEach(() => {
  api.status = {
    installed: true,
    install: { status: "ready" },
    running: false,
    leaseHeld: false,
  };
  api.lease = { state: "free", holder: undefined };
  api.installs = 0;
  api.inputs = [];
  api.ensures = [];
  api.watches = [];
  api.leaseGate = null;
  api.watchMissing = false;
  api.socket = null;
  window.sessionStorage.clear();
});

/** Push one frame down the pane's socket so the picture renders. */
async function deliverFrame() {
  await waitFor(() => expect(api.socket).not.toBeNull());
  api.socket?.onmessage?.({
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
  return screen.findByTestId("rail-browser-frame");
}

function renderBody(over: Record<string, unknown> = {}) {
  return render(
    <LocalBrowserBody
      projectId="proj-1"
      consentGranted
      consentToken="tok"
      {...(over as never)}
    />,
  );
}

describe("the agent browser pane", () => {
  it("points at the Computer tab instead of asking for consent twice", async () => {
    renderBody({ consentGranted: false });
    expect(await screen.findByTestId("rail-browser-unconsented")).toBeTruthy();
  });

  it("offers the download when this machine has no Chromium", async () => {
    api.status = {
      installed: false,
      install: { status: "idle" },
      running: false,
      leaseHeld: false,
    };
    renderBody();
    expect(
      await screen.findByTestId("rail-browser-needs-chromium"),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /install/i }));
    await waitFor(() => expect(api.installs).toBe(1));
  });

  it("shows the download's progress rather than looking frozen", async () => {
    api.status = {
      installed: false,
      install: { status: "installing", percent: 42 },
      running: false,
      leaseHeld: false,
    };
    renderBody();
    expect(await screen.findByText(/42%/)).toBeTruthy();
  });

  it("says who is driving, and offers control only when nobody is", async () => {
    renderBody();
    await userEvent.click(
      await screen.findByRole("button", { name: /open the browser/i }),
    );
    expect(await screen.findByText(/agent is driving/i)).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: /take control/i }),
    );
    expect(await screen.findByText(/you have control/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /hand back/i })).toBeTruthy();
  });

  it("sends no input until this pane holds the browser", async () => {
    // The server refuses it anyway; not sending is the honest UI of the same
    // rule, and keeps a stray mouse move off the wire entirely.
    renderBody();
    await userEvent.click(
      await screen.findByRole("button", { name: /open the browser/i }),
    );
    await waitFor(() =>
      expect(screen.getByText(/agent is driving/i)).toBeTruthy(),
    );
    expect(api.inputs).toHaveLength(0);
  });

  it("hands the browser back", async () => {
    renderBody();
    await userEvent.click(
      await screen.findByRole("button", { name: /open the browser/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /take control/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /hand back/i }),
    );
    expect(await screen.findByText(/agent is driving/i)).toBeTruthy();
  });
});

describe("the agent browser pane — driving it", () => {
  async function takeControl() {
    renderBody();
    await userEvent.click(
      await screen.findByRole("button", { name: /open the browser/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /take control/i }),
    );
    await screen.findByText(/you have control/i);
  }

  it("moves the keyboard to the pane, not the button that took control", async () => {
    // The click that acquired the lease left focus on the button, so
    // everything typed afterwards went to the button and never reached the
    // page — a browser you hold but cannot type into.
    await takeControl();
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("tabindex")).toBe("0"),
    );
  });

  it("sends a right-click as a right-click", async () => {
    // Both handlers hard-coded `button: "left"`, so a context-menu click and a
    // middle-click both arrived at the page as ordinary left clicks.
    await takeControl();
    const image = await deliverFrame();
    // jsdom lays nothing out, so the pane cannot map a point without one.
    image.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1024, height: 768 }) as DOMRect;

    fireEvent.mouseDown(image, { clientX: 10, clientY: 10, button: 2 });
    fireEvent.mouseUp(image, { clientX: 10, clientY: 10, button: 2 });

    await waitFor(() => expect(api.inputs.length).toBeGreaterThan(0));
    const buttons = api.inputs
      .flatMap((call: any) => call.events as any[])
      .filter((e) => e.type === "mouse_down" || e.type === "mouse_up")
      .map((e) => e.button);
    expect(buttons.length).toBe(2);
    expect(buttons.every((b: string) => b === "right")).toBe(true);
  });

  it("releases the button the drag actually started with", async () => {
    // A middle- or right-button drag that leaves the picture was released as
    // LEFT, so the page kept holding the button it was really given.
    await takeControl();
    const image = await deliverFrame();
    image.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1024, height: 768 }) as DOMRect;

    fireEvent.mouseDown(image, { clientX: 10, clientY: 10, button: 1 });
    fireEvent.mouseLeave(image, { clientX: 10, clientY: 10 });

    await waitFor(() => expect(api.inputs.length).toBeGreaterThan(0));
    const released = api.inputs
      .flatMap((call: any) => call.events as any[])
      .filter((e) => e.type === "mouse_up");
    expect(released).toHaveLength(1);
    expect(released[0].button).toBe("middle");
  });

  it("drops the previous project's browser when the project changes", async () => {
    // Session, lease and frame all belong to ONE project's browser. Carrying
    // them across a switch shows one project's page in another's rail, and
    // aims input at it.
    const view = renderBody();
    await userEvent.click(
      await screen.findByRole("button", { name: /open the browser/i }),
    );
    await screen.findByText(/agent is driving/i);
    await deliverFrame();

    view.rerender(
      <LocalBrowserBody projectId="proj-2" consentGranted consentToken="tok" />,
    );

    await waitFor(() =>
      expect(screen.queryByTestId("rail-browser-frame")).toBeNull(),
    );
    expect(api.ensures).toEqual(["proj-1"]);
  });

  it("ignores a lease answer from a browser the pane has left", async () => {
    // Away and back again. The project id reads "proj-1" both times, so a
    // guard that compares ids alone sees no change and applies the answer —
    // and the pane says "You have control" of a browser that was torn down,
    // wiring its keyboard and mouse to nothing. Two visits are two browsers.
    const view = renderBody();
    await userEvent.click(
      await screen.findByRole("button", { name: /open the browser/i }),
    );
    await screen.findByText(/agent is driving/i);

    let release!: () => void;
    api.leaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await userEvent.click(
      await screen.findByRole("button", { name: /take control/i }),
    );

    for (const projectId of ["proj-2", "proj-1"]) {
      view.rerender(
        <LocalBrowserBody
          projectId={projectId}
          consentGranted
          consentToken="tok"
        />,
      );
    }

    release();
    api.leaseGate = null;
    await waitFor(() => expect(api.ensures).toEqual(["proj-1"]));

    expect(screen.getByText(/agent is driving/i)).toBeTruthy();
    expect(screen.queryByText(/you have control/i)).toBeNull();
  });
});

describe("the agent browser pane — when the grant goes away", () => {
  it("STOPS SHOWING the browser the moment consent is revoked", async () => {
    // The picture is of somebody's signed-in browser. The pane's own
    // placeholder cannot enforce this — the surface renders a frame whenever
    // there is one — so before this the last captured frame stayed on screen
    // after the grant was withdrawn. The socket does close on its own, its
    // nonce carrying a consent fingerprint, but not before the next frame and
    // never for the one already in state.
    const view = renderBody();
    // The socket only opens once a browser is running.
    await userEvent.click(
      await screen.findByRole("button", { name: /open the browser/i }),
    );
    await deliverFrame();

    view.rerender(
      <LocalBrowserBody
        projectId="proj-1"
        consentGranted={false}
        consentToken={null}
      />,
    );
    expect(screen.queryByTestId("rail-browser-frame")).toBeNull();
    expect(screen.getByTestId("rail-browser-unconsented")).toBeTruthy();
  });
});

describe("the agent browser pane — a hold you can get back", () => {
  it("keeps its lease identity across a reload", async () => {
    // A hold that runs out PARKS, and only its holder may hand it back. With
    // an identity minted per mount, reloading while holding left the lease
    // parked under a holder that no longer existed: the agent blocked, every
    // new pane refused, and only restarting the server cleared it.
    const first = renderBody();
    await userEvent.click(
      await screen.findByRole("button", { name: /open the browser/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /take control/i }),
    );
    expect(api.lease.holder).toBeTruthy();

    // A reload is a fresh mount against the same tab's sessionStorage.
    first.unmount();
    renderBody();
    await userEvent.click(
      await screen.findByRole("button", { name: /open the browser/i }),
    );

    // Recognised as the same hands: control, not a refusal.
    expect(await screen.findByText(/you have control/i)).toBeTruthy();
  });

  it("does not adopt a hold belonging to a different tab", async () => {
    // The identity is per tab, so it still tells two panes apart — the whole
    // reason it exists.
    api.lease = { state: "held", holder: "rail-someone-else" };
    renderBody();
    await userEvent.click(
      await screen.findByRole("button", { name: /open the browser/i }),
    );
    expect(await screen.findByText(/has control/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /hand back/i })).toBeNull();
  });
});

describe("the agent browser pane — the desktop app's own browser", () => {
  /** Pretend to be the desktop app, with or without the native channel. */
  const asDesktopApp = (over: { available?: boolean; api?: boolean } = {}) => {
    api.status = {
      installed: true,
      install: { status: "ready" },
      running: false,
      leaseHeld: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ runtime: "electron", surface: "native" } as any),
    };
    if (over.api === false) return;
    (window as unknown as { electronAPI?: unknown }).electronAPI = {
      agentBrowser: {
        capability: async () => ({ available: over.available ?? true }),
        setViewport: async () => ({ shown: true, inputAllowed: false }),
      },
    };
  };

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it("shows the page itself, and opens no frame socket at all", async () => {
    // THE POINT OF THE WHOLE PATH. The browser is a view in this very process;
    // a socket here would make the engine encode JPEGs at 30 fps that nobody
    // ever draws.
    asDesktopApp();
    renderBody();
    // The slot FIRST: `capability()` resolves a tick after mount, and the pane
    // swaps component trees when it does — a button found before that is a
    // detached node by the time a click reaches it.
    expect(await screen.findByTestId("rail-browser-native-slot")).toBeTruthy();
    await userEvent.click(await screen.findByText("Open the browser"));
    await waitFor(() => expect(api.ensures).toContain("proj-1"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.socket).toBeNull();
    expect(screen.queryByTestId("rail-browser-frame")).toBeNull();
  });

  it("still says somebody is watching, with no socket to say it", async () => {
    // The frame socket's heartbeat was the only evidence the idle reap ever
    // saw. Without a replacement, a person watching the agent work — and not
    // holding the lease — has their browser closed while they are looking at
    // it.
    asDesktopApp();
    renderBody();
    await screen.findByTestId("rail-browser-native-slot");
    await userEvent.click(await screen.findByText("Open the browser"));
    await waitFor(() => expect(api.watches).toContain("boot-proj-1"));
  });

  it("falls back to frames when the box turned the native surface off", async () => {
    // `MCPJAM_BROWSER_NATIVE_SURFACE=false`. The server built its context with
    // hidden windows, so there is no view to place — and a pane that branched
    // anyway would render a slot nothing ever paints into.
    asDesktopApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (api.status as any).surface = "frames";
    renderBody();
    await userEvent.click(await screen.findByText("Open the browser"));
    await deliverFrame();
    expect(screen.queryByTestId("rail-browser-native-slot")).toBeNull();
  });

  it("falls back to frames in a desktop app that has no channel to ask", async () => {
    // A shipped app older than this wave reports `runtime: "electron"` exactly
    // as a new one does and has no `agentBrowser` at all.
    asDesktopApp({ api: false });
    renderBody();
    await userEvent.click(await screen.findByText("Open the browser"));
    await deliverFrame();
    expect(screen.queryByTestId("rail-browser-native-slot")).toBeNull();
  });

  it("falls back to frames when this Electron has no WebContentsView", async () => {
    asDesktopApp({ available: false });
    renderBody();
    await userEvent.click(await screen.findByText("Open the browser"));
    await deliverFrame();
    expect(screen.queryByTestId("rail-browser-native-slot")).toBeNull();
  });
});

describe("the agent browser pane — when somebody else is driving", () => {
  it("asks again until they hand it back", async () => {
    // The refusal arrives on the frame socket. The HAND-BACK arrives as
    // nothing at all — the frames were flowing the whole time, so there is no
    // reconnect, no `hello`, and no ack to carry the news. Without a re-read
    // the pane goes on saying somebody else is driving and withholds Take
    // control (offered only on a free lease) until the page is reloaded.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderBody();
      await userEvent.click(
        await screen.findByRole("button", { name: /open the browser/i }),
      );
      await screen.findByRole("button", { name: /take control/i });
      api.socket?.onmessage?.({
        data: JSON.stringify({
          type: "input_ack",
          seq: 1,
          refused: "lease_held",
        }),
      });
      await screen.findByText(/somebody else has taken control/i);
      expect(
        screen.queryByRole("button", { name: /take control/i }),
      ).toBeNull();

      api.lease = { state: "free", holder: undefined };
      const ensuresBefore = api.ensures.length;
      const watchesBefore = api.watches.length;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(
        await screen.findByRole("button", { name: /take control/i }),
      ).toBeTruthy();
      expect(
        screen.queryByText(/somebody else has taken control/i),
      ).toBeNull();
      // THROUGH `watch`, not `ensure`. `ensure` starts a browser when the one
      // it was asked about has gone, so a crash under a waiting pane would
      // launch a Chromium nobody asked for and answer with a different boot's
      // lease.
      expect(api.ensures.length).toBe(ensuresBefore);
      // COUNTED, not merely present: this pane is not the native surface, so
      // nothing else beats on `watch` — but an assertion that a name appears
      // somewhere in a list would have passed on an earlier call rather than
      // on the one this test is about.
      expect(api.watches.length).toBeGreaterThan(watchesBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers to open a new one when the browser it was waiting for has gone", async () => {
    // `watch` is keyed by `bootId`, so its 404 is an ANSWER: that browser is
    // not coming back. Retrying past it left the pane saying somebody else was
    // driving a browser that no longer existed, with no way out but a reload.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderBody();
      await userEvent.click(
        await screen.findByRole("button", { name: /open the browser/i }),
      );
      await screen.findByRole("button", { name: /take control/i });
      await deliverFrame();
      api.socket?.onmessage?.({
        data: JSON.stringify({
          type: "input_ack",
          seq: 1,
          refused: "lease_held",
        }),
      });
      await screen.findByText(/somebody else has taken control/i);

      api.watchMissing = true;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(
        await screen.findByRole("button", { name: /open the browser/i }),
      ).toBeTruthy();
      expect(screen.queryByText(/somebody else has taken control/i)).toBeNull();
      // AND THE PICTURE IS GONE. It was of a browser that no longer exists,
      // and leaving it up under an "Open the browser" button is a pane showing
      // a page nobody can click on any more.
      expect(screen.queryByTestId("rail-browser-frame")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops asking the moment the grant is withdrawn", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const view = renderBody();
      await userEvent.click(
        await screen.findByRole("button", { name: /open the browser/i }),
      );
      await screen.findByRole("button", { name: /take control/i });
      api.socket?.onmessage?.({
        data: JSON.stringify({
          type: "input_ack",
          seq: 1,
          refused: "lease_held",
        }),
      });
      await screen.findByText(/somebody else has taken control/i);

      view.rerender(
        <LocalBrowserBody
          projectId="proj-1"
          consentGranted={false}
          consentToken="tok"
        />,
      );
      const watchesAfterRevoke = api.watches.length;
      await vi.advanceTimersByTimeAsync(20_000);
      // Every call this poll makes carries the consent token. A pane whose
      // grant has been withdrawn asking again every five seconds is a pane
      // arguing with a decision the person already made.
      expect(api.watches.length).toBe(watchesAfterRevoke);
    } finally {
      vi.useRealTimers();
    }
  });
});
