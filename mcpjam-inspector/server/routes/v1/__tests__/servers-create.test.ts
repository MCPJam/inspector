/**
 * `POST /v1/projects/:projectId/servers` — the create body's contract.
 *
 * `enabled` was the one REQUIRED member of a body whose every other member is
 * optional, and `--body` documents no schema, so the only way to discover it
 * was to send a server and read back
 * `enabled: Invalid input: expected boolean, received undefined`. A caller
 * found the shape one rejection at a time.
 *
 * The pair of assertions that matters is create-defaults-to-true versus
 * update-leaves-it-alone: the field is shared between the two schemas, so a
 * default applied in the wrong place turns "patch the URL" into "silently
 * re-enable this server".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const convex = vi.hoisted(() => ({
  action: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
  setAuth: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth = convex.setAuth;
    action = convex.action;
    query = convex.query;
    mutation = convex.mutation;
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: vi.fn(async () => "bearer-token"),
}));

const { default: serversV1 } = await import("../servers.js");
const { mapRuntimeError, webError } = await import("../../web/errors.js");

function createApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", serversV1);
  app.onError((error, c) => {
    const routeError = mapRuntimeError(error);
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details,
    );
  });
  return app;
}

const postServer = (body: unknown) => postRawServer(JSON.stringify(body));

/**
 * The body verbatim. `postServer` cannot express an empty body or a bare
 * `null` through `JSON.stringify`, and those are the two shapes that reach the
 * body reader rather than the schema.
 */
const postRawServer = (raw: string) =>
  createApp().request("/api/v1/projects/proj-1/servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });

const patchServer = (body: unknown) =>
  createApp().request("/api/v1/projects/proj-1/servers/srv-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** The arguments the route forwarded to Convex on the last write. */
function forwardedArgs(): Record<string, unknown> {
  const call = convex.action.mock.calls.at(-1);
  if (!call) throw new Error("no Convex write was forwarded");
  return call[1] as Record<string, unknown>;
}

const MINIMAL_HTTP_SERVER = {
  name: "billing",
  transportType: "http" as const,
  url: "https://mcp.example.test/mcp",
};

beforeEach(() => {
  vi.clearAllMocks();
  // `convexClient` refuses to build without it and would 500 every route.
  vi.stubEnv("CONVEX_URL", "https://convex.test");
  convex.action.mockResolvedValue("srv-1");
  convex.mutation.mockResolvedValue("srv-1");
  // `findProjectServer` re-reads the project's rows after every write and
  // 404s when the new id is missing, so the list has to contain it.
  convex.query.mockResolvedValue([
    {
      _id: "srv-1",
      projectId: "proj-1",
      name: "billing",
      enabled: true,
      transportType: "http",
      url: "https://mcp.example.test/mcp",
    },
  ]);
});

describe("POST /projects/:projectId/servers", () => {
  it("accepts a body that omits `enabled` and defaults it to true", async () => {
    const response = await postServer(MINIMAL_HTTP_SERVER);

    // The regression: this used to be a 400 naming a field no example showed.
    expect(response.status).toBe(201);
    expect(forwardedArgs().enabled).toBe(true);
  });

  it("still honours an explicit `enabled: false`", async () => {
    // The default must not overwrite a caller who deliberately creates a
    // server switched off — that is the whole reason to default rather than
    // to hardcode downstream.
    const response = await postServer({
      ...MINIMAL_HTTP_SERVER,
      enabled: false,
    });

    expect(response.status).toBe(201);
    expect(forwardedArgs().enabled).toBe(false);
  });

  it("still rejects a non-boolean `enabled`", async () => {
    // Defaulting is not coercion: a caller sending the wrong type still gets
    // told, rather than silently getting `true`.
    const response = await postServer({
      ...MINIMAL_HTTP_SERVER,
      enabled: "yes",
    });

    expect(response.status).toBe(400);
    expect(convex.action).not.toHaveBeenCalled();
  });

  it("rejects a null body, an array, and an empty body as validation errors", async () => {
    // These never reach the schema — `readJsonObject` refuses them first — so
    // they are the cases a schema-shaped test would miss entirely.
    for (const raw of ["null", "[]", ""]) {
      const response = await postRawServer(raw);
      expect([raw, response.status]).toEqual([raw, 400]);
    }
    expect(convex.action).not.toHaveBeenCalled();
  });

  it("translates a rejected Convex write into the public error envelope", async () => {
    // The default mock resolves, so nothing else here exercises the catch that
    // turns a backend rejection into a v1 error rather than an unhandled 500.
    convex.action.mockRejectedValueOnce(
      Object.assign(new Error("backend refused"), {
        data: { code: "CONFLICT", message: "duplicate name" },
      }),
    );

    const response = await postServer(MINIMAL_HTTP_SERVER);

    // 409 with the backend's own code preserved, NOT a 500: the catch exists
    // so a name collision reads as a conflict the caller can act on rather
    // than as an MCPJam fault.
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CONFLICT" });
  });
});

describe("PATCH /projects/:projectId/servers/:serverId", () => {
  it("does not invent `enabled` on a patch that never mentioned it", async () => {
    // The create default lives on the create schema alone. Applied to the
    // shared field it would ride along on every unrelated patch and re-enable
    // servers their owner had turned off.
    const response = await patchServer({ name: "billing-renamed" });

    expect(response.status).toBeLessThan(400);
    expect("enabled" in forwardedArgs()).toBe(false);
  });
});
