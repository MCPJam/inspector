import { beforeEach, expect, it, vi } from "vitest";
import { Hono, type Context } from "hono";
import { ConvexError } from "convex/values";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  action: vi.fn(),
  setAuth: vi.fn(),
  bearer: vi.fn(),
  auth: vi.fn(),
  ip: "test-ip",
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(function () {
    return {
      query: mocks.query,
      mutation: mocks.mutation,
      action: mocks.action,
      setAuth: mocks.setAuth,
    };
  }),
}));
vi.mock("../../../middleware/bearer-auth.js", () => ({
  bearerAuthMiddleware: async (c: Context, next: () => Promise<void>) => {
    mocks.auth();
    c.set("authMethod", c.req.header("x-test-method") ?? "authkit_jwt");
    return next();
  },
}));
vi.mock("../../../middleware/passthrough-rate-limit.js", () => ({
  passthroughRateLimitMiddleware: (_c: Context, next: () => Promise<void>) =>
    next(),
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: mocks.bearer,
}));
vi.mock("../../../utils/client-ip.js", () => ({
  getAttestedClientIp: () => mocks.ip,
}));
vi.mock("../../../config.js", () => ({ HOSTED_MODE: true }));
import accountDeletion from "../account-deletion.js";
const receipt = {
  requestId: "request_a",
  scope: { type: "account", id: "user_a" },
  state: "accepted",
  acceptedAt: 1,
  dueAt: 2,
  canCancel: false,
  journalConfirmedAt: null,
  liveDataDeletedAt: null,
  closedAt: null,
};
const recovery = {
  receiptSecret: "a".repeat(64),
  idempotencyKey: "original-key",
};
function app() {
  return new Hono().route("/account", accountDeletion);
}
function post(path: string, body: unknown = recovery, method?: string) {
  return app().request(`/account/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(method ? { "x-test-method": method } : {}),
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONVEX_URL = "https://synthetic.convex.cloud";
  mocks.ip = crypto.randomUUID();
  mocks.bearer.mockResolvedValue("human-token");
  mocks.action.mockResolvedValue(receipt);
  mocks.mutation.mockResolvedValue(receipt);
});
it("public recovery invokes uncached action with no auth, user lookup or mutation", async () => {
  const result = await post("receipt");
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual(receipt);
  expect(mocks.action.mock.calls[0][1]).toEqual(recovery);
  expect(mocks.auth).not.toHaveBeenCalled();
  expect(mocks.setAuth).not.toHaveBeenCalled();
  expect(mocks.bearer).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.mutation).not.toHaveBeenCalled();
});
it("expired/revoked/unknown receipt stays opaque without accepting a replacement", async () => {
  mocks.action.mockResolvedValue(null);
  expect(await (await post("receipt")).json()).toBeNull();
  expect(mocks.mutation).not.toHaveBeenCalled();
});
it.each([
  { ...recovery, extra: "secret" },
  { ...recovery, receiptSecret: "bad" },
  {},
])(
  "malformed bearer inputs return null without provider calls",
  async (body) => {
    expect(await (await post("receipt", body)).json()).toBeNull();
    expect(mocks.action).not.toHaveBeenCalled();
  },
);
it("acceptance preserves exact key/checkpoint and returns 202 with no completion", async () => {
  const body = { ...recovery, ownershipCheckpointSha256: "c".repeat(64) };
  const result = await post("request", body);
  expect(result.status).toBe(202);
  expect(mocks.mutation.mock.calls[0][1]).toEqual(body);
  expect(mocks.setAuth).toHaveBeenCalledWith("human-token");
  expect(await result.json()).toEqual(receipt);
});
it.each(["workos_api_key", "guest_jwt", "slack_service"])(
  "refuses %s without minting delegation or intake",
  async (method) => {
    expect(
      (
        await post(
          "request",
          { ...recovery, ownershipCheckpointSha256: "c".repeat(64) },
          method,
        )
      ).status,
    ).toBe(403);
    expect(mocks.bearer).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
  },
);
it("capability disabled has no mutation and inspection retains exact blockers", async () => {
  mocks.query.mockResolvedValueOnce({
    available: false,
    protocolVersion: 1,
    scopeTypes: ["account"],
    canCancel: false,
  });
  expect(
    await (await app().request("/account/capabilities")).json(),
  ).toMatchObject({ available: false });
  const inspection = {
    ready: false,
    identityCoverageReady: true,
    checkpointSha256: "c".repeat(64),
    obligations: [{ code: "transfer_ownership", organizationId: "org_b" }],
  };
  mocks.query.mockResolvedValueOnce(inspection);
  expect(await (await app().request("/account/inspect")).json()).toEqual(
    inspection,
  );
  expect(mocks.mutation).not.toHaveBeenCalled();
});
it("sanitizes secret-bearing rejection and response validation diagnostics", async () => {
  mocks.mutation.mockRejectedValueOnce(
    new ConvexError({
      code: "ACCOUNT_OWNERSHIP_CHANGED",
      receiptSecret: recovery.receiptSecret,
    }),
  );
  const result = await post("request", {
    ...recovery,
    ownershipCheckpointSha256: "c".repeat(64),
  });
  expect(result.status).toBe(409);
  expect(await result.text()).not.toContain(recovery.receiptSecret);
  mocks.action.mockRejectedValueOnce(new Error(recovery.receiptSecret));
  expect(await (await post("receipt")).text()).not.toContain(
    recovery.receiptSecret,
  );
});
it("rejects oversized bodies before reading account state", async () => {
  expect((await post("request", { text: "x".repeat(3000) })).status).toBe(413);
  expect(mocks.mutation).not.toHaveBeenCalled();
  expect(mocks.action).not.toHaveBeenCalled();
});
it("bounds public receipt reads per attested address before action calls", async () => {
  for (let index = 0; index < 30; index++)
    expect((await post("receipt")).status).toBe(200);
  const denied = await post("receipt");
  expect(denied.status).toBe(429);
  expect(mocks.action).toHaveBeenCalledTimes(30);
});
