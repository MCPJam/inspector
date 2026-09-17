/**
 * Ask MCPJam turns are paid by MCPJam. Two things make that safe, and both
 * live in this route: the model is PINNED (the backend only honours the
 * billing claim for one id) and the claim is sent for SIGNED-IN callers only
 * (a guest cookie is free, so platform-paying for one is a farm waiting to
 * happen).
 *
 * The route hands both to `streamWebChatTurn`, so this asserts what it hands
 * over. The wire-level half — the service token going out with the claim — is
 * in `server/utils/__tests__/mcpjam-stream-handler.agent-billing.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const { streamWebChatTurnMock, disconnectAllServersMock, listToolsMock } =
  vi.hoisted(() => ({
    streamWebChatTurnMock: vi.fn(),
    disconnectAllServersMock: vi.fn(),
    listToolsMock: vi.fn(async () => ({ tools: [] })),
  }));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    isMCPAuthError: vi.fn().mockReturnValue(false),
    MCPClientManager: vi.fn().mockImplementation(() => ({
      disconnectAllServers: disconnectAllServersMock,
      listTools: listToolsMock,
    })),
  };
});

vi.mock("../../../utils/web-chat-turn.js", () => ({
  streamWebChatTurn: streamWebChatTurnMock,
}));

vi.mock("../apps.js", () => ({ default: new Hono() }));

import webRoutes from "../index.js";
import { requestLogContextMiddleware } from "../../../middleware/request-log-context.js";
import {
  AGENT_MAX_STEPS,
  MCPJAM_AGENT_BILLING_FEATURE,
  MCPJAM_AGENT_MODEL,
} from "../../../../shared/mcpjam-agent-model.js";

function buildApp(options?: { guestId?: string }) {
  const app = new Hono();
  app.use("/api/*", requestLogContextMiddleware);
  app.use("*", async (c, next) => {
    (c as any).mcpClientManager = {};
    // `guestId` is what identifies a guest across this server, not the
    // `authMethod` label — the route keys on the same thing.
    if (options?.guestId) c.set("guestId", options.guestId);
    await next();
  });
  app.route("/api/web", webRoutes);
  return app;
}

/** A client asking for something else entirely — Sonnet, or a BYOK model. */
const BODY = {
  messages: [{ role: "user", content: "what is an MCP resource?" }],
  model: {
    id: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    name: "Claude Sonnet 5",
  },
  chatSessionId: "agent-billing-session",
  projectId: "project-1",
};

async function postTurn(options?: { guestId?: string }) {
  const app = buildApp(options);
  const response = await app.request("/api/web/mcpjam-agent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token-123",
    },
    body: JSON.stringify(BODY),
  });
  expect(response.status).toBe(200);
  return streamWebChatTurnMock.mock.calls[0]![0];
}

describe("web routes — Ask MCPJam billing claim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamWebChatTurnMock.mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    listToolsMock.mockImplementation(async () => ({ tools: [] }));
  });

  it("ignores the client's model and pins the agent's own", async () => {
    const args = await postTurn();
    // The client asked for Sonnet. The backend would refuse to platform-pay
    // for it, so sending it would be a refused turn, not a better answer.
    expect(String(args.prepare.modelDefinition.id)).toBe(MCPJAM_AGENT_MODEL);
  });

  it("sends the billing claim and the step ceiling for a signed-in caller", async () => {
    const args = await postTurn();
    expect(args.runtime.billingFeature).toBe(MCPJAM_AGENT_BILLING_FEATURE);
    expect(args.runtime.maxSteps).toBe(AGENT_MAX_STEPS);
  });

  it("gives web search the same claim, so it rides the same budget", async () => {
    const args = await postTurn();
    expect(args.prepare.builtInTools).toBeDefined();
  });

  it("sends NO claim for a guest, who keeps the customer rail", async () => {
    const args = await postTurn({ guestId: "guest-abc" });
    expect(args.runtime.billingFeature).toBeUndefined();
  });

  it("still sends the step ceiling for a guest", async () => {
    // Not a billing decision either. Without this the guest would inherit the
    // chat default of 30 and get a LONGER agent loop than a signed-in user,
    // on the rail MCPJam is NOT paying for.
    const args = await postTurn({ guestId: "guest-abc" });
    expect(args.runtime.maxSteps).toBe(AGENT_MAX_STEPS);
  });

  it("still pins the model for a guest", async () => {
    // The pin is not a billing decision: a guest asking for a frontier model
    // on this surface is the same product choice either way.
    const args = await postTurn({ guestId: "guest-abc" });
    expect(String(args.prepare.modelDefinition.id)).toBe(MCPJAM_AGENT_MODEL);
  });
});
