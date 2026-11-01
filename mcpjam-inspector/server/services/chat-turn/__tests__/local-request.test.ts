import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  bearer: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("../../evals/route-helpers.js", () => ({
  createConvexClient: () => ({ query: mocks.query }),
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: mocks.bearer,
}));
import {
  assertStandaloneConversation,
  normalizeLocalManagedRequest,
} from "../local-request.js";
import { WebRouteError } from "../../../routes/web/errors.js";
function request(body: Record<string, unknown>) {
  const app = new Hono();
  app.post("/", async (c) => {
    try {
      return c.json(await normalizeLocalManagedRequest(c, body));
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });
  return app.request("/", { method: "POST" });
}
describe("local saved server identity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it("rejects a managed conversation with omitted project identity", async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({ ok: true, session: { projectId: "p" } }),
    );
    const app = new Hono();
    app.get("/", async (c) => {
      await assertStandaloneConversation(c, "chat");
      return c.text("unexpected");
    });
    expect((await app.request("/")).status).toBe(500);
    expect(String(mocks.fetch.mock.calls[0][0])).toContain(
      "chatSessionId=chat",
    );
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CONVEX_HTTP_URL", "https://configured.example");
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.bearer.mockResolvedValue("actor-token");
  });
  async function standaloneOutcome(session: unknown) {
    mocks.fetch.mockResolvedValueOnce(Response.json({ ok: true, session }));
    const app = new Hono();
    app.get("/", async (c) => {
      try {
        await assertStandaloneConversation(c, "chat");
        return c.json({ outcome: "allowed" });
      } catch (error) {
        return c.json({
          outcome: error instanceof WebRouteError ? error.status : "error",
        });
      }
    });
    return (await (await app.request("/")).json()).outcome;
  }
  it("resumes a pre-cutover direct chat the legacy route saved as ad hoc", async () => {
    expect(
      await standaloneOutcome({
        resumeConfig: { executionTarget: { kind: "adhoc" } },
      }),
    ).toBe("allowed");
  });
  it.each([
    { projectId: "p", resumeConfig: { executionTarget: { kind: "adhoc" } } },
    { resumeConfig: { executionTarget: { kind: "host", hostId: "h" } } },
    { resumeConfig: { executionTarget: { kind: "unknown" } } },
    { resumeConfig: { environmentId: "e", executionTarget: { kind: "adhoc" } } },
  ])("keeps a managed conversation out of standalone execution (%o)", async (session) => {
    expect(await standaloneOutcome(session)).toBe(409);
  });
  it("allows a new conversation but refuses a backend outage", async () => {
    const app = new Hono();
    app.get("/", async (c) => {
      await assertStandaloneConversation(c, "new-chat");
      return c.text("allowed");
    });
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect((await app.request("/")).status).toBe(200);
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect((await app.request("/")).status).toBe(500);
  });
  it("keeps an absent selection absent", async () => {
    expect(await (await request({ projectId: "p" })).json()).not.toHaveProperty(
      "selectedServerIds",
    );
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("keeps explicit empty IDs without looking up names", async () => {
    const response = await request({
      projectId: "p",
      selectedServerIds: [],
      selectedServers: ["old"],
    });
    expect(await response.json()).toMatchObject({ selectedServerIds: [] });
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("only resolves names inside the selected project", async () => {
    mocks.query.mockResolvedValue([{ _id: "server-a", name: "same name" }]);
    const response = await request({
      projectId: "project-a",
      selectedServers: ["same name"],
    });
    expect(await response.json()).toMatchObject({
      selectedServerIds: ["server-a"],
    });
    expect(mocks.query).toHaveBeenCalledWith(expect.anything(), {
      projectId: "project-a",
    });
  });
  it.each([
    { servers: [] },
    {
      servers: [
        { _id: "a", name: "x" },
        { _id: "b", name: "x" },
      ],
    },
  ])("refuses missing or ambiguous names", async ({ servers }) => {
    mocks.query.mockResolvedValue(servers);
    expect(
      (await request({ projectId: "p", selectedServers: ["x"] })).status,
    ).toBe(400);
  });
  it("does not turn an authorization failure into standalone execution", async () => {
    mocks.query.mockRejectedValue(new Error("Forbidden"));
    expect(
      (await request({ projectId: "p", selectedServers: ["x"] })).status,
    ).toBe(400);
  });
  it.each([[null], [42], [""]])("rejects invalid canonical IDs", async (id) => {
    expect((await request({ selectedServerIds: id })).status).toBe(400);
  });
});
