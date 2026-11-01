import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { MCPClientManager } from "@mcpjam/sdk";
import { createMockMcpClientManager } from "./helpers/mock-mcp-client-manager.js";

const shared = vi.hoisted(() => ({
  managed: vi.fn(),
  stream: vi.fn(),
  normalize: vi.fn(),
  skills: vi.fn(),
}));
vi.mock("../../web/chat-v2.js", () => ({
  handleManagedChatTurn: shared.managed,
  default: new Hono(),
}));
vi.mock("../../../utils/web-chat-turn.js", () => ({ streamChatTurn: shared.stream }));
vi.mock("../../../services/chat-turn/local-request.js", () => ({ normalizeLocalManagedRequest: shared.normalize }));
vi.mock("../../../utils/skill-tools.js", () => ({ listLocalRuntimeSkills: shared.skills }));
import chat from "../chat-v2.js";
import { requestLogContextMiddleware } from "../../../middleware/request-log-context.js";

const model = { id: "llama3", name: "Llama", provider: "ollama" };
const message = { id: "question", role: "user", parts: [{ type: "text", text: "hello" }] };
const manager = Object.assign(new MCPClientManager(), createMockMcpClientManager());
function post(body: unknown, bearer?: string) {
  const app = new Hono();
  app.use("*", requestLogContextMiddleware, async (c, next) => {
    c.mcpClientManager = manager;
    await next();
  });
  app.route("/api/mcp/chat-v2", chat);
  return app.request("/api/mcp/chat-v2", { method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks();
  shared.managed.mockImplementation(async () => new Response("managed"));
  shared.stream.mockImplementation(async () => new Response("standalone"));
  shared.normalize.mockImplementation(async (_c, body) => body);
  shared.skills.mockResolvedValue([]);
});

describe("local chat ingress", () => {
  it("requires an object and validates standalone messages and model", async () => {
    expect((await post(null)).status).toBe(400);
    expect((await post({ model })).status).toBe(400);
    expect((await post({ messages: [message] })).status).toBe(400);
    expect(shared.stream).not.toHaveBeenCalled();
  });
  it("retains the no-project direct-provider path without creating a managed environment", async () => {
    const response = await post({ model, messages: [message], selectedServers: ["Local server"], ollamaBaseUrl: "http://127.0.0.1:11434" });
    expect(response.status).toBe(200);
    expect(shared.managed).not.toHaveBeenCalled();
    expect(shared.stream).toHaveBeenCalledWith(expect.objectContaining({
      manager,
      prepare: expect.objectContaining({ selectedServerIds: ["Local server"],
        directProvider: expect.objectContaining({ baseUrls: expect.objectContaining({ ollama: "http://127.0.0.1:11434" }) }) }),
      persist: expect.objectContaining({ projectId: "", runtimeSecrets: [] }),
    }), "standalone");
  });
  it("preserves an explicit empty standalone selection", async () => {
    await post({ model, messages: [message], selectedServers: [] });
    expect(shared.stream.mock.lastCall?.[0].prepare.selectedServerIds).toEqual([]);
  });
  it("requires bearer authentication for every managed request", async () => {
    expect((await post({ projectId: "project", model, messages: [message] })).status).toBe(401);
    expect(shared.managed).not.toHaveBeenCalled();
    expect(shared.stream).not.toHaveBeenCalled();
  });
  it.each([
    { projectId: "project", selectedServerIds: [] },
    { executionTarget: { kind: "environment", environmentId: "saved" } },
    { hostId: "client" },
    { scenarioId: "scenario" },
    { selectedServerIds: ["saved-server"] },
    { projectId: "" },
  ])("never downgrades a managed target to standalone: %j", async (target) => {
    shared.managed.mockResolvedValue(new Response("denied", { status: 403 }));
    expect((await post({ ...target, model, messages: [message] }, "member")).status).toBe(403);
    expect(shared.managed).toHaveBeenCalledOnce();
    expect(shared.stream).not.toHaveBeenCalled();
  });
  it("passes canonical normalized setup to the local managed adapter", async () => {
    const normalized = { projectId: "project", selectedServerIds: ["saved-server"] };
    shared.normalize.mockResolvedValue(normalized);
    await post({ projectId: "project", selectedServers: ["Display name"], model, messages: [message] }, "member");
    expect(shared.managed).toHaveBeenCalledWith(expect.anything(), "local", normalized);
  });
  it("refuses an organization selection without its project", async () => {
    const response = await post({ model: { id: "gpt-5", provider: "openai" }, messages: [message],
      modelSelection: { source: "org", modelId: "gpt-5", connectionRef: { kind: "orgProvider", id: "connection" }, fallback: { provider: "none", model: "none" } } });
    expect(response.status).toBe(400);
    expect(shared.stream).not.toHaveBeenCalled();
  });
  it("rejects malformed resume instructions before executing", async () => {
    const response = await post({ model, messages: [message], scopeStepUpResume: {} });
    expect(response.status).toBe(400);
    expect(shared.stream).not.toHaveBeenCalled();
  });
});
