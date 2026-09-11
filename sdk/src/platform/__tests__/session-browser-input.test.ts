import { platformBrowserToolPolicySchema } from "../browser-policy.js";
import { describe, expect, it, vi } from "vitest";
import { driveChatSessionBrowserOperation as operation } from "../operations.js";
describe("session browser admission", () => {
  it.each([
    { op: "navigate", sessionId: "s" },
    { op: "navigate", sessionId: "s", url: "file:///etc/passwd" },
    { op: "act", sessionId: "s" },
    { op: "act", sessionId: "s", command: { verb: "invalid" } },
    { op: "invoke", sessionId: "s", toolKey: "submit" },
    { op: "note", sessionId: "s" },
    { op: "close" },
    { op: "open", idempotencyKey: "key" },
  ])("rejects malformed %j before network or approval", async (input) => {
    expect(operation.inputSchema.safeParse(input).success).toBe(false);
    const client = {
      chatSessionBrowser: vi.fn(),
      createChatSessionBrowser: vi.fn(),
    };
    await expect(
      operation.execute(input as never, { client } as never)
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 0 });
    expect(client.chatSessionBrowser).not.toHaveBeenCalled();
    expect(client.createChatSessionBrowser).not.toHaveBeenCalled();
  });
  it.each([
    { op: "navigate", sessionId: "s", url: "https://example.com" },
    {
      op: "act",
      sessionId: "s",
      command: { verb: "click", target: { ref: "e1" } },
    },
    { op: "invoke", sessionId: "s", toolKey: "submit", input: {} },
    { op: "open", policy: { mode: "read_only" }, idempotencyKey: "key" },
  ])("accepts complete %j", (input) =>
    expect(operation.inputSchema.safeParse(input).success).toBe(true)
  );
});

it.each([
  { mode: "allowlist" },
  { mode: "allowlist", originAllowlist: [] },
  { mode: "read_only", toolAllowlist: ["browser_navigate"] },
  { mode: "allow_all", originAllowlist: ["file:///"] },
])("rejects invalid policy %j", (policy) =>
  expect(platformBrowserToolPolicySchema.safeParse(policy).success).toBe(false)
);
