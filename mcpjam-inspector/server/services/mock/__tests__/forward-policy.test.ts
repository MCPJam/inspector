import { beforeEach, describe, expect, it } from "vitest";
import { checkForwardWithBackend } from "../forward-policy.js";

const input = {
  mockId: "mock1",
  version: 1,
  caller: { authMethod: "authkit_jwt", workosUserId: "ann" },
  bearerToken: "token",
};

const answering = (status: number, body: unknown = {}) => ({
  fetch: (async () => new Response(JSON.stringify(body), { status })) as typeof fetch,
});

describe("checkForwardWithBackend", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://backend.test";
  });

  it.each([401, 403, 404])("labels a %i as no access, not as an unreadable policy", async (status) => {
    expect(await checkForwardWithBackend(input, answering(status))).toEqual({
      allowed: false,
      reason: "no_access",
    });
  });

  it("reads a block by policy and an allow", async () => {
    expect(await checkForwardWithBackend(input, answering(200, { allowed: false, reason: "blocked_by_policy" }))).toEqual({
      allowed: false,
      reason: "blocked_by_policy",
    });
    expect(await checkForwardWithBackend(input, answering(200, { allowed: true }))).toEqual({ allowed: true });
  });

  it("throws when the policy cannot be read", async () => {
    await expect(checkForwardWithBackend(input, answering(500))).rejects.toThrow("answered 500");
  });
});
