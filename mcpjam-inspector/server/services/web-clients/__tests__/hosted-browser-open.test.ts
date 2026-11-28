/**
 * Opening a web account's hosted browser. A session that fails to boot is
 * closed, never left open with nobody to close it, and the caller hears why
 * it didn't boot even when the close fails too. The browser session API, the
 * shell chat and the boot are fixtures. Evidence: fixture.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hosted = vi.hoisted(() => ({
  agentRequest: vi.fn(),
  provision: vi.fn(),
}));

vi.mock("../../../routes/v1/chat-session-browser.js", () => ({
  openConversationBrowser: async () => ({
    browserSessionId: "browser-session-1",
  }),
  provisionConversationBrowser: hosted.provision,
}));
vi.mock("../../../routes/v1/convex-client.js", () => ({
  createConvexClient: () => ({
    mutation: async (name: string) =>
      name === "chatSessions:claimTurnLease"
        ? {
            status: "claimed",
            turnId: "turn-1",
            executionOwnerToken: "owner-1",
          }
        : null,
  }),
}));
vi.mock("../../browserd/session-service.js", () => ({
  BrowserSessionService: class {
    agentRequest = hosted.agentRequest;
  },
}));

import { openWebClientHostedBrowser } from "../hosted-browser";

const OPEN = {
  bearer: "person-token",
  projectId: "project-1",
  vendor: "claude",
} as const;
const CLOSE = [
  "close",
  {
    bearer: "Bearer person-token",
    projectId: "project-1",
    body: { sessionId: "browser-session-1" },
  },
];

beforeEach(() => {
  hosted.agentRequest.mockReset();
  hosted.agentRequest.mockImplementation(async (operation: string) =>
    operation === "create_shell" ? { chatSessionId: "shell-chat" } : {},
  );
  hosted.provision.mockReset();
  hosted.provision.mockRejectedValue(new Error("The browser didn't boot."));
});

describe("opening a web account's hosted browser", () => {
  it("closes a session that fails to boot, and reports why it didn't boot", async () => {
    await expect(openWebClientHostedBrowser(OPEN)).rejects.toThrow(
      "The browser didn't boot.",
    );
    expect(hosted.agentRequest).toHaveBeenCalledWith(...CLOSE);
  });

  it("still reports the boot's failure when the close fails too", async () => {
    hosted.agentRequest.mockImplementation(async (operation: string) => {
      if (operation === "close") throw new Error("socket closed");
      return { chatSessionId: "shell-chat" };
    });
    await expect(openWebClientHostedBrowser(OPEN)).rejects.toThrow(
      "The browser didn't boot.",
    );
  });

  it("leaves a booted session open until its owner closes it", async () => {
    hosted.provision.mockResolvedValue({
      client: { sendCommand: vi.fn() },
      bootId: "boot-1",
    });
    const browser = await openWebClientHostedBrowser(OPEN);
    expect(hosted.agentRequest).not.toHaveBeenCalledWith(
      "close",
      expect.anything(),
    );
    await browser.close();
    expect(hosted.agentRequest).toHaveBeenCalledWith(...CLOSE);
  });
});
