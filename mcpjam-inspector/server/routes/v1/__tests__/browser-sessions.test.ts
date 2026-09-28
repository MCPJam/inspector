import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  send: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "verified-bearer",
}));
vi.mock("../../../utils/built-in-tools/browser.js", () => ({
  ensureHostedConversationSession: mocks.ensure,
}));
import router from "../browser-sessions.js";
const session = {
  sessionId: "s1",
  ownerUserId: "u1",
  owner: { kind: "conversation", id: "agent-owner" },
  policy: { mode: "allow_all" },
  state: "active",
};
function request(op: string, body: Record<string, unknown>) {
  return router.request(`/browser-sessions/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "p1", ...body }),
  });
}
beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockReset();
  mocks.ensure.mockReset();
  mocks.send.mockReset();
  mocks.ensure.mockResolvedValue({
    bootId: "boot",
    client: { sendCommand: mocks.send },
  });
  mocks.send.mockResolvedValue({
    status: "ok",
    result: { ok: true, output: { url: "https://example.com", text: "Hello" } },
  });
  mocks.fetch.mockImplementation(async (url: URL) => {
    const op = url.pathname.split("/").pop();
    return Response.json(
      op === "get" || op === "open"
        ? { session }
        : op === "claim"
          ? { claimed: true, seq: 1 }
          : { ok: true },
    );
  });
});
describe("cloud agent browser route", () => {
  it("opens its own logical owner through the shared hosted lifecycle", async () => {
    const response = await request("session", {
      policy: { mode: "allow_all" },
      runKey: "test",
    });
    expect(response.status).toBe(200);
    expect(mocks.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        logicalSessionId: "agent-owner",
        ownerKind: "conversation",
        bearer: "verified-bearer",
      }),
    );
  });
  it("claims before driving and stamps agent source regardless of caller fields", async () => {
    const response = await request("command", {
      sessionId: "s1",
      commandId: "cmd",
      command: { op: "navigate", url: "https://example.com" },
      source: "manual",
      actor: { id: "admin" },
    });
    expect((await response.json()).status).toBe("executed");
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "agent",
        actor: expect.objectContaining({ label: "u1" }),
      }),
      "boot",
    );
    expect(mocks.fetch.mock.calls.map((c) => c[0].pathname)).toEqual([
      "/agent-browser/get",
      "/agent-browser/claim",
      "/agent-browser/finish",
    ]);
  });
  it("never executes a pending claim again", async () => {
    mocks.fetch.mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname.endsWith("get")
          ? { session }
          : { claimed: false, result: null, seq: 1 },
      ),
    );
    const response = await request("command", {
      sessionId: "s1",
      commandId: "cmd",
      command: { op: "navigate", url: "https://example.com" },
    });
    expect((await response.json()).status).toBe("unknown");
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("denies ownership failure before any daemon or provisioning call", async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({ error: "Browser session not found" }, { status: 404 }),
    );
    expect(
      (
        await request("command", {
          sessionId: "other",
          command: { op: "observe", mode: "a11y" },
        })
      ).status,
    ).toBe(404);
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("applies stored read-only policy before provisioning", async () => {
    mocks.fetch.mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname.endsWith("get")
          ? { session: { ...session, policy: { mode: "read_only" } } }
          : { claimed: true, seq: 1 },
      ),
    );
    const response = await request("command", {
      sessionId: "s1",
      command: { op: "navigate", url: "https://example.com" },
    });
    expect((await response.json()).status).toBe("refused");
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("withholds screenshot artifacts after an off-policy redirect", async () => {
    mocks.fetch.mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname.endsWith("get")
          ? {
              session: {
                ...session,
                policy: {
                  mode: "allowlist",
                  originAllowlist: ["https://example.com"],
                },
              },
            }
          : { claimed: true, seq: 1 },
      ),
    );
    mocks.send.mockResolvedValue({
      status: "ok",
      result: {
        ok: true,
        output: { url: "https://outside.test", screenshot: "aGVsbG8=" },
      },
    });
    const response = await request("command", {
      sessionId: "s1",
      command: { op: "navigate", url: "https://example.com" },
    });
    const result = await response.json();
    expect(result.ok).toBe(false);
    expect(result.page).toBeUndefined();
    const finish = JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body);
    expect(finish.screenshot).toBeUndefined();
  });
  it("reports provisioning failure as a refusal and transport failure as unknown", async () => {
    mocks.ensure.mockRejectedValueOnce(
      new Error("Desktop capacity unavailable"),
    );
    const first = await request("command", {
      sessionId: "s1",
      command: { op: "navigate", url: "https://example.com" },
    });
    expect(await first.json()).toMatchObject({
      status: "refused",
      refusal: {
        code: "browser_unavailable",
        message: "Desktop capacity unavailable",
      },
    });
    mocks.send.mockRejectedValueOnce(new Error("socket closed"));
    const second = await request("command", {
      sessionId: "s1",
      command: { op: "navigate", url: "https://example.com" },
    });
    expect((await second.json()).status).toBe("unknown");
  });
  it("validates malformed commands before command admission", async () => {
    const response = await request("command", {
      sessionId: "s1",
      command: { op: "act", verb: "execute_code" },
    });
    expect(response.status).toBe(400);
    expect(mocks.fetch.mock.calls).toHaveLength(1);
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("maps a WebMCP invocation through the same agent command boundary", async () => {
    const response = await request("command", {
      sessionId: "s1",
      command: {
        op: "invoke_page_tool",
        toolKey: "getAvailability",
        input: { day: "Monday" },
      },
    });
    expect((await response.json()).status).toBe("executed");
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "agent",
        action: {
          kind: "webmcp_invoke",
          toolKey: "getAvailability",
          input: { day: "Monday" },
        },
      }),
      "boot",
    );
  });
  it("maps handoff refusal without capturing a page", async () => {
    mocks.send.mockResolvedValue({ status: "lease_blocked", lease: "parked" });
    const response = await request("command", {
      sessionId: "s1",
      command: { op: "observe", mode: "screenshot" },
    });
    expect(await response.json()).toMatchObject({
      status: "refused",
      refusal: { code: "lease_parked" },
    });
  });
});
