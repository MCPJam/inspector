/**
 * The mock door's own limits, in front of the REAL bearer middleware and the
 * generic hosted limiters: 60 requests a minute per source address and 600 per
 * key. The `sk_` bucket (60 a minute, burst 10) and the per-token brake on
 * OAuth tokens (120 a minute) must not cut a caller off earlier.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("../../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config.js")>()),
  HOSTED_MODE: true,
}));

const { validateApiKeyMock, lookupBindingMock } = vi.hoisted(() => ({
  validateApiKeyMock: vi.fn(),
  lookupBindingMock: vi.fn(),
}));
vi.mock("../../../services/workos-client.js", () => ({
  getWorkOSClient: () => ({ apiKeys: { createValidation: validateApiKeyMock } }),
}));
vi.mock("../../../services/identity.js", () => ({
  resolveUserByExternalId: vi.fn(async (id: string) => ({ _id: `user-${id}`, externalId: id })),
}));
vi.mock("../../../services/workos-key-bindings.js", () => ({
  lookupWorkosKeyBinding: lookupBindingMock,
}));
vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: vi.fn(async () => ({ valid: false, reason: "not_guest" })),
}));

import { resetWorkOSRateLimitForTests } from "../../../middleware/bearer-auth.js";
import {
  passthroughRateLimitMiddleware,
  resetPassthroughRateLimitForTests,
} from "../../../middleware/passthrough-rate-limit.js";
import { mockDoorMiddleware, resetMockDoorForTests } from "../mock-mcp.js";
import { MOCK_KEY_LIMIT_PER_MINUTE, MOCK_SOURCE_LIMIT_PER_MINUTE } from "../../../services/mock/window-limiter.js";

// The order the app mounts them in: the door's chain, then the generic brake.
const app = new Hono();
app.use("/api/web/mock-mcp/*", ...mockDoorMiddleware);
app.use("*", passthroughRateLimitMiddleware);
app.get("/api/web/mock-mcp/:id", (c) => c.text("served"));

/** One address per `perAddress` requests, so only the counter under test can refuse. */
function caller(token: string, perAddress: number) {
  let sent = 0;
  return async () => {
    const address = `203.0.113.${Math.floor(sent / perAddress) % 250}`;
    sent += 1;
    return app.request("/api/web/mock-mcp/mock1", {
      headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": address },
    });
  };
}

beforeEach(() => {
  resetMockDoorForTests();
  resetWorkOSRateLimitForTests();
  resetPassthroughRateLimitForTests();
  validateApiKeyMock.mockReset().mockResolvedValue({
    apiKey: { id: "key_1", owner: { id: "ann" } },
  });
  lookupBindingMock.mockReset().mockResolvedValue({ mcpjamOrganizationId: "org1" });
});

describe("the door's limits over HTTP", () => {
  it("lets a key make 600 requests a minute, not the sk_ bucket's burst of 10", async () => {
    const call = caller("sk_ann", MOCK_SOURCE_LIMIT_PER_MINUTE);
    const statuses: number[] = [];
    for (let i = 0; i <= MOCK_KEY_LIMIT_PER_MINUTE; i += 1) statuses.push((await call()).status);
    expect(statuses.slice(0, MOCK_KEY_LIMIT_PER_MINUTE).every((s) => s === 200)).toBe(true);
    expect(statuses[MOCK_KEY_LIMIT_PER_MINUTE]).toBe(429);
  });

  it("lets an OAuth token make 600 requests a minute, not the brake's 120", async () => {
    // Not a verified AuthKit token, so the middleware labels it a passthrough: the metered kind.
    const call = caller("eyJhbGciOiJub25lIn0.e30.sig", MOCK_SOURCE_LIMIT_PER_MINUTE);
    const statuses: number[] = [];
    for (let i = 0; i <= MOCK_KEY_LIMIT_PER_MINUTE; i += 1) statuses.push((await call()).status);
    expect(statuses.slice(0, MOCK_KEY_LIMIT_PER_MINUTE).every((s) => s === 200)).toBe(true);
    expect(statuses[MOCK_KEY_LIMIT_PER_MINUTE]).toBe(429);
  });

  it("answers over the key's line in the route's own words", async () => {
    const call = caller("sk_ann", MOCK_SOURCE_LIMIT_PER_MINUTE);
    let last!: Response;
    for (let i = 0; i <= MOCK_KEY_LIMIT_PER_MINUTE; i += 1) last = await call();
    const body = (await last.json()) as { jsonrpc: string; error: { data: { mockCode: string } } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.data.mockCode).toBe("mock_rate_limited");
  });

  it("stops one source address at 60 a minute, before any key is checked", async () => {
    const call = caller("sk_ann", 10_000);
    const statuses: number[] = [];
    for (let i = 0; i <= MOCK_SOURCE_LIMIT_PER_MINUTE; i += 1) statuses.push((await call()).status);
    expect(statuses.slice(0, MOCK_SOURCE_LIMIT_PER_MINUTE).every((s) => s === 200)).toBe(true);
    expect(statuses[MOCK_SOURCE_LIMIT_PER_MINUTE]).toBe(429);
    // The refusal came before the key was asked about.
    expect(validateApiKeyMock).toHaveBeenCalledTimes(MOCK_SOURCE_LIMIT_PER_MINUTE);
  });
});
