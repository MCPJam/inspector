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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
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
    openHostedBrowserFrameStream: () => {
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

import { HostedBrowserBody } from "../HostedBrowserBody";

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
      act(() => socket().onclose?.({ code: 4401 }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
    }
    expect(api.sockets.length).toBeLessThanOrEqual(6);
    expect(screen.getByText(/no longer authorized/)).toBeTruthy();
    vi.useRealTimers();
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
});
