import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { releaseBrowserForChat } from "../chat-handoff";
import { createComparisonTransport } from "../comparison-transport";
import type { BrowserComparisonClient } from "@/stores/browser-comparison-store";
import * as local from "@/lib/local-browser/client";
import * as hosted from "@/lib/hosted-browser/client";

vi.mock("@/lib/local-browser/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/local-browser/client")>()),
  fetchLocalBrowserSession: vi.fn(),
  fetchLocalBrowserState: vi.fn(),
  sendLocalPaneCommand: vi.fn(),
  actOnLocalBrowserLease: vi.fn(),
}));
vi.mock("@/lib/hosted-browser/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hosted-browser/client")>()),
  createBrowserTokenCache: vi.fn((mint) => ({ get: mint })),
  fetchHostedBrowserState: vi.fn(),
  sendHostedPaneCommand: vi.fn(),
  actOnHostedBrowserLease: vi.fn(),
}));
const client: BrowserComparisonClient = {
  workspaceId: "workspace",
  projectId: "project",
  sessionId: "child",
  clientId: "cursor",
  name: "Cursor",
  order: 0,
  clientCount: 2,
  engine: "local",
};
const options = {
  holder: "same-pane-holder",
  consentToken: "consent",
  mint: vi.fn(),
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(local.actOnLocalBrowserLease).mockResolvedValue({
    lease: { state: "free" },
  });
  vi.mocked(hosted.actOnHostedBrowserLease).mockResolvedValue({
    took: true,
    yours: false,
    lease: { state: "free" },
  });
});
afterEach(() => releaseBrowserForChat(client.projectId, client.sessionId));

it("only looks up the child's local session and routes commands to its boot ID", async () => {
  vi.mocked(local.fetchLocalBrowserSession).mockResolvedValue({
    bootId: "child-boot",
  } as never);
  const transport = createComparisonTransport(client, options);
  await transport.readState();
  expect(local.fetchLocalBrowserSession).toHaveBeenCalledWith(
    "project",
    "consent",
    "child",
  );
  expect(local.fetchLocalBrowserState).toHaveBeenCalledWith({
    bootId: "child-boot",
    holder: "same-pane-holder",
    consentToken: "consent",
  });
  expect(local.sendLocalPaneCommand).not.toHaveBeenCalled();
  await transport.sendCommand({ command: { op: "close_tab", tabId: "tab" } });
  expect(local.sendLocalPaneCommand).toHaveBeenCalledWith({
    bootId: "child-boot",
    holder: "same-pane-holder",
    consentToken: "consent",
    command: { op: "close_tab", tabId: "tab" },
  });
  await releaseBrowserForChat("project", "another-child");
  expect(local.actOnLocalBrowserLease).not.toHaveBeenCalled();
  await releaseBrowserForChat("project", "child");
  expect(local.actOnLocalBrowserLease).toHaveBeenCalledWith(
    {
      bootId: "child-boot",
      holder: "same-pane-holder",
      action: "resume",
    },
    "consent",
  );
});
it("does not create a browser when lookup is empty and discards an old boot ID", async () => {
  vi.mocked(local.fetchLocalBrowserSession)
    .mockResolvedValueOnce({ bootId: "old" } as never)
    .mockResolvedValue(null);
  const transport = createComparisonTransport(client, options);
  await transport.readState();
  expect(await transport.readState()).toBeNull();
  expect(
    await transport.sendCommand({ command: { op: "create_tab" } }),
  ).toEqual({ ok: false, reason: "no_session" });
  expect(local.sendLocalPaneCommand).not.toHaveBeenCalled();
});
it("keeps hosted credentials scoped to the supplied conversation mint", async () => {
  const transport = createComparisonTransport(
    { ...client, engine: "cloud" },
    options,
  );
  await transport.readState();
  expect(hosted.createBrowserTokenCache).toHaveBeenCalledWith(options.mint);
  expect(local.fetchLocalBrowserSession).not.toHaveBeenCalled();
  expect(hosted.sendHostedPaneCommand).not.toHaveBeenCalled();
  await transport.sendCommand({ command: { op: "create_tab" } });
  expect(hosted.sendHostedPaneCommand).toHaveBeenCalledWith(expect.anything(), {
    command: { op: "create_tab" },
  });
  await releaseBrowserForChat("project", "child");
  expect(hosted.actOnHostedBrowserLease).toHaveBeenCalledWith(
    expect.anything(),
    { action: "resume" },
  );
});

it("waits for a background command and releases its original boot after metadata changes", async () => {
  let finish!: (result: { ok: true }) => void;
  vi.mocked(local.sendLocalPaneCommand).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.mocked(local.fetchLocalBrowserSession)
    .mockResolvedValueOnce({ bootId: "original" } as never)
    .mockResolvedValue({ bootId: "replacement" } as never);
  const transport = createComparisonTransport(client, options);
  await transport.readState();
  const command = transport.sendCommand({
    command: { op: "close_tab", tabId: "tab" },
  });
  const handoff = releaseBrowserForChat("project", "child");
  await transport.readState();
  expect(local.actOnLocalBrowserLease).not.toHaveBeenCalled();
  finish({ ok: true });
  await Promise.all([command, handoff]);
  expect(local.actOnLocalBrowserLease).toHaveBeenCalledWith(
    {
      bootId: "original",
      holder: "same-pane-holder",
      action: "resume",
    },
    "consent",
  );
});

it("retries a failed background handoff instead of sending chat while the lease is held", async () => {
  vi.mocked(local.fetchLocalBrowserSession).mockResolvedValue({
    bootId: "boot",
  } as never);
  vi.mocked(local.actOnLocalBrowserLease).mockRejectedValueOnce(
    new Error("offline"),
  );
  const transport = createComparisonTransport(client, options);
  await transport.readState();
  await transport.sendCommand({ command: { op: "create_tab" } });
  await expect(releaseBrowserForChat("project", "child")).rejects.toThrow(
    "offline",
  );
  await releaseBrowserForChat("project", "child");
  expect(local.actOnLocalBrowserLease).toHaveBeenCalledTimes(2);
});

it("does not treat a hosted resume as success while another holder retains the lease", async () => {
  const transport = createComparisonTransport(
    { ...client, engine: "cloud" },
    options,
  );
  await transport.sendCommand({ command: { op: "create_tab" } });
  vi.mocked(hosted.actOnHostedBrowserLease).mockResolvedValueOnce({
    took: true,
    yours: false,
    lease: { state: "held", holder: "other" },
  });
  await expect(releaseBrowserForChat("project", "child")).rejects.toThrow(
    "Couldn't return browser control",
  );
  await releaseBrowserForChat("project", "child");
});

it("forgets a handoff when the commanded local browser has closed", async () => {
  vi.mocked(local.fetchLocalBrowserSession).mockResolvedValue({
    bootId: "closed",
  } as never);
  const transport = createComparisonTransport(client, options);
  await transport.readState();
  await transport.sendCommand({ command: { op: "create_tab" } });
  vi.mocked(local.actOnLocalBrowserLease).mockRejectedValue(
    new local.LocalBrowserRequestError("No browser", 404),
  );
  await releaseBrowserForChat("project", "child");
  await releaseBrowserForChat("project", "child");
  expect(local.actOnLocalBrowserLease).toHaveBeenCalledOnce();
});
