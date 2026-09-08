/**
 * `GET /built-in-tools/:id/definitions` — the `browser_*` tools as the model is
 * shown them, for the Tools pane and the Raw preview.
 *
 * The property worth pinning is that the route DERIVES its answer from the same
 * builder the model's turn uses. A hand-written copy would pass a shape test
 * forever while drifting from the schemas the model actually reads, and the
 * schemas are where the coordinate space and the ref rules live.
 *
 * Mounted DIRECTLY rather than through `routes/v1/index.ts`. The shared bearer
 * gate and the guest boundary are properties of that router, covered where they
 * live (`require-verified-auth.test.ts` and the guest-allowlist suite below),
 * and pulling the whole v1 tree in here would drag the harness adapters — and
 * their native dependencies — into a suite about a static catalog.
 */
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// This router mounts `requireVerifiedAuth` because it never calls Convex, so
// nothing downstream would re-check the bearer. Its own branches are covered in
// `server/middleware/__tests__/require-verified-auth.test.ts`; here it is
// stubbed to admit, so these tests are about the payload.
vi.mock("../../../middleware/require-verified-auth.js", () => ({
  requireVerifiedAuth: () => (_c: unknown, next: () => unknown) => next(),
}));

import builtInTools from "../built-in-tools.js";
import { v1OnError } from "../envelope.js";
import { isGuestAllowedV1Request } from "../guest-allowed-paths.js";
import { BROWSER_TOOL_NAMES } from "../../../../shared/client-fulfilled-tools.js";

type Definition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

function request(path: string) {
  const app = new Hono();
  // `v1OnError` too: the router raises `WebRouteError` and the parent maps it
  // to the wire, exactly as `routes/v1/index.ts` does. Without it a test would
  // be asserting statuses this route does not actually produce in production.
  app.onError(v1OnError);
  app.route("/api/v1", builtInTools);
  return app.request(`http://local${path}`, { method: "GET" });
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
    // The whole set, not a curated subset: a pane listing five of six tools
    // would be a quietly wrong account of what the model can do.
    expect(items.map((item) => item.name).sort()).toEqual(
      [...BROWSER_TOOL_NAMES].sort(),
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
    expect(items).toHaveLength(BROWSER_TOOL_NAMES.length);
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
  it("is denied — the browser is never advertised to a guest turn", () => {
    // Default-deny: a new v1 route is closed to guests until it earns a
    // pattern. This asserts the browser catalog has not quietly earned one,
    // because a guest reading these schemas would be reading about a
    // capability they cannot be given.
    for (const method of ["GET", "POST"]) {
      expect(
        isGuestAllowedV1Request(
          method,
          "/api/v1/built-in-tools/browser/definitions",
        ),
      ).toBe(false);
    }
  });
});
