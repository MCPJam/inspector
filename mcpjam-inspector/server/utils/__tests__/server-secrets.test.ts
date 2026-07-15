import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateXaaIssuerPolicy,
  fetchRuntimeServerSecrets,
} from "../server-secrets.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;

describe("fetchRuntimeServerSecrets", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  });

  afterEach(() => {
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    vi.unstubAllGlobals();
  });

  it("preserves Convex error codes on failed reveals", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ code: "FORBIDDEN", message: "No access" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await expect(
      fetchRuntimeServerSecrets({
        bearerToken: "bearer-token",
        projectId: "project-1",
        serverId: "server-1",
      })
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "No access",
    });
  });
});

describe("evaluateXaaIssuerPolicy", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  });

  afterEach(() => {
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    vi.unstubAllGlobals();
  });

  it("clamps granted scopes to the requested set (downscope-only invariant)", async () => {
    // A malformed/compromised evaluator response must never broaden the
    // mint: scopes outside the request are dropped client-side too.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            success: true,
            decision: {
              outcome: "granted",
              grantedScopes: ["read:tools", "admin:everything"],
              connectionId: "conn-1",
              assignmentId: "assign-1",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    const decision = await evaluateXaaIssuerPolicy({
      bearerToken: "bearer-token",
      organizationId: "org-1",
      testIdentityId: "person-1",
      resourceAppId: "app-1",
      claims: { subject: "alice-123", email: "alice@example.com" },
      audience: "https://as.example.com",
      requestedScopes: ["read:tools"],
      policyMode: "managed",
    });

    expect(decision).toEqual({
      outcome: "granted",
      grantedScopes: ["read:tools"],
      connectionId: "conn-1",
      assignmentId: "assign-1",
    });
  });
});
