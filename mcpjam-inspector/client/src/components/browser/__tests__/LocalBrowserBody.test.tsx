vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: { id: "member" } }),
}));
import { releaseBrowserForChat } from "@/lib/browser-shell/chat-handoff";
import { useBrowserPageToolsStore } from "@/stores/browser-page-tools-store";
import { beforeAll } from "vitest";
beforeAll(() => {
  window.PointerEvent = MouseEvent as typeof PointerEvent;
});
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const grantConsent = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/hooks/useLocalBrowserConsent", () => ({
  useLocalBrowserConsent: () => ({ grant: grantConsent }),
}));

const api = vi.hoisted(() => ({
  workspaceEnabled: true,
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
  ensureError: null as Error | null,
  ensureGate: null as Promise<void> | null,
  lookup: vi.fn(
    async (
      _project: string,
      _token: string | null,
      _session: string,
    ): Promise<any> => null,
  ),
  streams: [] as string[],
  /** Every "somebody is looking at this" the pane sent, by boot id. */
  watches: [] as string[],
  /** Make `watch` answer 404, as it does for a browser that has gone. */
  watchMissing: false,
  /** Holds the next lease answer open, so a test can move the pane under it. */
  leaseGate: null as Promise<void> | null,
  /** What the shell's state poll answers. Null is "cannot say", as in life. */
  state: null as unknown,
  /** Every pane command the shell sent, in order. */
  paneCommands: [] as unknown[],
  /**
   * Answer pane commands 501, as a daemon older than these endpoints does.
   *
   * `supportsPane()` duck-types the browserd client, so a browser started by
   * a pre-pane daemon has a real session and refuses all three routes.
   */
  paneUnsupported: false,
  /** Every panel measurement reported. */
  viewports: [] as Array<{ width: number; height: number; policy?: string }>,
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

vi.mock("@/hooks/useComputersEnabled", () => ({
  useBrowserWorkspaceEnabled: () => api.workspaceEnabled,
}));

vi.mock("@/components/browser/BrowserSettingsButton", () => ({
  BrowserSettingsButton: () => null,
}));

vi.mock("@/lib/local-browser/client", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/local-browser/client")
  >("@/lib/local-browser/client");
  return {
    ...actual,
    fetchLocalBrowserStatus: async () => api.status,
    fetchLocalBrowserSession: api.lookup,
    startLocalBrowserInstall: async () => {
      api.installs += 1;
      return { install: { status: "installing" as const, percent: 0 } };
    },
    ensureLocalBrowser: async (projectId: string) => {
      api.ensures.push(projectId);
      if (api.ensureGate) await api.ensureGate;
      if (api.ensureError) throw api.ensureError;
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
    // The shell's three calls. Answered rather than left to the real module,
    // which would reach the network and leave the shell permanently
    // reconnecting — a state that is correct but drowns every other assertion.
    fetchLocalBrowserState: async () =>
      api.state ?? {
        seq: 1,
        tabs: [
          {
            id: "t1",
            url: "https://example.test",
            title: "Example",
            loading: false,
            navCounter: 0,
          },
        ],
        activeTabId: "t1",
        canGoBack: false,
        canGoForward: false,
        viewport: { width: 1024, height: 768, revision: 0 },
        policy: "fixed",
        control: { kind: "agent" },
      },
    sendLocalPaneCommand: async (args: any) => {
      api.paneCommands.push(args.command);
      if (api.paneUnsupported) {
        return { ok: false as const, reason: "unsupported" as const };
      }
      return { ok: true as const };
    },
    reportLocalPaneViewport: async (args: any) => {
      api.viewports.push({
        width: args.width,
        height: args.height,
        policy: args.policy,
      });
      return { width: args.width, height: args.height, revision: 1 };
    },
    openLocalBrowserFrameStream: (args: { bootId: string }) => {
      api.streams.push(args.bootId);
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
import { BrowserWorkspaceChrome } from "../BrowserWorkspaceChrome";

beforeEach(() => {
  api.workspaceEnabled = true;
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
  api.ensureError = null;
  api.ensureGate = null;
  api.lookup.mockReset().mockResolvedValue(null);
  api.streams = [];
  api.watches = [];
  api.leaseGate = null;
  api.watchMissing = false;
  api.socket = null;
  api.state = null;
  api.paneCommands = [];
  api.paneUnsupported = false;
  api.viewports = [];
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

/**
 * Take the browser the way a person does: by clicking the page.
 *
 * A frame first, because there is no picture to click until one arrives — and
 * jsdom lays nothing out, so the pane cannot map a point without a rectangle
 * to map it against.
 */
async function clickPicture() {
  const image = await deliverFrame();
  image.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1024, height: 768 }) as DOMRect;
  fireEvent.click(image, { clientX: 10, clientY: 10 });
  return image;
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
  it("offers Chromium installation before a comparison session exists", async () => {
    api.status = {
      ...api.status,
      installed: false,
      install: { status: "idle" },
    } as typeof api.status;
    render(
      <BrowserWorkspaceChrome.Provider
        value={{ holderId: "comparison-holder" }}
      >
        <LocalBrowserBody
          projectId="proj-1"
          sessionId="cursor-session"
          consentGranted
          consentToken="tok"
        />
      </BrowserWorkspaceChrome.Provider>,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Install Chromium" }),
    );
    expect(api.installs).toBe(1);
    expect(api.ensures).toEqual([]);
  });

  it("notifies comparison chrome when an existing session is discovered", async () => {
    const ready = vi.fn();
    api.lookup.mockResolvedValue({
      bootId: "existing",
      lease: { state: "free" },
    });
    render(
      <BrowserWorkspaceChrome.Provider
        value={{ holderId: "comparison-holder" }}
      >
        <LocalBrowserBody
          projectId="proj-1"
          sessionId="cursor-session"
          consentGranted
          consentToken="tok"
          onSessionReady={ready}
        />
      </BrowserWorkspaceChrome.Provider>,
    );
    await waitFor(() => expect(ready).toHaveBeenCalledOnce());
    expect(api.ensures).toEqual([]);
  });

  it("only attaches to existing sessions when viewing a comparison client", async () => {
    render(
      <BrowserWorkspaceChrome.Provider
        value={{ clientName: "Cursor", holderId: "comparison-holder" }}
      >
        <LocalBrowserBody
          projectId="proj-1"
          sessionId="cursor-session"
          consentGranted
          consentToken="tok"
        />
      </BrowserWorkspaceChrome.Provider>,
    );
    await waitFor(() =>
      expect(api.lookup).toHaveBeenCalledWith(
        "proj-1",
        "tok",
        "cursor-session",
      ),
    );
    expect(api.ensures).toEqual([]);
    expect(api.streams).toEqual([]);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("grants Browser-only consent from the Browser panel", async () => {
    const view = renderBody({ consentGranted: false });
    expect(await screen.findByTestId("rail-browser-unconsented")).toBeTruthy();
    expect(screen.queryByText(/Open the Computer tab/)).toBeNull();
    expect(
      screen.getByText(/Allow agents to navigate, click, type, and read pages/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(grantConsent).toHaveBeenCalled();
    expect(api.ensures).toEqual([]);
    view.rerender(
      <LocalBrowserBody
        projectId="proj-1"
        consentGranted
        consentToken="new-token"
      />,
    );
    await waitFor(() => expect(api.ensures).toEqual(["proj-1"]));
    expect(
      screen.queryByRole("button", { name: "Open the browser" }),
    ).toBeNull();
  });

  it("waits until the Browser tab is visible to launch", async () => {
    const view = renderBody({ active: false });
    await act(async () => {});
    expect(api.ensures).toEqual([]);
    view.rerender(
      <LocalBrowserBody
        projectId="proj-1"
        consentGranted
        consentToken="tok"
        active
      />,
    );
    await waitFor(() => expect(api.ensures).toEqual(["proj-1"]));
  });

  it("offers an explicit retry after startup fails without looping", async () => {
    api.ensureError = new Error("Startup failed");
    const view = renderBody();
    const retry = await screen.findByRole("button", { name: "Try again" });
    view.rerender(
      <LocalBrowserBody projectId="proj-1" consentGranted consentToken="tok" />,
    );
    expect(api.ensures).toEqual(["proj-1"]);
    api.ensureError = null;
    await userEvent.click(retry);
    await waitFor(() => expect(api.streams).toContain("boot-proj-1"));
    expect(api.ensures).toEqual(["proj-1", "proj-1"]);
  });

  it("shows a failed grant inline and allows retry", async () => {
    grantConsent.mockResolvedValueOnce(false);
    renderBody({ consentGranted: false });
    await userEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(await screen.findByTestId("consent-error")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(screen.queryByTestId("consent-error")).toBeNull(),
    );
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

  it("says who is driving, and takes the browser when somebody uses it", async () => {
    // There is no "Take control" button any more. Clicking the picture IS
    // taking it, which is what every browser anybody has used does.
    renderBody();
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
    expect(await screen.findByText(/agent is driving/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /take control/i })).toBeNull();

    await clickPicture();
    expect(await screen.findByText(/you’re in control/i)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /let agent browse/i }),
    ).toBeNull();
  });

  it("takes the browser on a paste, and sends the text", async () => {
    // Pasting into the page is somebody using the browser, exactly as typing
    // is. Returning early while the agent held the lease dropped the paste
    // silently — no text, no takeover, and nothing on screen to say why.
    renderBody();
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
    const image = await deliverFrame();
    fireEvent.paste(image, {
      clipboardData: { getData: () => "hello from the clipboard" },
    });
    expect(await screen.findByText(/you’re in control/i)).toBeTruthy();
    await waitFor(() =>
      expect(
        api.inputs
          .flatMap((call: any) => call.events as any[])
          .some(
            (event) =>
              event?.type === "text" &&
              event.text === "hello from the clipboard",
          ),
      ).toBe(true),
    );
  });

  it("sends an Alt shortcut as a shortcut, not as a letter", async () => {
    // `Alt+F` reports a single-character `key` — "f" on Linux and Windows,
    // "ƒ" on macOS — so a text test that only excluded Ctrl and Meta dropped
    // the Alt modifier and typed a stray character into the page instead of
    // opening the menu the person asked for.
    renderBody();
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
    const image = await deliverFrame();
    fireEvent.keyDown(image, { key: "f", code: "KeyF", altKey: true });
    await waitFor(() => expect(api.inputs.length).toBeGreaterThan(0));
    const events = api.inputs.flatMap((call: any) => call.events as any[]);
    expect(events.some((e) => e?.type === "text")).toBe(false);
    expect(events.some((e) => e?.type === "key_down" && e.key === "f")).toBe(
      true,
    );
  });

  it("sends no input until this pane holds the browser", async () => {
    // The server refuses it anyway; not sending is the honest UI of the same
    // rule, and keeps a stray mouse move off the wire entirely.
    renderBody();
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(screen.getByText(/agent is driving/i)).toBeTruthy(),
    );
    expect(api.inputs).toHaveLength(0);
  });

  it("hands the browser back so the agent can continue", async () => {
    renderBody();
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
    await clickPicture();
    await screen.findByText("You’re in control");
    await act(async () => releaseBrowserForChat("proj-1"));
    expect(await screen.findByText(/agent is driving/i)).toBeTruthy();
  });
});

describe("the agent browser pane — driving it", () => {
  async function takeControl() {
    renderBody();
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
    await clickPicture();
    await screen.findByText(/you’re in control/i);
    // The click that TOOK the browser is itself input, and it has already been
    // forwarded. A test counting what it sends afterwards must not count it.
    await waitFor(() => expect(api.inputs.length).toBeGreaterThan(0));
    api.inputs = [];
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

    mouseDown(image, { clientX: 10, clientY: 10, button: 2 });
    mouseUp(image, { clientX: 10, clientY: 10, button: 2 });

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

    mouseDown(image, { clientX: 10, clientY: 10, button: 1 });
    fireEvent.pointerCancel(image, { clientX: 10, clientY: 10 });

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
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
    await screen.findByText(/agent is driving/i);
    await deliverFrame();

    view.rerender(
      <LocalBrowserBody projectId="proj-2" consentGranted consentToken="tok" />,
    );

    await waitFor(() =>
      expect(screen.queryByTestId("rail-browser-frame")).toBeNull(),
    );
    expect(api.ensures).toEqual(["proj-1", "proj-2"]);
  });

  it("drops the previous conversation's browser when the session changes", async () => {
    // The same argument as the project switch above, one level down. A durable
    // session is a browser identity in its own right — the agent drives
    // `<project>:session:<id>` — so a conversation switch inside ONE project
    // changes which browser this pane is looking at. Keyed on projectId alone,
    // the reset saw no change: the rail kept showing conversation A's page,
    // aimed input at it, and a profile export saved A's bytes under B's id.
    const view = render(
      <LocalBrowserBody
        projectId="proj-1"
        sessionId="chat-a"
        consentGranted
        consentToken="tok"
      />,
    );
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
    await screen.findByText(/agent is driving/i);
    await deliverFrame();

    view.rerender(
      <LocalBrowserBody
        projectId="proj-1"
        sessionId="chat-b"
        consentGranted
        consentToken="tok"
      />,
    );

    await waitFor(() =>
      expect(screen.queryByTestId("rail-browser-frame")).toBeNull(),
    );
    await screen.findByRole("button", { name: "Open the browser" });
    expect(api.ensures).toEqual(["proj-1"]);
    await userEvent.click(
      screen.getByRole("button", { name: "Open the browser" }),
    );
    await waitFor(() => expect(api.ensures).toEqual(["proj-1", "proj-1"]));
  });

  it("reattaches each chat's existing browser when switching A to B to A", async () => {
    api.lookup.mockImplementation(async (_project, _token, id) => ({
      bootId: `boot-${id}`,
      contextMode: "persistent",
      lease: { state: "free" },
    }));
    const body = (sessionId: string) => (
      <LocalBrowserBody
        projectId="proj-1"
        sessionId={sessionId}
        consentGranted
        consentToken="tok"
      />
    );
    const view = render(body("chat-a"));
    await waitFor(() => expect(api.streams.at(-1)).toBe("boot-chat-a"));
    view.rerender(body("chat-b"));
    await waitFor(() => expect(api.streams.at(-1)).toBe("boot-chat-b"));
    view.rerender(body("chat-a"));
    await waitFor(() => expect(api.streams.at(-1)).toBe("boot-chat-a"));
    expect(api.ensures).toEqual([]);
    expect(api.inputs).toEqual([]);
    expect(api.paneCommands).toEqual([]);
  });

  it("ignores a late lookup after leaving a conversation", async () => {
    let resolve!: (value: any) => void;
    api.lookup.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = renderBody({ sessionId: "chat-a" });
    await waitFor(() => expect(api.lookup).toHaveBeenCalled());
    view.rerender(
      <LocalBrowserBody
        projectId="proj-1"
        sessionId="chat-b"
        consentGranted
        consentToken="tok"
      />,
    );
    await act(async () =>
      resolve({
        bootId: "boot-chat-a",
        contextMode: "persistent",
        lease: { state: "free" },
      }),
    );
    await screen.findByRole("button", { name: "Open the browser" });
    expect(api.streams).toEqual([]);
    expect(api.ensures).toEqual([]);
  });

  it("finds a browser the agent opens after automatic startup fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.ensureError = new Error("Browser busy");
      api.lookup.mockResolvedValueOnce(null).mockResolvedValue({
        bootId: "agent-boot",
        contextMode: "persistent",
        lease: { state: "free" },
      });
      renderBody({ sessionId: "chat-a" });
      await screen.findByRole("button", { name: "Try again" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });
      expect(api.streams.at(-1)).toBe("agent-boot");
      expect(api.ensures).toEqual(["proj-1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([{ active: false }, { consentGranted: false }])(
    "does not look up browsers while unavailable: %j",
    async (over) => {
      renderBody({ sessionId: "chat-a", ...over });
      await act(async () => {});
      expect(api.lookup).not.toHaveBeenCalled();
    },
  );

  it("opens automatically when session lookup is unsupported", async () => {
    api.lookup.mockRejectedValue(new Error("Not found"));
    renderBody({ sessionId: "chat-a" });
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
    await waitFor(() => expect(api.streams).toContain("boot-proj-1"));
  });

  it("ignores a lease answer from a browser the pane has left", async () => {
    // Away and back again. The project id reads "proj-1" both times, so a
    // guard that compares ids alone sees no change and applies the answer —
    // and the pane says "You have control" of a browser that was torn down,
    // wiring its keyboard and mouse to nothing. Two visits are two browsers.
    const view = renderBody();
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
    await screen.findByText(/agent is driving/i);

    let release!: () => void;
    api.leaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await clickPicture();

    for (const projectId of ["proj-2", "proj-1"]) {
      view.rerender(
        <LocalBrowserBody
          projectId={projectId}
          consentGranted
          consentToken="tok"
        />,
      );
    }

    await waitFor(() =>
      expect(api.ensures).toEqual(["proj-1", "proj-2", "proj-1"]),
    );
    await act(async () => release());
    api.leaseGate = null;

    expect(screen.getByText(/agent is driving/i)).toBeTruthy();
    expect(screen.queryByText(/you’re in control/i)).toBeNull();
  });
});

describe("the agent browser pane — when the grant goes away", () => {
  it("ignores a pending startup when permission is revoked", async () => {
    let finish!: () => void;
    api.ensureGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const view = renderBody();
    await waitFor(() => expect(api.ensures).toEqual(["proj-1"]));
    view.rerender(
      <LocalBrowserBody
        projectId="proj-1"
        consentGranted={false}
        consentToken={null}
      />,
    );
    await act(async () => finish());
    expect(screen.getByTestId("rail-browser-unconsented")).toBeTruthy();
    expect(api.streams).toEqual([]);
    expect(api.socket).toBeNull();
  });

  it("STOPS SHOWING the browser the moment consent is revoked", async () => {
    // The picture is of somebody's signed-in browser. The pane's own
    // placeholder cannot enforce this — the surface renders a frame whenever
    // there is one — so before this the last captured frame stayed on screen
    // after the grant was withdrawn. The socket does close on its own, its
    // nonce carrying a consent fingerprint, but not before the next frame and
    // never for the one already in state.
    const view = renderBody();
    // The socket only opens once a browser is running.
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
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
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
    await clickPicture();
    await waitFor(() => expect(api.lease.holder).toBeTruthy());

    // A reload is a fresh mount against the same tab's sessionStorage.
    first.unmount();
    renderBody();
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));

    // Recognised as the same hands: control, not a refusal.
    expect(await screen.findByText(/you’re in control/i)).toBeTruthy();
  });

  it("does not adopt a hold belonging to a different tab", async () => {
    // The identity is per tab, so it still tells two panes apart — the whole
    // reason it exists.
    api.lease = { state: "held", holder: "rail-someone-else" };
    renderBody();
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
    expect(await screen.findByText(/someone else is driving/i)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /let agent browse/i }),
    ).toBeNull();
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
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
    expect(await screen.findByTestId("rail-browser-native-slot")).toBeTruthy();
    expect(screen.getByTestId("browser-new-tab")).toBeTruthy();
    await waitFor(() => expect(api.ensures).toContain("proj-1"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.socket).toBeNull();
    expect(screen.queryByTestId("rail-browser-frame")).toBeNull();
  });

  it("publishes page-tool changes without a frame socket", async () => {
    asDesktopApp();
    useBrowserPageToolsStore.setState({ live: {}, epoch: {} });
    api.state = {
      seq: 1,
      tabs: [
        {
          id: "pizza-tab",
          url: "https://pizza.test",
          title: "Pizza",
          loading: false,
          navCounter: 0,
        },
      ],
      activeTabId: "pizza-tab",
      canGoBack: false,
      canGoForward: false,
      viewport: { width: 1024, height: 768, revision: 0 },
      policy: "fixed",
      control: { kind: "agent" },
      webmcp: { revision: 4, hash: "pizza", count: 7 },
    };
    renderBody();
    await screen.findByTestId("rail-browser-native-slot");
    await waitFor(() =>
      expect(
        useBrowserPageToolsStore.getState().live["proj-1:local"],
      ).toMatchObject({
        revision: 4,
        hash: "pizza",
        count: 7,
        tabId: "pizza-tab",
        bootId: "boot-proj-1",
      }),
    );
    expect(api.socket).toBeNull();
  });

  it("still says somebody is watching, with no socket to say it", async () => {
    // The frame socket's heartbeat was the only evidence the idle reap ever
    // saw. Without a replacement, a person watching the agent work — and not
    // holding the lease — has their browser closed while they are looking at
    // it.
    asDesktopApp();
    renderBody();
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
    await screen.findByTestId("rail-browser-native-slot");
    await waitFor(() => expect(api.watches).toContain("boot-proj-1"));
  });

  it("fits the native page to its slot with workspace chrome disabled", async () => {
    asDesktopApp();
    api.workspaceEnabled = false;
    const rect = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue({
        x: 700,
        y: 100,
        left: 700,
        top: 100,
        width: 480,
        height: 600,
        right: 1180,
        bottom: 700,
        toJSON: () => ({}),
      } as DOMRect);
    try {
      renderBody();
      await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
      await screen.findByTestId("rail-browser-native-slot");
      await waitFor(() =>
        expect(api.viewports).toContainEqual({
          width: 480,
          height: 600,
          policy: "followPane",
        }),
      );
      expect(api.viewports.at(-1)?.policy).toBe("followPane");
      expect(api.socket).toBeNull();
    } finally {
      rect.mockRestore();
    }
  });

  it("falls back to frames when the box turned the native surface off", async () => {
    // `MCPJAM_BROWSER_NATIVE_SURFACE=false`. The server built its context with
    // hidden windows, so there is no view to place — and a pane that branched
    // anyway would render a slot nothing ever paints into.
    asDesktopApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (api.status as any).surface = "frames";
    renderBody();
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
    await deliverFrame();
    expect(screen.queryByTestId("rail-browser-native-slot")).toBeNull();
  });

  it("falls back to frames in a desktop app that has no channel to ask", async () => {
    // A shipped app older than this wave reports `runtime: "electron"` exactly
    // as a new one does and has no `agentBrowser` at all.
    asDesktopApp({ api: false });
    renderBody();
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
    await deliverFrame();
    expect(screen.queryByTestId("rail-browser-native-slot")).toBeNull();
  });

  it("falls back to frames when this Electron has no WebContentsView", async () => {
    asDesktopApp({ available: false });
    renderBody();
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
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
      await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
      await screen.findByText(/agent is driving/i);
      api.socket?.onmessage?.({
        data: JSON.stringify({
          type: "input_ack",
          seq: 1,
          refused: "lease_held",
        }),
      });
      await screen.findByText(/somebody else has taken control/i);
      // The pane says who has it; there is no button to withhold any more.
      expect(screen.queryByText(/you’re in control/i)).toBeNull();

      api.lease = { state: "free", holder: undefined };
      const ensuresBefore = api.ensures.length;
      const watchesBefore = api.watches.length;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await screen.findByText(/agent is driving/i)).toBeTruthy();
      expect(screen.queryByText(/somebody else has taken control/i)).toBeNull();
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
      await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
      await screen.findByText(/agent is driving/i);
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
      await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
      await screen.findByText(/agent is driving/i);
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

describe("a browser whose daemon predates the pane endpoints", () => {
  it("stops offering controls that swallow every click", async () => {
    // The whole chain, because each link on its own looks fine: the routes
    // answer 501, the wire mapper calls that `unsupported`, and the hook
    // swallows it deliberately. Only here does it show up as a tab strip and
    // an address field that look live and do nothing.
    api.paneUnsupported = true;
    renderBody();
    await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
    const newTab = await screen.findByTestId("browser-new-tab");
    // Enabled first: nothing has refused yet, and the state poll cannot tell
    // us — it answers null for an old engine and a busy one alike.
    expect(newTab).not.toBeDisabled();

    await userEvent.click(newTab);

    await waitFor(() =>
      expect(screen.getByTestId("browser-new-tab")).toBeDisabled(),
    );
    // The strip stays on screen. A browser whose chrome vanishes reads as one
    // that crashed, which is a worse lie than one that is merely old.
    expect(screen.getByTestId("browser-tab-strip")).toBeInTheDocument();
    expect(screen.getByTestId("browser-address")).toBeDisabled();
  });
});

it("keeps navigation when the workspace flag is off", async () => {
  api.workspaceEnabled = false;
  renderBody();
  await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
  expect(await screen.findByTestId("browser-new-tab")).toBeInTheDocument();
  expect(screen.getByTestId("browser-address")).toBeInTheDocument();
});

it("takes control but drops the first click if the daemon cannot identify the page", async () => {
  api.state = {
    seq: 1,
    tabs: [
      {
        id: "t1",
        url: "https://example.test",
        title: "Example",
        loading: false,
      },
    ],
    activeTabId: "t1",
    canGoBack: false,
    canGoForward: false,
    viewport: { width: 1024, height: 768, revision: 0 },
    policy: "fixed",
    control: { kind: "agent" },
  };
  renderBody();
  await waitFor(() => expect(api.ensures.length).toBeGreaterThan(0));
  await clickPicture();
  expect(await screen.findByTestId("browser-notice")).toBeTruthy();
  expect(api.inputs).toEqual([]);
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

it("resizes the streamed browser to the rail even with workspace placement off", async () => {
  api.workspaceEnabled = false;
  let measure: ((width: number, height: number) => void) | undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: (entries: unknown[]) => void) {}
      observe(element: HTMLElement) {
        if (element.dataset.testid === "browser-page-area") {
          measure = (width, height) =>
            this.callback([{ contentRect: { width, height } }]);
        }
      }
      disconnect() {}
      unobserve() {}
    },
  );
  try {
    renderBody();
    await waitFor(() =>
      expect(screen.getByTestId("browser-new-tab")).not.toBeDisabled(),
    );
    act(() => measure?.(620, 1160));
    await waitFor(() =>
      expect(api.viewports).toContainEqual({
        width: 620,
        height: 1160,
        policy: "followPane",
      }),
    );
    act(() => measure?.(820, 900));
    await waitFor(() =>
      expect(api.viewports.at(-1)).toEqual({
        width: 820,
        height: 900,
        policy: "followPane",
      }),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps profile saving in settings rather than the browser toolbar", async () => {
  renderBody({ sessionId: "profile-chat" });
  await waitFor(() =>
    expect(screen.getByTestId("browser-new-tab")).not.toBeDisabled(),
  );
  expect(screen.queryByRole("button", { name: "Save profile" })).toBeNull();
  expect(screen.queryByText("Save profile for other chats…")).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Browser view settings" }),
  );
  expect(
    await screen.findByRole("menuitem", {
      name: "Save profile for other chats…",
    }),
  ).toBeVisible();
});

it("finishes automatic handoff when the pane unmounts during the request", async () => {
  const view = renderBody();
  await screen.findByText(/agent is driving/i);
  await clickPicture();
  await screen.findByText("You’re in control");
  let finish!: () => void;
  api.leaseGate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const handoff = releaseBrowserForChat("proj-1");
  view.unmount();
  finish();
  await expect(handoff).resolves.toBeUndefined();
  expect(api.lease.state).toBe("free");
  await expect(releaseBrowserForChat("proj-1")).resolves.toBeUndefined();
});

it("uses cryptographic randomness for a new lease holder", async () => {
  const random = vi.spyOn(crypto, "getRandomValues");
  try {
    renderBody();
    await screen.findByText(/agent is driving/i);
    expect(random).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(window.sessionStorage.getItem("mcpjam.localBrowser.holder")).toMatch(
      /^rail-[0-9a-f]{32}$/,
    );
  } finally {
    random.mockRestore();
  }
});
