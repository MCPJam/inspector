/**
 * MJ-020, MJ-021: how `/v1/projects/:projectId/servers` answers when the
 * backend refuses the caller, through the real v1 error boundary.
 *
 * The backend's authorization refusal is `ConvexError({ kind: 'forbidden' })`
 * and answers 403 whether or not it carries a message, on the write routes
 * (which translate their own failures) and on the reads (which leave it to
 * the boundary). Older deployments refuse with a plain error: that stays a
 * refusal or an opaque 500, and never carries Convex's own framing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const config = vi.hoisted(() => ({ hosted: false }));

vi.mock("../../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config.js")>();
  return {
    ...actual,
    get HOSTED_MODE() {
      return config.hosted;
    },
  };
});

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

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
const { v1OnError } = await import("../envelope.js");
const { requestLogContextMiddleware } =
  await import("../../../middleware/request-log-context.js");
const { logger } = await import("../../../utils/logger.js");

const REQUEST_ID = "req-v1-servers-check";

function createApp(): Hono {
  const app = new Hono();
  app.use("*", requestLogContextMiddleware);
  app.route("/api/v1", serversV1);
  app.onError((error, c) => v1OnError(error, c));
  return app;
}

/** What `ConvexHttpClient` rejects with for a `ConvexError`. */
function convexError(data: Record<string, unknown>): Error {
  return Object.assign(
    new Error(
      `[CONVEX A(servers:createServerWithClientSecret)] [Request ID: 7d1b] Server Error\nUncaught ConvexError: ${JSON.stringify(data)}`,
    ),
    { data },
  );
}

const createInOtherProject = () =>
  createApp().request("/api/v1/projects/proj-other-tenant/servers", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": REQUEST_ID },
    body: JSON.stringify({
      name: "billing",
      transportType: "http",
      url: "https://mcp.example.test/mcp",
    }),
  });

async function expectNoConvexFraming(response: Response) {
  const text = await response.clone().text();
  expect(text).not.toContain("Request ID: 7d1b");
  expect(text).not.toContain("Uncaught");
  expect(text).not.toContain("CONVEX A(");
  expect(text).not.toContain("authorization.ts");
}

describe("POST /v1/projects/:projectId/servers refusals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.hosted = false;
    vi.stubEnv("CONVEX_URL", "https://convex.test");
    vi.spyOn(logger, "event").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("answers the authorization refusal with 403", async () => {
    convex.action.mockRejectedValue(convexError({ kind: "forbidden" }));

    const response = await createInOtherProject();

    expect(response.status).toBe(403);
    await expectNoConvexFraming(response);
    expect(await response.json()).toEqual({
      code: "FORBIDDEN",
      message: "You do not have permission to do that.",
    });
  });

  it("keeps the backend's own sentence when the refusal carries one", async () => {
    convex.action.mockRejectedValue(
      convexError({
        kind: "forbidden",
        message: "Not a member of this project",
      }),
    );

    const response = await createInOtherProject();

    expect(response.status).toBe(403);
    await expectNoConvexFraming(response);
    expect(await response.json()).toEqual({
      code: "FORBIDDEN",
      message: "Not a member of this project",
    });
  });

  it("answers the same refusal on a read that leaves it to the boundary", async () => {
    convex.query.mockRejectedValue(convexError({ kind: "forbidden" }));

    const response = await createApp().request(
      "/api/v1/projects/proj-other-tenant/servers/srv-1",
      { headers: { "x-request-id": REQUEST_ID } },
    );

    expect(response.status).toBe(403);
    await expectNoConvexFraming(response);
    expect((await response.json()).code).toBe("FORBIDDEN");
  });

  it("keeps an older deployment's plain membership refusal a refusal", async () => {
    convex.action.mockRejectedValue(
      new Error(
        "[CONVEX A(servers:createServerWithClientSecret)] [Request ID: 7d1b] Server Error\nUncaught Error: Not a member of this project\n    at requireProjectRole (../convex/lib/authorization.ts:731:25)",
      ),
    );

    const response = await createInOtherProject();

    expect(response.status).toBe(404);
    await expectNoConvexFraming(response);
    expect(await response.json()).toEqual({
      code: "NOT_FOUND",
      message: "Server not found",
    });
  });

  it("answers a production-masked refusal with an opaque 500 and the request id", async () => {
    config.hosted = true;
    convex.action.mockRejectedValue(
      new Error(
        "[CONVEX A(servers:createServerWithClientSecret)] [Request ID: 7d1b] Server Error",
      ),
    );

    const response = await createInOtherProject();

    expect(response.status).toBe(500);
    await expectNoConvexFraming(response);
    const body = await response.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.message).toContain(REQUEST_ID);
    expect(body.details).toEqual({ requestId: REQUEST_ID });
  });
});

