/**
 * Tests for the Convex auth-header exchange used by every Inspector → Convex
 * `/web/*` call. The security-critical invariant: for WorkOS API key requests
 * the delegated identity headers carry the WorkOS user id (Convex
 * `externalId`) — NOT the Convex user `_id` — plus the bound org id. Sending
 * the Convex id would be looked up by the backend resolver as an `externalId`
 * and 404 as UNKNOWN_DELEGATED_USER.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Context } from "hono";
import { buildConvexAuthHeaders, callerContextFromHono } from "../auth.js";

const SERVICE_TOKEN = "svc-token-test";
const ORIGINAL_ENV = process.env.INSPECTOR_SERVICE_TOKEN;

/** Minimal Context stub exposing only the `c.get(key)` the SUT reads. */
function fakeContext(vars: Record<string, unknown>): Context {
  return { get: (key: string) => vars[key] } as unknown as Context;
}

beforeEach(() => {
  process.env.INSPECTOR_SERVICE_TOKEN = SERVICE_TOKEN;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.INSPECTOR_SERVICE_TOKEN;
  else process.env.INSPECTOR_SERVICE_TOKEN = ORIGINAL_ENV;
});

describe("buildConvexAuthHeaders — WorkOS API key exchange", () => {
  it("sends acting-as = WorkOS user id (not the Convex user id) and acting-in-org", () => {
    const c = fakeContext({
      authMethod: "workos_api_key",
      workosUserId: "workos|user_42",
      mcpjamUserId: "mcpjam_user_42", // Convex id — must NOT be the acting-as
      mcpjamOrganizationId: "org_42",
    });

    const headers = buildConvexAuthHeaders(callerContextFromHono(c), "sk_should_not_be_forwarded");

    expect(headers["Authorization"]).toBe(`Bearer ${SERVICE_TOKEN}`);
    expect(headers["x-mcpjam-acting-as"]).toBe("workos|user_42");
    expect(headers["x-mcpjam-acting-as"]).not.toBe("mcpjam_user_42");
    expect(headers["x-mcpjam-acting-in-org"]).toBe("org_42");
    // The raw sk_ value is never forwarded to Convex.
    expect(JSON.stringify(headers)).not.toContain("sk_should_not_be_forwarded");
  });

  it("throws when the WorkOS user id is missing", () => {
    const c = fakeContext({
      authMethod: "workos_api_key",
      mcpjamOrganizationId: "org_42",
    });
    expect(() => buildConvexAuthHeaders(callerContextFromHono(c), "sk_x")).toThrow(/workosUserId/);
  });

  it("throws when the bound org id is missing", () => {
    const c = fakeContext({
      authMethod: "workos_api_key",
      workosUserId: "workos|user_42",
    });
    expect(() => buildConvexAuthHeaders(callerContextFromHono(c), "sk_x")).toThrow(
      /mcpjamOrganizationId/,
    );
  });
});

describe("buildConvexAuthHeaders — non-API-key path", () => {
  it("forwards the original bearer verbatim and adds no delegation headers", () => {
    const c = fakeContext({}); // no authMethod → session/guest JWT
    const headers = buildConvexAuthHeaders(callerContextFromHono(c), "eyJ-session-jwt");

    expect(headers["Authorization"]).toBe("Bearer eyJ-session-jwt");
    expect(headers["x-mcpjam-acting-as"]).toBeUndefined();
    expect(headers["x-mcpjam-acting-in-org"]).toBeUndefined();
  });
});
