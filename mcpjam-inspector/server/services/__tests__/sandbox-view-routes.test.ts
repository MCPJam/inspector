// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { MCPClientManager } from "@mcpjam/sdk";
import { generateSessionToken } from "../session-token.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { MCPJAM_PLATFORM_SERVER_ID } from "../../../shared/mcpjam-agent-widgets.js";
import { SANDBOX_VIEW_REQUEST_MAX_BYTES } from "../../../shared/sandbox-view-limits.js";
import { webBodyLimit } from "../../middleware/web-body-limit.js";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";

const calls = vi.hoisted(() => ({
  authorize: vi.fn(),
  authorizeLocal: vi.fn(),
  prepare: vi.fn(),
  dispose: vi.fn(),
}));
const runtimeMode = vi.hoisted(() => ({ hosted: false }));
vi.mock("../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config.js")>()),
  get HOSTED_MODE() { return runtimeMode.hosted; },
}));
vi.mock("../sandbox-view-registry.js", () => ({
  sandboxViews: { prepare: calls.prepare, dispose: calls.dispose },
}));
vi.mock("../../routes/web/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../routes/web/auth.js")>()),
  authorizeServer: calls.authorize,
  authorizeBatch: calls.authorizeLocal,
}));
import { sandboxViewAdmissionRoutes } from "../../routes/apps/mcp-apps/view-admissions.js";

let token: string;
let actor: string | undefined;
const body = () => ({
  viewInstanceId: "639f5fd0-f977-4813-b90f-d57cf2bf7c46",
  source: { serverId: "server", resourceUri: "ui://view", toolCallId: "call" },
  html: "<p>view</p>",
  mode: "declared",
  hostOrigin: "http://localhost:6274",
  policy: { permissive: false },
});
function app(web = false) {
  const instance = new Hono();
  instance.use("/api/web/*", webBodyLimit());
  const manager = new MCPClientManager({
    server: { url: "https://server.example/mcp" },
  });
  instance.use("*", async (c, next) => {
    c.mcpClientManager = manager;
    if (actor) {
      c.set("workosUserId", actor);
      c.set("workosSessionId", "fixture-session");
      c.set("authMethod", "authkit_jwt");
    }
    await next();
  });
  instance.route(
    `/api/${web ? "web/apps" : "apps"}/mcp-apps`,
    sandboxViewAdmissionRoutes(),
  );
  return instance;
}
function headers() {
  return {
    "Content-Type": "application/json",
    "X-MCP-Session-Auth": `Bearer ${token}`,
    Authorization: "Bearer fixture-user-token",
  };
}
beforeEach(() => {
  runtimeMode.hosted = false;
  token = generateSessionToken();
  actor = "fixture-user";
  calls.authorize.mockReset().mockResolvedValue({ authorized: true });
  calls.authorizeLocal.mockReset().mockResolvedValue({ results: { server: { ok: true } } });
  calls.prepare.mockReset().mockResolvedValue({
    admissionId: "639f5fd0-f977-4813-b90f-d57cf2bf7c46",
    proxyUrl: "http://127.0.0.1:53000/api/apps/mcp-apps/sandbox-proxy",
    htmlSha256: "a".repeat(64),
    expiresAt: Date.now() + 7200000,
  });
  calls.dispose.mockReset();
});