describe("PATCH and DELETE /v1/projects/:projectId/servers/:serverId refusals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.hosted = true;
    vi.stubEnv("CONVEX_URL", "https://convex.test");
    vi.spyOn(logger, "event").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** What a production deployment returns for a plain backend throw. */
  const masked = (fn: string) =>
    new Error(`[CONVEX ${fn}] [Request ID: 7d1b] Server Error`);

  const patchServer = (projectId: string, serverId: string) =>
    createApp().request(`/api/v1/projects/${projectId}/servers/${serverId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-request-id": REQUEST_ID,
      },
      body: JSON.stringify({ name: "renamed" }),
    });

  const deleteServer = (projectId: string, serverId: string) =>
    createApp().request(`/api/v1/projects/${projectId}/servers/${serverId}`, {
      method: "DELETE",
      headers: { "x-request-id": REQUEST_ID },
    });

  it("answers a PATCH to a server the caller cannot see with 404", async () => {
    convex.action.mockRejectedValue(
      masked("A(servers:updateServerWithClientSecret)"),
    );
    // The project's server list, as this caller sees it.
    convex.query.mockResolvedValue([]);

    const response = await patchServer("proj-other-tenant", "srv-1");

    expect(response.status).toBe(404);
    await expectNoConvexFraming(response);
    expect(await response.json()).toEqual({
      code: "NOT_FOUND",
      message: "Server not found",
    });
    expect(convex.query).toHaveBeenCalledWith("servers:getProjectServers", {
      projectId: "proj-other-tenant",
    });
  });

  it("answers a DELETE of a server the caller cannot see with 404", async () => {
    convex.mutation.mockRejectedValue(masked("M(servers:deleteServer)"));
    convex.query.mockResolvedValue([{ _id: "srv-someone-else" }]);

    const response = await deleteServer("proj-other-tenant", "srv-1");

    expect(response.status).toBe(404);
    await expectNoConvexFraming(response);
    expect(await response.json()).toEqual({
      code: "NOT_FOUND",
      message: "Server not found",
    });
  });

  it("keeps the opaque 500 when the caller can see the server", async () => {
    convex.mutation.mockRejectedValue(masked("M(servers:deleteServer)"));
    convex.query.mockResolvedValue([{ _id: "srv-1" }]);

    const response = await deleteServer("proj-mine", "srv-1");

    expect(response.status).toBe(500);
    await expectNoConvexFraming(response);
    const body = await response.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.details).toEqual({ requestId: REQUEST_ID });
  });

  it("keeps the opaque 500 when the visibility lookup fails too", async () => {
    convex.action.mockRejectedValue(
      masked("A(servers:updateServerWithClientSecret)"),
    );
    convex.query.mockRejectedValue(masked("Q(servers:getProjectServers)"));

    const response = await patchServer("proj-mine", "srv-1");

    expect(response.status).toBe(500);
    await expectNoConvexFraming(response);
    expect((await response.json()).details).toEqual({ requestId: REQUEST_ID });
  });

  it("does not look the server up for a refusal the backend already classified", async () => {
    convex.mutation.mockRejectedValue(
      convexError({ code: "NOT_FOUND", message: "Server not found" }),
    );

    const response = await deleteServer("proj-mine", "srv-1");

    expect(response.status).toBe(404);
    expect(convex.query).not.toHaveBeenCalled();
  });

  it("answers the authorization refusal on PATCH with 403", async () => {
    convex.action.mockRejectedValue(convexError({ kind: "forbidden" }));

    const response = await patchServer("proj-other-tenant", "srv-1");

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("FORBIDDEN");
    expect(convex.query).not.toHaveBeenCalled();
  });
});
