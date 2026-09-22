/**
 * `GET /built-in-tools/:id/definitions` — the `browser_*` tools as the model is
 * shown them, for the Tools pane and the Raw preview.
 *
 * The property worth pinning is that the route DERIVES its answer from the same
 * builder the model's turn uses. A hand-written copy would pass a shape test
 * forever while drifting from the schemas the model actually reads, and the
 * schemas are where the coordinate space and the ref rules live.
 *
 * Mounted with real bearer and route verification middleware, with external
 * token verification stubbed. The v1 guest boundary is applied before the
 * route too, so a payload-only test cannot miss an allowlist rejection.
 */
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Exercise both real authentication middleware layers. Only the external
// token verifiers are stubbed; the catalog must not need Convex or a browser.
vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: async (token: string) =>
    token === "valid-guest"
      ? { valid: true, guestId: "guest-1" }
      : { valid: false },
}));
vi.mock("../../../services/authkit-jwt.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../services/authkit-jwt.js")
  >()),
  verifyAuthKitToken: async (token: string) => {
    if (token === "valid-member") return { sub: "member-1" };
    throw new Error("Invalid token");
  },
}));
import { bearerAuthMiddleware } from "../../../middleware/bearer-auth.js";

import builtInTools from "../built-in-tools.js";
import { v1OnError } from "../envelope.js";
import { isGuestAllowedV1Request } from "../guest-allowed-paths.js";
import { BROWSER_TOOL_NAMES } from "../../../../shared/client-fulfilled-tools.js";

/**
 * What the definitions route describes: the whole catalog.
 *
 * `describeBrowserTools` builds with no engine that re-advertises and no page
 * snapshot, which is the shape that keeps both by-name WebMCP verbs — and they
 * go together: the invoke verb takes a name and an untyped input, and the list
 * verb is where the model learns the name and the shape it expects. An engine
 * that grows its set mid-turn has the pair stripped at the engine boundary,
 * not here; this pane describes the catalog a turn starts from.
 */
const FIRST_CLASS_TOOL_NAMES = [...BROWSER_TOOL_NAMES];

type Definition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

function request(
  path: string,
  token: string | null = "valid-member",
  method = "GET",
) {
  const app = new Hono();
  // `v1OnError` too: the router raises `WebRouteError` and the parent maps it
  // to the wire, exactly as `routes/v1/index.ts` does. Without it a test would
  // be asserting statuses this route does not actually produce in production.
  app.onError(v1OnError);
  app.use("/api/v1/*", bearerAuthMiddleware);
  app.use("/api/v1/*", async (c, next) => {
    if (c.get("guestId") && !isGuestAllowedV1Request(c.req.method, c.req.path))
      return c.json({ error: "guest denied" }, 401);
    return next();
  });
  app.route("/api/v1", builtInTools);
  return app.request(`http://local${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function definitions(path: string): Promise<Definition[]> {
  const res = await request(path);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Definition[] }).items;
}

describe("GET /built-in-tools/:builtInToolId/definitions", () => {
  it("returns every browser tool the model is given, with its schema", async () => {
    const items = await definitions(
      "/api/v1/built-in-tools/browser/definitions",
    );
    // The whole set the model is GIVEN, not a curated subset: a pane listing
    // five of six tools would be a quietly wrong account of what it can do.
    expect(items.map((item) => item.name).sort()).toEqual(
      [...FIRST_CLASS_TOOL_NAMES].sort(),
    );
    for (const item of items) {
      expect(item.description, `${item.name} needs a description`).toBeTruthy();
      expect(item.inputSchema, `${item.name} needs a schema`).toMatchObject({
        type: "object",
      });
    }
  });

  it("says whose browser this is, per engine", async () => {
    // Not decoration: a model — and a person reading the pane — reasons
    // differently about clicking something in a disposable cloud box than in
    // their own signed-in Chromium.
    const hosted = await definitions(
      "/api/v1/built-in-tools/browser/definitions",
    );
    const local = await definitions(
      "/api/v1/built-in-tools/browser/definitions?engine=local",
    );
    const joined = (items: Definition[]) =>
      items.map((item) => item.description ?? "").join("\n");

    expect(joined(local)).toContain("this machine");
    expect(joined(local)).not.toBe(joined(hosted));
  });

  it("treats an unknown engine as hosted rather than failing", async () => {
    const items = await definitions(
      "/api/v1/built-in-tools/browser/definitions?engine=banana",
    );
    expect(items).toHaveLength(FIRST_CLASS_TOOL_NAMES.length);
  });

  it("404s an unknown built-in tool instead of answering an empty page", async () => {
    // A misspelled id must not read as "this tool has no definitions".
    const res = await request("/api/v1/built-in-tools/browsr/definitions");
    expect(res.status).toBe(404);
  });

  it("answers without driving a browser", async () => {
    // The definitions are built from code. If answering ever needed a live
    // session, rendering a tool list would be provisioning machines — the
    // builder is handed an ensure function that throws, so an answer at all is
    // the proof nothing resolved one.
    const items = await definitions(
      "/api/v1/built-in-tools/browser/definitions",
    );
    expect(items.length).toBeGreaterThan(0);
  });
});

describe("guest access to built-in tool definitions", () => {
  it.each(["local", "hosted"])(
    "allows validated guests to read static %s schemas",
    async (engine) => {
      const response = await request(
        `/api/v1/built-in-tools/browser/definitions?engine=${engine}`,
        "valid-guest",
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { items: Definition[] };
      expect(body.items.map((item) => item.name).sort()).toEqual(
        [...FIRST_CLASS_TOOL_NAMES].sort(),
      );
    },
  );
  it.each([null, "invalid-token"])(
    "rejects unverified credentials: %s",
    async (token) => {
      expect(
        (await request("/api/v1/built-in-tools/browser/definitions", token))
          .status,
      ).toBe(401);
    },
  );
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "keeps %s guest-denied",
    async (method) => {
      expect(
        (
          await request(
            "/api/v1/built-in-tools/browser/definitions",
            "valid-guest",
            method,
          )
        ).status,
      ).toBe(401);
    },
  );
  it.each([
    "/built-in-tools/bash/definitions",
    "/built-in-tools/browser/execute",
    "/built-in-tools/browser/definitions/extra",
  ])("does not widen guest access to %s", (path) => {
    expect(isGuestAllowedV1Request("GET", `/api/v1${path}`)).toBe(false);
  });
});
