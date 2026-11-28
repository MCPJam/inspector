import { beforeEach, describe, expect, it, vi } from "vitest";
const track = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({ track }));
vi.mock("@/lib/session-token", () => ({ authFetch: vi.fn() }));
import { withAppMessages } from "../app-message";

const policy = {
  resolvers: {
    resolveEffectiveHostCapabilities: () => ({ message: {} }),
    resolveEffectiveMcpAppsCapabilities: () => ({ message: true }),
  },
};
const params = {
  role: "user",
  content: [{ type: "text", text: "PRIVATE_PROMPT" }],
};
const outcomes = () =>
  track.mock.calls
    .filter((call) => call[0] === "extension_operation_completed")
    .map((call) => call[1]);
function host(send: () => Promise<boolean>) {
  return withAppMessages(
    policy as never,
    policy as never,
    { instanceToken: "x".repeat(43), messageEnabled: true } as never,
    { threadId: "thread", isLive: () => true, send, profile: () => "codex" },
  );
}

describe("App message outcomes", () => {
  beforeEach(() => track.mockClear());

  it("records one success per sent message", async () => {
    await host(async () => true).services.sendMessage!(params as never);
    expect(outcomes()).toEqual([
      {
        operation: "app_message",
        host_profile: "codex",
        outcome: "success",
        error_code: "none",
        location: "host_workspace",
      },
    ]);
  });

  it("records one failure when the chat refuses the message", async () => {
    await expect(
      host(async () => false).services.sendMessage!(params as never),
    ).rejects.toThrow();
    expect(outcomes()).toEqual([
      expect.objectContaining({ outcome: "failure", error_code: "refused" }),
    ]);
  });

  it("records one failure when the send throws, without its content", async () => {
    await expect(
      host(async () => {
        throw new Error("PRIVATE_PROMPT failed");
      }).services.sendMessage!(params as never),
    ).rejects.toThrow();
    expect(outcomes()).toEqual([
      expect.objectContaining({ outcome: "failure", error_code: "other" }),
    ]);
    expect(JSON.stringify(track.mock.calls)).not.toContain("PRIVATE");
  });
});
