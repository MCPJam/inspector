import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
    ensureLocalBrowser: async () => ({
      bootId: "boot-1",
      contextMode: "persistent" as const,
      lease: api.lease,
    }),
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
    openLocalBrowserFrameStream: () => ({
      socket: { readyState: 1, send: () => {}, close: () => {} } as never,
      close: () => {},
    }),
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
});

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
