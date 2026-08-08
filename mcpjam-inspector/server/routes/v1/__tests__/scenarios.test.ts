import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The v1 scenario surface (`server/routes/v1/scenarios.ts`).
 *
 * What these pin:
 *
 *   1. The ENVIRONMENT PREFLIGHT. Convex's publish mutation takes an
 *      `environmentId` alone and checks access to THAT environment's project,
 *      never the project in this route's path. Without the preflight,
 *      `PUT /projects/A/environments/{env-in-B}/scenario` publishes in B under
 *      a URL that says A.
 *   2. Idempotency, in both directions: re-publishing returns the existing
 *      scenario (`created: false`, 200 not 201), and unpublishing an
 *      environment with no scenario reports `deleted: false` rather than 404.
 *   3. The beta gate's `FEATURE_UNAVAILABLE` reaching the caller as a 403 with
 *      a real message — the default `FORBIDDEN` mapping would make it a 404,
 *      telling a flagged-off customer their project does not exist.
 */

const { queryMock, mutationMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
    mutation(...args: unknown[]) {
      return mutationMock(...args);
    }
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-jwt",
}));

import scenarios from "../scenarios.js";
import { v1OnError } from "../envelope.js";

const PROJECT = "proj_a";
const ENV = "env_1";

function makeApp() {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", scenarios);
  return app;
}

function call(method: "PUT" | "DELETE") {
  return makeApp().request(
    `/api/v1/projects/${PROJECT}/environments/${ENV}/scenario`,
    { method }
  );
}

const published = (overrides: Record<string, unknown> = {}) => ({
  chatboxId: "cb_1",
  environmentId: ENV,
  name: "Checkout",
  mode: "anyone_with_link",
  accessVersion: 1,
  link: "https://app.mcpjam.com/s/checkout?t=abc",
  created: true,
  ...overrides,
});

/** A ConvexError as the client surfaces it: `.data` carries the structure. */
function convexError(code: string, message: string) {
  return Object.assign(new Error(message), { data: { code, message } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://convex.test");
  queryMock.mockResolvedValue({ environmentId: ENV, projectId: PROJECT });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("PUT .../scenario", () => {
  it("publishes and returns 201 with the share link", async () => {
    mutationMock.mockResolvedValue(published());

    const res = await call("PUT");
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: "cb_1",
      environmentId: ENV,
      mode: "anyone_with_link",
      created: true,
    });
    expect(body.link).toContain("https://");
    // The internal table name never reaches the wire.
    expect(body).not.toHaveProperty("chatboxId");
  });

  it("returns 200 and created:false when the environment was ALREADY published", async () => {
    // Idempotent by design — one scenario per environment. A caller should be
    // able to run `publish` twice without minting a second or getting an error.
    mutationMock.mockResolvedValue(published({ created: false }));

    const res = await call("PUT");
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      created: false,
    });
  });

  it("404s an environment in ANOTHER project, without calling the mutation", async () => {
    // Convex scopes `getEnvironment` by projectId, so a cross-project id reads
    // as null — indistinguishable from missing, which is the point.
    queryMock.mockResolvedValue(null);

    expect((await call("PUT")).status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("404s — and does not publish — when the preflight THROWS", async () => {
    queryMock.mockRejectedValue(new Error("Not a member of this project"));
    expect((await call("PUT")).status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("surfaces the beta gate as 403 with its real message, NOT 404", async () => {
    // The whole reason `FEATURE_UNAVAILABLE` is a distinct code: the generic
    // FORBIDDEN mapping collapses to 404 so a non-member cannot probe for
    // existence, which here would tell a paying customer their own project is
    // gone rather than that a beta is not on for them.
    mutationMock.mockRejectedValue(
      convexError(
        "FEATURE_UNAVAILABLE",
        "User testing is not currently available for your organization."
      )
    );

    const res = await call("PUT");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; message?: string };
    // FORBIDDEN rather than FEATURE_NOT_SUPPORTED: the canonical contract maps
    // the latter to 422 (unprocessable content), which describes a malformed
    // request. This request is fine; the server refuses to authorize it.
    expect(body.code).toBe("FORBIDDEN");
    expect(body.message).toBe(
      "User testing is not currently available for your organization."
    );
  });

  it("surfaces the admin gate as 403", async () => {
    mutationMock.mockRejectedValue(
      convexError(
        "FORBIDDEN",
        "Publishing an environment chatbox requires project admin (shared execution config)."
      )
    );
    expect((await call("PUT")).status).toBe(403);
  });

  it("surfaces an archived environment as 409", async () => {
    mutationMock.mockRejectedValue(
      convexError("CONFLICT", 'Environment "Checkout" is archived.')
    );
    expect((await call("PUT")).status).toBe(409);
  });
});

describe("DELETE .../scenario", () => {
  it("unpublishes and reports the removed id", async () => {
    mutationMock.mockResolvedValue({ deleted: true, chatboxId: "cb_1" });

    const res = await call("DELETE");
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      environmentId: ENV,
      deleted: true,
      id: "cb_1",
    });
  });

  it("reports deleted:false — not 404 — when there was no scenario", async () => {
    // Cleanup should not have to know whether the thing it is removing exists.
    mutationMock.mockResolvedValue({ deleted: false });

    const res = await call("DELETE");
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      deleted: false,
    });
  });

  it("enforces the same cross-project preflight as publish", async () => {
    queryMock.mockResolvedValue(null);
    expect((await call("DELETE")).status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });
});
