import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const m = vi.hoisted(() => ({ stream: vi.fn(), hosted: false }));
vi.mock("../../../config.js", async (original) => ({
  ...(await original<typeof import("../../../config.js")>()),
  get HOSTED_MODE() {
    return m.hosted;
  },
}));
vi.mock("../../../utils/web-chat-turn.js", () => ({
  streamChatTurn: m.stream,
}));
vi.mock("../../../utils/skill-tools.js", () => ({
  listLocalRuntimeSkills: async () => [],
}));
import { runStandaloneTurn } from "../standalone-turn.js";
import type { ChatV2Request } from "@/shared/chat-v2";
const body: ChatV2Request = {
  model: { id: "llama3", name: "Llama 3", provider: "ollama" },
  messages: [
    { id: "1", role: "user", parts: [{ type: "text", text: "hello" }] },
  ],
  selectedServers: ["Local stdio"],
};
async function run(overrides: Partial<ChatV2Request> = {}) {
  const app = new Hono();
  app.post("/", (c) => runStandaloneTurn(c, { ...body, ...overrides }));
  return app.request("/", { method: "POST" });
}
describe("bounded standalone adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.hosted = false;
    m.stream.mockResolvedValue(new Response("ok"));
  });
  it("keeps a local provider and display-name debugger references without inventing managed identity", async () => {
    expect(
      (await run({ ollamaBaseUrl: "http://127.0.0.1:11434" })).status,
    ).toBe(200);
    expect(m.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        prepare: expect.objectContaining({
          selectedServerIds: ["Local stdio"],
          directProvider: expect.objectContaining({
            baseUrls: { ollama: "http://127.0.0.1:11434" },
          }),
        }),
        persist: expect.objectContaining({ projectId: "", runtimeSecrets: [] }),
      }),
      "standalone",
    );
    expect(m.stream.mock.calls[0][0].persist).not.toHaveProperty(
      "environmentId",
    );
  });
  it("preserves custom provider settings", async () => {
    const customProviders = [
      {
        name: "test",
        baseUrl: "http://127.0.0.1:11234/v1",
        apiKey: "fixture-key",
        modelIds: ["small"],
        protocol: "openai-compatible",
      },
    ];
    await run({ customProviders });
    expect(
      m.stream.mock.calls[0][0].prepare.directProvider.customProviders,
    ).toEqual(customProviders);
  });
  it("rejects managed authority instead of falling back", async () => {
    expect((await run({ projectId: "p" })).status).toBe(500);
    expect(m.stream).not.toHaveBeenCalled();
  });
  it("refuses standalone execution in the service role", async () => {
    m.hosted = true;
    expect((await run()).status).toBe(500);
    expect(m.stream).not.toHaveBeenCalled();
  });
  it("never disposes a borrowed debugger manager", async () => {
    await run();
    await m.stream.mock.calls[0][0].runtime.dispose();
  });
  it("binds a scope step-up to the user, so a refreshed token still resumes", async () => {
    const app = new Hono();
    app.use(async (c, next) => {
      c.set("workosUserId", "user_1");
      await next();
    });
    app.post("/", (c) =>
      runStandaloneTurn(c, { ...body, chatSessionId: "chat-1" }),
    );
    for (const token of ["Bearer before-refresh", "Bearer after-refresh"]) {
      await app.request("/", {
        method: "POST",
        headers: { authorization: token },
      });
    }
    const [suspend, resume] = m.stream.mock.calls.map(
      (call) => call[0].runtime.localScopeStepUp.bindingKey as string,
    );
    expect(resume).toBe(suspend);
    expect(suspend).toContain("user_1");
    expect(suspend).not.toContain("refresh");
  });
  it("keeps the legacy anonymous key when no one is signed in", async () => {
    await run({ chatSessionId: "chat-1" });
    expect(
      JSON.parse(m.stream.mock.calls[0][0].runtime.localScopeStepUp.bindingKey),
    ).toEqual([expect.any(String), "local-anonymous", "chat-1"]);
  });
});
