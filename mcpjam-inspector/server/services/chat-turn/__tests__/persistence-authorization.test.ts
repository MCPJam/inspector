import type { InternalExecutionTarget } from "../../../../shared/execution-target.js";
import { Hono } from "hono";
import { beforeEach, expect, it, vi } from "vitest";
import type { Context } from "hono";
const state = vi.hoisted(() => ({
  hosted: true,
  service: true,
  revoked: false,
  rebound: false,
  reassigned: false,
  getBearer: vi.fn(async () => "current-delegation"),
  prepare: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("../../../config.js", () => ({
  get HOSTED_MODE() {
    return state.hosted;
  },
}));
vi.mock("../../service-credential.js", () => ({
  hasServiceCredential: () => state.service,
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getBackgroundRunBearerForRequest: async (...args: unknown[]) => {
    state.prepare(...args);
    return state.getBearer;
  },
}));
vi.mock("../../../middleware/bearer-auth.js", () => ({
  bearerAuthMiddleware: async (c: Context, next: () => Promise<void>) => {
    state.revalidate();
    expect(c.get("workosApiKeyValidation")).toBeUndefined();
    expect(c.get("workosApiKeyBinding")).toBeUndefined();
    if (state.revoked) return c.json({ error: "revoked" }, 401);
    if (state.rebound) c.set("mcpjamOrganizationId", "other-org");
    if (state.reassigned) c.set("workosUserId", "other-actor");
    await next();
  },
}));
import { preparePersistenceAuthorization } from "../persistence-authorization.js";

async function prepare(
  method:
    | "authkit_jwt"
    | "workos_api_key"
    | "unverified_passthrough" = "authkit_jwt",
  executionTarget: InternalExecutionTarget = { kind: "host", hostId: "host" },
  history = true,
) {
  let authorization: Awaited<
    ReturnType<typeof preparePersistenceAuthorization>
  >;
  const app = new Hono().get("/", async (c) => {
    c.set("authMethod", method);
    c.set("workosUserId", "actor");
    c.set("mcpjamOrganizationId", "original-org");
    c.set("workosApiKeyValidation", { old: true });
    c.set("workosApiKeyBinding", { old: true });
    authorization = await preparePersistenceAuthorization(c, {
      projectId: "project",
      executionTarget,
      chatSessionId: history ? "chat" : undefined,
    });
    return c.json({ ok: true });
  });
  expect((await app.request("/")).status).toBe(200);
  return authorization;
}
beforeEach(() => {
  vi.clearAllMocks();
  state.hosted = state.service = true;
  state.revoked = state.rebound = state.reassigned = false;
});

it("captures verified background authority before execution and resolves it only for persistence", async () => {
  const authorization = await prepare();
  expect(state.prepare).toHaveBeenCalledWith(expect.anything(), "project", {
    requireFreshSessionOnUse: true, allowOriginalBearerOnMintFailure: true,
  });
  expect(state.getBearer).not.toHaveBeenCalled();
  expect(await authorization!()).toBe("Bearer current-delegation");
  expect(state.revalidate).not.toHaveBeenCalled();
});
it.each(["revoked", "rebound", "reassigned"] as const)(
  "refuses a %s original API key before using delegation",
  async (reason) => {
    const authorization = await prepare("workos_api_key");
    state[reason] = true;
    await expect(authorization!()).rejects.toMatchObject({ status: 403 });
    expect(state.revalidate).toHaveBeenCalledOnce();
    expect(state.getBearer).not.toHaveBeenCalled();
  },
);
it("revalidates the original API key and organization without changing its authority", async () => {
  const authorization = await prepare("workos_api_key");
  expect(await authorization!()).toBe("Bearer current-delegation");
  expect(state.revalidate).toHaveBeenCalledOnce();
});
it.each(["native", "unconfigured"])(
  "preserves %s installations without requiring new delegation credentials",
  async (kind) => {
    if (kind === "native") state.hosted = false;
    else state.service = false;
    expect(await prepare()).toBeUndefined();
    expect(state.prepare).not.toHaveBeenCalled();
  },
);

it("leaves Convex-verified passthrough credentials on their existing path", async () => {
  expect(await prepare("unverified_passthrough")).toBeUndefined();
  expect(state.prepare).not.toHaveBeenCalled();
});

it("uses the canonical scenario target even without a legacy scenarioId", async () => {
  expect(
    await prepare("authkit_jwt", { kind: "scenario", scenarioId: "scenario" }),
  ).toBeUndefined();
  expect(state.prepare).not.toHaveBeenCalled();
});
it("does not request delegation for a turn with no history identity", async () => {
  expect(
    await prepare("authkit_jwt", { kind: "host", hostId: "host" }, false),
  ).toBeUndefined();
  expect(state.prepare).not.toHaveBeenCalled();
});
