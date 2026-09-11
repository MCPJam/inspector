import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  scoped: vi.fn(),
  get: vi.fn(),
  open: vi.fn(),
  provision: vi.fn(),
  control: vi.fn(),
  send: vi.fn(),
  status: vi.fn(),
  enqueue: vi.fn(),
  flush: vi.fn(),
}));
vi.mock("../chat-sessions", () => ({
  chatSessionClient: async () => ({
    query: mocks.query,
    mutation: mocks.mutation,
  }),
  resolveScopedSession: mocks.scoped,
}));
vi.mock("../../../utils/v1-convex-token", () => ({
  getConvexBearerForRequest: async () => "token",
}));
vi.mock("../../../services/browserd/session-service", () => ({
  BrowserSessionService: class {
    agentRequest = mocks.control;
  },
  BrowserSessionServiceError: class extends Error {},
}));
vi.mock("../chat-session-browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chat-session-browser")>()),
  getConversationBrowser: mocks.get,
  openConversationBrowser: mocks.open,
  provisionConversationBrowser: mocks.provision,
}));
vi.mock("../../../utils/built-in-tools/registry", () => ({
  resolveHostTools: () => ({ browser_observe: {} }),
}));
vi.mock("../../../services/browser-artifact-outbox", () => ({
  createBrowserArtifactOutbox: () => ({
    enqueueSteps: mocks.enqueue,
    flush: mocks.flush,
  }),
}));
import { registerChatSessionBrowserRoutes } from "../chat-session-browser-routes";
const app = new Hono();
registerChatSessionBrowserRoutes(app);
const browser = {
  browserSessionId: "logical",
  sessionId: "logical",
  policy: { mode: "allow_all" },
  state: "active",
  lastBootId: "boot",
};
const request = (op: string, body: unknown = {}) =>
  app.request(`/chat-sessions/session/browser/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.scoped.mockResolvedValue({
    _id: "session",
    projectId: "project",
    chatSessionId: "wire",
    origin: "api",
    resumeConfig: { toolMode: "auto" },
  });
  mocks.get.mockResolvedValue(browser);
  mocks.open.mockResolvedValue(browser);
  mocks.provision.mockResolvedValue({
    bootId: "boot",
    client: { sendCommand: mocks.send, status: mocks.status },
  });
  mocks.send.mockResolvedValue({
    status: "ok",
    result: { ok: true, output: { url: "https://example.com", text: "hello" } },
  });
  mocks.query.mockResolvedValue({ browserInteractionSteps: [] });
  mocks.control.mockImplementation(async (op: string) =>
    op === "claim" ? { claimed: true, seq: 1 } : { ok: true },
  );
  mocks.flush.mockResolvedValue(undefined);
  mocks.status.mockResolvedValue({ kind: "ok", features: ["webmcp-binding"] });
});
describe("conversation browser commands", () => {
  it("refuses restricted page-tool invocation on a daemon without binding enforcement", async () => {
    mocks.status.mockResolvedValue({ kind: "ok", features: [] });
    mocks.get.mockResolvedValue({ ...browser, policy: { mode: "allowlist", originAllowlist: ["https://example.com"] } });
    const response = await request("command", { commandId: "call", command: { op: "invoke_page_tool", toolKey: "submit", input: {} } });
    expect((await response.json()).status).toBe("refused");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("binds direct page-tool commands to the checked frame registration", async () => {
    mocks.get.mockResolvedValue({ ...browser, policy: { mode: "allowlist", originAllowlist: ["https://example.com"] } });
    mocks.send.mockResolvedValueOnce({ status: "ok", result: { ok: true, output: { url: "https://example.com", tools: [{ name: "submit", origin: "https://example.com", frameId: "frame", registrationSeq: 4 }] }, stateToken: { tabId: "tab", navCounter: 2, urlHash: "u", domHash: "d" } } });
    const response = await request("command", { commandId: "call", command: { op: "invoke_page_tool", toolKey: "submit", input: {} } });
    expect(response.status).toBe(200);
    expect(mocks.send.mock.calls[1][0].action.expectedBinding).toEqual({ bootId: "boot", tabId: "tab", navCounter: 2, frameId: "frame", registrationSeq: 4 });
  });
  it.each(["file:///etc/passwd", "data:text/html,hello", "javascript:alert(1)"])("rejects non-web navigation %s before admission", async (url) => {
    expect((await request("command", { commandId: "c1", command: { op: "navigate", url } })).status).toBe(400);
    expect(mocks.control).not.toHaveBeenCalled();
    expect(mocks.provision).not.toHaveBeenCalled();
  });
  it("preserves the opened session receipt when lease cleanup fails", async () => {
    mocks.mutation.mockImplementation(async (name: string) => {
      if (name === "chatSessions:claimTurnLease") return { status: "claimed", turnId: "turn", executionOwnerToken: "owner" };
      throw new Error("cleanup unavailable");
    });
    mocks.control.mockResolvedValue({ sessionId: "session", chatSessionId: "wire" });
    const response = await app.request("/chat-sessions/browser", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "project", policy: { mode: "allow_all" }, idempotencyKey: "key" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessionId: "session", chatSessionId: "wire", browser: { state: "active" } });
    expect(mocks.mutation).toHaveBeenCalledWith("chatSessions:releaseTurnLease", expect.anything());
  });
  it("refuses non-API origins before browser lookup", async () => {
    mocks.scoped.mockResolvedValue({ origin: "playground" });
    expect((await request("open")).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("records policy refusals without provisioning or dispatch", async () => {
    mocks.get.mockResolvedValue({ ...browser, policy: { mode: "read_only" } });
    const response = await request("command", {
      commandId: "c1",
      command: { op: "navigate", url: "https://example.com" },
    });
    expect((await response.json()).status).toBe("refused");
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(mocks.control).toHaveBeenCalledWith(
      "finish",
      expect.objectContaining({
        body: expect.objectContaining({ commandId: "c1" }),
      }),
    );
  });
  it("does not replay an admitted command with an unknown outcome", async () => {
    mocks.control.mockResolvedValue({ claimed: false, seq: 1, result: null });
    expect(
      (
        await (
          await request("command", {
            commandId: "c1",
            command: { op: "observe", mode: "a11y" },
          })
        ).json()
      ).status,
    ).toBe("unknown");
    expect(mocks.provision).not.toHaveBeenCalled();
  });
  it("checks the current page before an action under an origin restriction", async () => {
    mocks.get.mockResolvedValue({
      ...browser,
      policy: { mode: "allowlist", originAllowlist: ["https://example.com"] },
    });
    mocks.send.mockResolvedValue({
      status: "ok",
      result: { output: { url: "https://other.example" } },
    });
    expect(
      (
        await (
          await request("command", {
            commandId: "c1",
            command: { op: "act", verb: "click", target: { ref: "e1" } },
          })
        ).json()
      ).status,
    ).toBe("refused");
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][0].action.kind).toBe("observe");
  });
  it("never returns or stores screenshots from a redirected origin", async () => {
    mocks.get.mockResolvedValue({
      ...browser,
      policy: { mode: "allowlist", originAllowlist: ["https://example.com"] },
    });
    mocks.send.mockResolvedValue({
      status: "ok",
      result: {
        output: { url: "https://other.example", screenshot: "private-pixels" },
      },
    });
    const response = await request("command", {
      commandId: "c1",
      command: { op: "navigate", url: "https://example.com" },
    });
    const value = await response.json();
    expect(value).toMatchObject({ status: "executed", ok: false, error: { code: "origin_not_allowed" } });
    expect(JSON.stringify(value)).not.toContain("private-pixels");
    expect(JSON.stringify(mocks.enqueue.mock.calls)).not.toContain(
      "private-pixels",
    );
  });
  it("joins artifacts using command identity and does not wake the desktop", async () => {
    mocks.query.mockResolvedValue({
      browserInteractionSteps: [
        { turnId: "other", toolCallId: "c1", screenshotUrl: "wrong" },
        {
          turnId: "command:c1",
          toolCallId: "c1",
          screenshotUrl: "https://storage.test/image",
        },
      ],
    });
    expect(
      await (await request("artifact", { commandId: "c1" })).json(),
    ).toMatchObject({
      sessionId: "session",
      url: "https://storage.test/image",
    });
    expect(mocks.provision).not.toHaveBeenCalled();
  });
  it("guards close against a different boot and never provisions", async () => {
    expect((await request("close")).status).toBe(200);
    expect(mocks.control).toHaveBeenCalledWith(
      "close",
      expect.objectContaining({
        body: { sessionId: "logical", expectedBootId: "boot" },
      }),
    );
    expect(mocks.provision).not.toHaveBeenCalled();
  });
  it("rejects non-object request bodies", async () => {
    expect((await request("command", null)).status).toBe(400);
  });
});
