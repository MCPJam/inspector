/**
 * The agent-registration (auth.md) branch of `bearerAuthMiddleware`: a verified
 * AuthKit token whose `sub` is an agent registration acts as the user who
 * approved it, inside the organization they chose, like an org-bound `sk_` key.
 *
 * The classifier is mocked here; it is covered in
 * `services/__tests__/authkit-jwt-gateway.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  classifyAuthKitBearerMock,
  resolveUserMock,
  resolveOrganizationMock,
  loggerMock,
} = vi.hoisted(() => ({
  classifyAuthKitBearerMock: vi.fn(),
  resolveUserMock: vi.fn(),
  resolveOrganizationMock: vi.fn(),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../services/authkit-jwt.js", () => ({
  classifyAuthKitBearer: classifyAuthKitBearerMock,
}));
vi.mock("../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: vi.fn(async () => ({ valid: false })),
}));
vi.mock("../../services/identity.js", () => ({
  resolveUserByExternalId: resolveUserMock,
}));
vi.mock("../../services/slack-backend.js", () => ({
  resolveOrganizationByWorkosId: resolveOrganizationMock,
}));
vi.mock("../../utils/logger.js", () => ({ logger: loggerMock }));

import {
  bearerAuthMiddleware,
  resetWorkOSRateLimitForTests,
} from "../bearer-auth.js";
import { principalKey } from "../../utils/request-principal.js";

const REGISTRATION = "agent_reg_01TEST";
const APPROVER = "user_01APPROVER";
const WORKOS_ORG = "org_01WORKOS";

function agentVerdict(
  overrides: { userId?: string | null; orgId?: string | null; registrationId?: string } = {},
) {
  const registrationId = overrides.registrationId ?? REGISTRATION;
  const userId = overrides.userId === null ? undefined : overrides.userId ?? APPROVER;
  const orgId = overrides.orgId === null ? undefined : overrides.orgId ?? WORKOS_ORG;
  return {
    kind: "verified",
    sub: registrationId,
    ...(orgId ? { orgId } : {}),
    agent: { registrationId, ...(userId ? { userId } : {}) },
  };
}

function request() {
  const app = new Hono();
  app.use("*", bearerAuthMiddleware);
  app.get("/test", (c) =>
    c.json({
      authMethod: c.get("authMethod") ?? null,
      workosUserId: c.get("workosUserId") ?? null,
      workosAgentRegistrationId: c.get("workosAgentRegistrationId") ?? null,
      mcpjamUserId: c.get("mcpjamUserId") ?? null,
      mcpjamOrganizationId: c.get("mcpjamOrganizationId") ?? null,
      // Durable agent turns and eval jobs store this and re-check it as an
      // API-key binding on every step, so an agent must never set it.
      workosApiKeyId: c.get("workosApiKeyId") ?? null,
      principal: principalKey(c),
    }),
  );
  return app.request("/test", {
    headers: { Authorization: "Bearer eyJ.agent.token" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetWorkOSRateLimitForTests();
  classifyAuthKitBearerMock.mockResolvedValue(agentVerdict());
  resolveUserMock.mockResolvedValue({ _id: "mcpjam_user_1" });
  resolveOrganizationMock.mockResolvedValue({
    organizationId: "mcpjam_org_1",
    name: "Acme",
  });
});

describe("bearerAuthMiddleware: agent-registration tokens", () => {
  it("acts as the approving user inside the chosen organization", async () => {
    const res = await request();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      authMethod: "workos_agent",
      workosUserId: APPROVER,
      workosAgentRegistrationId: REGISTRATION,
      mcpjamUserId: "mcpjam_user_1",
      mcpjamOrganizationId: "mcpjam_org_1",
      workosApiKeyId: null,
      principal: `agent:${REGISTRATION}`,
    });
    expect(resolveUserMock).toHaveBeenCalledWith(APPROVER);
    expect(resolveOrganizationMock).toHaveBeenCalledWith(WORKOS_ORG);
    expect(loggerMock.info).toHaveBeenCalledWith(
      "WorkOS agent request",
      expect.objectContaining({
        event: "auth.workos_agent",
        workos_agent_registration_id: REGISTRATION,
        mcpjam_user_id: "mcpjam_user_1",
        mcpjam_organization_id: "mcpjam_org_1",
      }),
    );
  });

  it.each([
    ["AGENT_NOT_CLAIMED", () => classifyAuthKitBearerMock.mockResolvedValue(agentVerdict({ userId: null }))],
    ["AGENT_ORG_MISSING", () => classifyAuthKitBearerMock.mockResolvedValue(agentVerdict({ orgId: null }))],
    ["AGENT_USER_UNKNOWN", () => resolveUserMock.mockResolvedValue(null)],
    ["AGENT_ORG_UNLINKED", () => resolveOrganizationMock.mockResolvedValue(null)],
  ])("refuses with 401 %s and never falls back to the user path", async (reason, arrange) => {
    arrange();
    const res = await request();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ code: "UNAUTHORIZED", details: { reason } });
    expect(body.message).toEqual(expect.any(String));
  });

  it("answers 500 when a lookup fails, and reports it", async () => {
    resolveOrganizationMock.mockRejectedValue(new Error("backend down"));
    const res = await request();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(loggerMock.error).toHaveBeenCalledWith(
      "Failed to resolve the caller of a WorkOS agent token",
      expect.any(Error),
      { workos_agent_registration_id: REGISTRATION },
    );
  });

  it("gives each agent its own budget, like an API key", async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await request()).status).toBe(200);
    }
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(resolveUserMock).toHaveBeenCalledTimes(10);

    classifyAuthKitBearerMock.mockResolvedValue(
      agentVerdict({ registrationId: "agent_reg_01OTHER" }),
    );
    expect((await request()).status).toBe(200);
  });
});
