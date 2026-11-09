// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { sandboxViewAdmissionRoutes } from "../../routes/apps/mcp-apps/view-admissions.js";
import {
  issueSandboxSourceReceipt,
  sandboxDigest,
} from "../sandbox-view-policy.js";
import { sandboxViewIdentity } from "../sandbox-view-lease.js";

const runtime = vi.hoisted(() => ({ supported: true }));
vi.mock("../../config.js", async (original) => ({
  ...(await original<typeof import("../../config.js")>()),
  HOSTED_MODE: true,
  SANDBOX_HOSTS: new Set(["sandbox.example"]),
}));
vi.mock("../plugins/computer-stdio.js", () => ({
  canColocatePluginStdio: () => runtime.supported,
}));
const source = {
  serverId: "server",
  resourceUri: "ui://view",
  toolCallId: "owned-operation",
};
const html = "<!doctype html><p>Owned plugin App</p>";
const owner = sandboxDigest(
  JSON.stringify(["actor", "session", null, "project"]),
);
const calls: { path: string; body: Record<string, unknown> }[] = [];
let component = true,
  refusedStatus: number | undefined,
  marker = true,
  remote = false;
const refusal = {
  code: "FEATURE_NOT_SUPPORTED",
  message: "STDIO servers are not supported in hosted mode",
  refusalReason: "hosted_stdio_unsupported",
};
function app() {
  const routes = new Hono();
  routes.use("*", async (c, next) => {
    c.set("workosUserId", "actor");
    c.set("workosSessionId", "session");
    c.set("authMethod", "authkit_jwt");
    await next();
  });
  routes.route("/api/web/apps/mcp-apps", sandboxViewAdmissionRoutes());
  return routes;
}
async function prepare(extra: Record<string, unknown> = {}) {
  return app().request(
    "https://app.example/api/web/apps/mcp-apps/view-admissions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer fixture-token",
      },
      body: JSON.stringify({
        viewInstanceId: "639f5fd0-f977-4813-b90f-d57cf2bf7c46",
        projectId: "project",
        serverId: "server",
        source,
        html,
        sourceReceipt: issueSandboxSourceReceipt(
          owner,
          source,
          html,
          undefined,
        ),
        mode: "declared",
        hostOrigin: "https://app.example",
        policy: { permissive: false },
        ...extra,
      }),
    },
  );
}
beforeEach(() => {
  runtime.supported = true;
  component = true;
  refusedStatus = undefined;
  marker = true;
  remote = false;
  calls.length = 0;
  vi.stubEnv(
    "INSPECTOR_SERVICE_TOKEN",
    "sandbox-test-service-credential-32-characters",
  );
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.example");
  vi.stubEnv("VITE_MCPJAM_SANDBOX_ORIGIN", "https://sandbox.example");
  vi.stubEnv("ALLOWED_ORIGINS", "https://app.example");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname,
        input = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ path, body: input });
      if (path === "/web/authorize")
        return remote
          ? Response.json({
              authorized: true,
              serverConfig: {
                transportType: "http",
                url: "https://server.example/mcp",
              },
            })
          : Response.json(refusal, { status: 400 });
      if (path === "/web/authorize-batch") {
        const result = refusedStatus
          ? {
              ok: false,
              status: refusedStatus,
              code: "FORBIDDEN",
              message: "Plugin no longer available",
            }
          : !component || input.pluginComputerRuntime !== true
            ? { ok: false, status: 400, ...refusal }
            : {
                ok: true,
                role: "member",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                serverConfig: {
                  transportType: "stdio",
                  pluginComponent: marker,
                },
              };
        return Response.json({
          organizationId: "org",
          results: { server: result },
        });
      }
      if (path === "/internal/v1/sandbox-view-leases/read")
        return Response.json({}, { status: 409 });
      if (path === "/internal/v1/sandbox-view-leases/create") {
        const fields = { ...input, generation: "generation" };
        return Response.json({
          lease: {
            ...fields,
            identityHash: sandboxViewIdentity(fields),
            expiresAt: Date.now() + 7200000,
          },
        });
      }
      throw Error("Unexpected request: " + path);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("hosted verified plugin App document metadata", () => {
  it("prepares the owned STDIO document without connecting or reserving a Computer", async () => {
    const response = await prepare();
    expect(response.status).toBe(200);
    expect((await response.json()).proxyUrl).toMatch(
      /^https:\/\/v-[a-f0-9]{16}\.sandbox\.example\//,
    );
    expect(calls.map((call) => call.path)).toEqual([
      "/web/authorize",
      "/web/authorize-batch",
      "/internal/v1/sandbox-view-leases/read",
      "/internal/v1/sandbox-view-leases/create",
    ]);
    expect(calls[1].body).toMatchObject({
      projectId: "project",
      serverIds: ["server"],
      pluginComputerRuntime: true,
    });
  });
  it("does not authorize ordinary STDIO even if the browser sends a plugin flag", async () => {
    component = false;
    expect(
      (await prepare({ pluginComputerRuntime: true, pluginComponent: true }))
        .status,
    ).toBe(400);
    expect(
      calls.some((call) => call.path.includes("sandbox-view-leases")),
    ).toBe(false);
  });
  it.each(["disabled", "deleted", "uninstalled", "unverified"])(
    "keeps a %s backend component refusal",
    async () => {
      refusedStatus = 403;
      expect((await prepare()).status).toBe(403);
      expect(
        calls.some((call) => call.path.includes("sandbox-view-leases")),
      ).toBe(false);
    },
  );
  it("requires the backend component marker even after a successful batch response", async () => {
    marker = false;
    expect((await prepare({ pluginComponent: true })).status).toBe(403);
    expect(
      calls.some((call) => call.path.includes("sandbox-view-leases")),
    ).toBe(false);
  });
  it("preserves scenario, access and connection scope on both authorization requests", async () => {
    expect(
      (
        await prepare({
          scenarioId: "scenario",
          accessVersion: 7,
          connectionId: "connection",
        })
      ).status,
    ).toBe(200);
    for (const call of calls.slice(0, 2))
      expect(call.body).toMatchObject({
        scenarioId: "scenario",
        accessVersion: 7,
        connectionId: "connection",
      });
  });
  it("leaves ordinary remote document authorization on its existing path", async () => {
    remote = true;
    expect((await prepare()).status).toBe(200);
    expect(calls.map((call) => call.path)).toEqual([
      "/web/authorize",
      "/internal/v1/sandbox-view-leases/read",
      "/internal/v1/sandbox-view-leases/create",
    ]);
  });
  it("does not add runtime metadata on an unsupported deployment", async () => {
    runtime.supported = false;
    expect((await prepare({ pluginComputerRuntime: true })).status).toBe(400);
    expect(calls.map((call) => call.path)).toEqual(["/web/authorize"]);
  });
  it.each([
    ["missing receipt", () => ({ sourceReceipt: undefined })],
    ["forged receipt", () => ({ sourceReceipt: "forged" })],
    ["different bytes", () => ({ html: "<p>changed</p>" })],
    [
      "different resource",
      () => ({ source: { ...source, resourceUri: "ui://other" } }),
    ],
    [
      "different owner",
      () => ({
        sourceReceipt: issueSandboxSourceReceipt(
          sandboxDigest("other"),
          source,
          html,
          undefined,
        ),
      }),
    ],
  ] as const)(
    "does not widen a %s into a hosted document lease",
    async (_name, change) => {
      expect((await prepare(change())).status).toBeGreaterThanOrEqual(400);
      expect(calls.some((call) => call.path.endsWith("/create"))).toBe(false);
    },
  );
});