describe("App document admission route authority", () => {
  it("admits an App larger than 1MiB through the outer web limit and route", async () => {
    const html = "x".repeat(1_150_721);
    const response = await app(true).request("/api/web/apps/mcp-apps/view-admissions", {
      method: "POST", headers: headers(),
      body: JSON.stringify({ ...body(), projectId: "project", serverId: "server", html }),
    });
    expect(response.status).toBe(200);
    expect(calls.authorizeLocal).toHaveBeenCalledOnce();
    expect(calls.prepare.mock.calls[0][0].html).toBe(html);
  });

  it("accepts exactly the route's 16MiB envelope and refuses one more byte", async () => {
    const json = JSON.stringify({ ...body(), projectId: "project", serverId: "server" });
    const envelope = json + " ".repeat(SANDBOX_VIEW_REQUEST_MAX_BYTES - Buffer.byteLength(json));
    const instance = app(true);
    for (const [value, status] of [[envelope, 200], [envelope + " ", 413]] as const) {
      const response = await instance.request("/api/web/apps/mcp-apps/view-admissions", {
        method: "POST", headers: { ...headers(), "Content-Length": String(Buffer.byteLength(value)) }, body: value,
      });
      expect(response.status).toBe(status);
    }
    expect(calls.prepare).toHaveBeenCalledOnce();
  });

  it("rejects an unauthenticated web admission before reading a large body", async () => {
    const instance = new Hono();
    instance.use("/api/web/*", webBodyLimit());
    instance.use("/api/web/apps/mcp-apps/view-admissions", bearerAuthMiddleware);
    instance.route("/api/web/apps/mcp-apps", sandboxViewAdmissionRoutes());
    const request = new Request("http://localhost:6274/api/web/apps/mcp-apps/view-admissions", {
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(SANDBOX_VIEW_REQUEST_MAX_BYTES + 1) },
      body: JSON.stringify(body()),
    });
    const reader = vi.fn(request.body!.getReader.bind(request.body));
    Object.defineProperty(request.body, "getReader", { value: reader });
    const response = await instance.fetch(request);
    expect(response.status).toBe(401);
    expect(reader).not.toHaveBeenCalled();
    expect(calls.prepare).not.toHaveBeenCalled();
  });

  it.each([undefined, "Bearer invalid"])(
    "rejects local auth %s before reading the request body",
    async (authorization) => {
      const request = new Request(
        "http://localhost:6274/api/apps/mcp-apps/view-admissions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "100000000",
            ...(authorization ? { "X-MCP-Session-Auth": authorization } : {}),
          },
          body: JSON.stringify(body()),
        },
      );
      const reader = vi.fn(request.body!.getReader.bind(request.body));
      Object.defineProperty(request.body, "getReader", { value: reader });
      const response = await app().fetch(request);
      expect(response.status).toBe(401);
      expect(reader).not.toHaveBeenCalled();
      expect(calls.prepare).not.toHaveBeenCalled();
    },
  );

  it("rejects a foreign browser Origin", async () => {
    const response = await app().request("/api/apps/mcp-apps/view-admissions", {
      method: "POST",
      headers: { ...headers(), Origin: "https://foreign.example" },
      body: JSON.stringify(body()),
    });
    expect(response.status).toBe(403);
    expect(calls.prepare).not.toHaveBeenCalled();
  });

  it("requires matching web server identity and reauthorizes every renewal", async () => {
    const instance = app(true);
    const url = "/api/web/apps/mcp-apps/view-admissions";
    const mismatch = await instance.request(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        ...body(),
        projectId: "project",
        serverId: "other",
      }),
    });
    expect(mismatch.status).toBe(403);
    expect(calls.authorizeLocal).not.toHaveBeenCalled();
    for (const extra of [{}, { admissionId: body().viewInstanceId }]) {
      const response = await instance.request(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          ...body(),
          projectId: "project",
          serverId: "server",
          ...extra,
        }),
      });
      expect(response.status).toBe(200);
    }
    expect(calls.authorizeLocal).toHaveBeenCalledTimes(2);
    expect(calls.authorizeLocal.mock.calls[0].slice(1, 4)).toEqual([
      "fixture-user-token",
      "project",
      ["server"],
    ]);
    expect(calls.authorize).not.toHaveBeenCalled();
  });

  it("keeps the caller and selected connection scope on local authorization", async () => {
    const response = await app(true).request("/api/web/apps/mcp-apps/view-admissions", {
      method: "POST", headers: headers(),
      body: JSON.stringify({ ...body(), projectId: "project", serverId: "server",
        connectionId: "connection", scenarioId: "scenario", accessVersion: 4 }),
    });
    expect(response.status).toBe(200);
    expect(calls.authorizeLocal.mock.calls[0][0]).toMatchObject({
      authMethod: "authkit_jwt", workosUserId: actor,
    });
    expect(calls.authorizeLocal.mock.calls[0][4]).toEqual({
      connectionId: "connection", scenarioId: "scenario", accessVersion: 4,
    });
  });

  it.each([undefined, { ok: false, status: 403, code: "FORBIDDEN", message: "Access revoked" }])(
    "refuses a missing or revoked local server before preparing a document",
    async (result) => {
      calls.authorizeLocal.mockResolvedValueOnce({ results: { server: result } });
      const response = await app(true).request("/api/web/apps/mcp-apps/view-admissions", {
        method: "POST", headers: headers(),
        body: JSON.stringify({ ...body(), projectId: "project", serverId: "server" }),
      });
      expect(response.status).toBe(403);
      expect(calls.prepare).not.toHaveBeenCalled();
    },
  );

  it("keeps hosted authorization on its hosted policy path", async () => {
    runtimeMode.hosted = true;
    calls.authorize.mockRejectedValueOnce(new WebRouteError(403, ErrorCode.FORBIDDEN, "Hosted refusal"));
    const response = await app(true).request("/api/web/apps/mcp-apps/view-admissions", {
      method: "POST", headers: headers(),
      body: JSON.stringify({ ...body(), projectId: "project", serverId: "server" }),
    });
    expect(response.status).toBe(403);
    expect(calls.authorize).toHaveBeenCalledOnce();
    expect(calls.authorizeLocal).not.toHaveBeenCalled();
    expect(calls.prepare).not.toHaveBeenCalled();
  });

  it("admits the synthetic platform resource only with a verified actor", async () => {
    const response = await app(true).request(
      "/api/web/apps/mcp-apps/view-admissions",
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          ...body(),
          source: { ...body().source, serverId: MCPJAM_PLATFORM_SERVER_ID },
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(calls.authorize).not.toHaveBeenCalled();
    expect(calls.prepare).toHaveBeenCalledOnce();
  });

  it("refuses a synthetic platform caller without a verified actor", async () => {
    actor = undefined;
    const response = await app(true).request(
      "/api/web/apps/mcp-apps/view-admissions",
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          ...body(),
          source: { ...body().source, serverId: MCPJAM_PLATFORM_SERVER_ID },
        }),
      },
    );
    expect(response.status).toBe(401);
    expect(calls.prepare).not.toHaveBeenCalled();
  });

  it("keeps retryable service failure distinct from a terminal admission refusal", async () => {
    const instance = app();
    calls.prepare.mockRejectedValueOnce(
      new WebRouteError(
        503,
        ErrorCode.INTERNAL_ERROR,
        "Temporarily unavailable",
      ),
    );
    let response = await instance.request(
      "/api/apps/mcp-apps/view-admissions",
      { method: "POST", headers: headers(), body: JSON.stringify(body()) },
    );
    expect(response.status).toBe(503);
    calls.prepare.mockRejectedValueOnce(new Error("Admission expired"));
    response = await instance.request("/api/apps/mcp-apps/view-admissions", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body()),
    });
    expect(response.status).toBe(400);
  });

  it("derives cleanup authority from the current actor rather than request fields", async () => {
    const instance = app();
    await instance.request("/api/apps/mcp-apps/view-admissions", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body()),
    });
    const preparedOwner = calls.prepare.mock.calls[0][1];
    actor = "different-user";
    const response = await instance.request(
      `/api/apps/mcp-apps/view-admissions/${body().viewInstanceId}`,
      {
        method: "DELETE",
        headers: headers(),
        body: JSON.stringify({
          source: body().source,
          ownerHash: preparedOwner,
        }),
      },
    );
    expect(response.status).toBe(204);
    expect(calls.dispose.mock.calls[0][1]).not.toBe(preparedOwner);
  });
});
