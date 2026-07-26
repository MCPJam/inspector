import { beforeEach, describe, expect, it, vi } from "vitest";

// Covers the browser-facing environment preview route
// (server/routes/web/environments.ts). Convex is mocked at the
// `convex/browser` boundary, so these tests prove what the route FORWARDS and,
// more importantly, what it REFUSES to return.

const { convexQueryMock } = vi.hoisted(() => ({
  convexQueryMock: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
  })),
}));

import { createWebTestApp } from "./helpers/test-app.js";

const SPEC = {
  specVersion: 1,
  environmentRef: { environmentId: "env_1", name: "Staging", revision: 7 },
  host: {
    hostId: "host_1",
    hostName: "Alpha",
    hostConfigId: "hc_1",
    runtimeConfig: {
      modelId: "openai/gpt-5-mini",
      systemPrompt: "internal system prompt",
      hostStyle: "claude",
      requireToolApproval: true,
      builtInToolIds: ["web_search"],
      computer: { kind: "personal", workdir: "/home/user/secret-workdir" },
      mcpProfile: {
        extensions: { "com.mcpjam/enterprise-managed-auth": { policy: "on" } },
      },
    },
  },
  servers: {
    selectedServerIds: ["ps_1"],
    pluginServerIds: [],
    baseEffectiveServerIds: ["ps_1"],
    effectiveServerIds: ["ps_1"],
    connectable: [
      { serverId: "ps_1", name: "linear", source: "host_or_group" },
    ],
  },
  skills: [
    {
      skillId: "sk_1",
      name: "pdf-processing",
      description: "Fill PDFs",
      content: "TOP SECRET SKILL BODY",
      aggregateHash: "agg1",
      channels: ["host"],
      files: [
        {
          path: "scripts/fill.py",
          size: 10,
          url: "https://signed.example/blob?sig=leaked",
        },
      ],
    },
  ],
  pluginVersions: [
    {
      pluginId: "pl_1",
      pluginVersionId: "pv_1",
      name: "linear",
      bundleHash: "abc123",
    },
  ],
};

function get(path: string, token: string | null = "test-token-123") {
  const { app } = createWebTestApp();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request(path, { method: "GET", headers });
}

describe("GET /api/web/environments/:id/preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://example.convex.cloud";
    convexQueryMock.mockResolvedValue(SPEC);
  });

  it("requires a projectId", async () => {
    const response = await get("/api/web/environments/env_1/preview");
    expect(response.status).toBe(400);
  });

  it("requires a bearer token (never anonymous)", async () => {
    const response = await get(
      "/api/web/environments/env_1/preview?projectId=p_1",
      null
    );
    expect(response.status).toBe(401);
  });

  it("forwards the path/query ids to the runtime resolver, with no override", async () => {
    const response = await get(
      "/api/web/environments/env_1/preview?projectId=p_1"
    );
    expect(response.status).toBe(200);
    expect(convexQueryMock).toHaveBeenCalledWith(
      "projectEnvironments:resolveEnvironmentForRuntime",
      { projectId: "p_1", environmentId: "env_1" }
    );
    // A preview describes the SAVED environment; a caller must not be able to
    // reshape it into a configuration nobody stored.
    expect(convexQueryMock.mock.calls[0][1]).not.toHaveProperty(
      "serverOverrideIds"
    );
  });

  it("NEVER returns skill content, file URLs, or raw host secrets", async () => {
    const response = await get(
      "/api/web/environments/env_1/preview?projectId=p_1"
    );
    const text = await response.text();
    expect(text).not.toContain("TOP SECRET SKILL BODY");
    expect(text).not.toContain("signed.example");
    expect(text).not.toContain("scripts/fill.py");
    expect(text).not.toContain("secret-workdir");
    expect(text).not.toContain("enterprise-managed-auth");
    expect(text).not.toContain("internal system prompt");

    const body = JSON.parse(text);
    expect(body.environment).toEqual({
      environmentId: "env_1",
      name: "Staging",
      revision: 7,
    });
    expect(body.skills).toEqual([
      {
        skillId: "sk_1",
        name: "pdf-processing",
        description: "Fill PDFs",
        channels: ["host"],
        hasFiles: true,
      },
    ]);
    expect(body.servers).toEqual([
      { serverId: "ps_1", name: "linear", source: "host_or_group" },
    ]);
    expect(body.plugins).toEqual([
      { pluginId: "pl_1", pluginVersionId: "pv_1", name: "linear" },
    ]);
    expect(body.capabilities).toMatchObject({
      hasComputer: true,
      serverCount: 1,
      skillCount: 1,
      pluginCount: 1,
      skillDelivery: "emulated",
    });
  });

  it("surfaces a structured ENV_* failure as a 409 with its code", async () => {
    const { ConvexError } = await import("convex/values");
    convexQueryMock.mockRejectedValue(
      new ConvexError({
        code: "ENV_PLUGIN_UNAVAILABLE",
        message: "Plugin can no longer provide its server",
      })
    );
    const response = await get(
      "/api/web/environments/env_1/preview?projectId=p_1"
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(JSON.stringify(body)).toContain("ENV_PLUGIN_UNAVAILABLE");
  });

  it("fails closed on a spec missing a host invariant", async () => {
    convexQueryMock.mockResolvedValue({
      environmentRef: { environmentId: "env_1", name: "Staging", revision: 7 },
      host: { hostId: "host_1" },
      servers: { effectiveServerIds: [] },
    });
    const response = await get(
      "/api/web/environments/env_1/preview?projectId=p_1"
    );
    expect(response.status).toBe(502);
  });
});
