import { describe, expect, it, vi, beforeEach } from "vitest";
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
  api.socket = null;
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
    expect(await screen.findByTestId("rail-browser-needs-chromium")).toBeTruthy();
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

    await userEvent.click(screen.getByRole("button", { name: /take control/i }));
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
      <LocalBrowserBody
        projectId="proj-2"
        consentGranted
        consentToken="tok"
      />,
    );

    await waitFor(() =>
      expect(screen.queryByTestId("rail-browser-frame")).toBeNull(),
    );
    expect(api.ensures).toEqual(["proj-1"]);
  });
});
