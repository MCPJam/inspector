import { beforeEach, expect, it, vi } from "vitest";
import { createComparisonTransport } from "../comparison-transport";
import type { BrowserComparisonClient } from "@/stores/browser-comparison-store";
import * as local from "@/lib/local-browser/client";
import * as hosted from "@/lib/hosted-browser/client";

vi.mock("@/lib/local-browser/client", () => ({
  fetchLocalBrowserSession: vi.fn(),
  fetchLocalBrowserState: vi.fn(),
  sendLocalPaneCommand: vi.fn(),
}));
vi.mock("@/lib/hosted-browser/client", () => ({
  createBrowserTokenCache: vi.fn((mint) => ({ get: mint })),
  fetchHostedBrowserState: vi.fn(),
  sendHostedPaneCommand: vi.fn(),
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
beforeEach(() => vi.clearAllMocks());

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
});
