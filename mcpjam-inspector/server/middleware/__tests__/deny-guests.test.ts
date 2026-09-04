import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { denyGuests } from "../deny-guests.js";

/**
 * The request-level guest boundary for `/web` mounts whose every endpoint
 * resolves a signed-in-only Convex function.
 *
 * Why this exists rather than leaving it to the backend: `bearerAuthMiddleware`
 * admits a validated guest JWT on purpose (most `/web` routes serve guests), and
 * `getConvexBearerForRequest` forwards it verbatim — so without this middleware
 * a guest's Cloud Skills request travelled two hops to be refused in the
 * backend's error tracker, where it read as a server fault. Sentry CONVEX-19R.
 */
function appWith(seed?: (c: { set: (k: string, v: unknown) => void }) => void) {
  const app = new Hono();
  if (seed) {
    app.use("*", async (c, next) => {
      seed(c);
      return next();
    });
  }
  app.use("*", denyGuests("Cloud Skills"));
  app.post("/probe", (c) => c.json({ reached: true }));
  return app;
}

async function post(app: Hono) {
  return app.request("http://localhost/probe", { method: "POST" });
}

describe("denyGuests", () => {
  it("refuses a guest with 403 FEATURE_NOT_SUPPORTED and never reaches the handler", async () => {
    const res = await post(appWith((c) => c.set("guestId", "guest-1")));

    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error?: { code?: string; message?: string };
      code?: string;
      message?: string;
    };
    // The envelope shape is `webError`'s, so read the code from either nesting
    // rather than pinning a shape this middleware does not own.
    const code = body.error?.code ?? body.code;
    const message = body.error?.message ?? body.message;
    expect(code).toBe("FEATURE_NOT_SUPPORTED");
    expect(message).toContain("Cloud Skills");
    expect(message).toContain("signed-in account");
  });

  it("lets a signed-in caller through", async () => {
    const res = await post(appWith((c) => c.set("authMethod", "workos_jwt")));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: true });
  });

  it("lets a caller with no established identity through", async () => {
    // Deliberate: this middleware's job is guests specifically. Whether an
    // anonymous request may proceed is `bearerAuthMiddleware`'s call, made
    // before this runs — duplicating it here would put the same decision in two
    // places that can disagree.
    const res = await post(appWith());

    expect(res.status).toBe(200);
  });

  it("keys on guestId, not on the authMethod label", async () => {
    // The label is newer than the guest branch. A guest whose `authMethod` was
    // never labelled is still a guest.
    const res = await post(appWith((c) => c.set("guestId", "guest-2")));

    expect(res.status).toBe(403);
  });
});
