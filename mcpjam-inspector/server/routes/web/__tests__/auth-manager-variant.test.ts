/**
 * `createAuthorizedManager` given an authorize-batch entry that carries a
 * `variant`: the connection is built exactly as the base's (its URL, its
 * stored headers revealed for the base's id), its fetch rewrites only
 * `tools/list`, and it is never written into a replay config.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeToolHash } from "@mcpjam/sdk/variants";

const { managerConfigs } = vi.hoisted(() => ({
  managerConfigs: [] as Array<Record<string, Record<string, unknown>>>,
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk",
  );
  class RecordingManager {
    constructor(configs: Record<string, Record<string, unknown>>) {
      managerConfigs.push(configs);
    }
    setElicitationCallback() {}
    setMrtrInputCollector() {}
    async disconnectAllServers() {}
  }
  return { ...actual, MCPClientManager: RecordingManager };
});

const BASE_URL = "https://base.example.test/mcp";
const SHOW = {
  name: "show_servers",
  description: "Show servers.",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
};
const LIST = { name: "list_project_servers", description: "List servers." };

/** What the base answered, and the requests that reached it. */
let baseTools: Array<Record<string, unknown>> = [SHOW, LIST];
const baseRequests: Headers[] = [];
const revealedFor: string[] = [];
const refreshedFor: string[] = [];
const authorizeBodies: Array<Record<string, unknown>> = [];

async function variantDefinition(overrides: Record<string, unknown> = {}) {
  return {
    variantId: "variant1",
    serverId: "v1",
    baseServerId: "base1",
    edits: [
      { feature: "tools.description", target: "show_servers", op: "set", value: "Edited." },
    ],
    editsHash: "a".repeat(64),
    baseSurfaceHash: "b".repeat(64),
    toolHashes: [{ tool: "show_servers", hash: await computeToolHash(SHOW) }],
    contentHash: "c".repeat(64),
    ...overrides,
  };
}

function entry(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    role: "member",
    accessLevel: "project_member",
    permissions: { chatOnly: false },
    serverConfig: {
      transportType: "http",
      url: BASE_URL,
      useOAuth: false,
      hasHeaders: true,
      credentialHeaderNames: ["x-api-key"],
    },
    ...extra,
  };
}

function mockFetch(results: Record<string, unknown>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/web/authorize-batch")) {
      authorizeBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ results });
    }
    if (url.endsWith("/web/oauth/force-refresh")) {
      refreshedFor.push(JSON.parse(String(init?.body)).serverId);
      return Response.json({ accessToken: "tok-new", boundOrigins: [new URL(BASE_URL).origin] });
    }
    if (url.endsWith("/web/server/reveal-secrets")) {
      revealedFor.push(JSON.parse(String(init?.body)).serverId);
      return Response.json({
        success: true,
        headers: { "x-api-key": "k1" },
        credentialHeaderNames: ["x-api-key"],
        boundOrigins: [new URL(BASE_URL).origin],
      });
    }
    if (url === BASE_URL) {
      baseRequests.push(new Headers(init?.headers));
      const { id } = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: "2.0", id, result: { tools: baseTools } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

async function createManager(serverIds: string[]) {
  const { createAuthorizedManager } = await import("../auth.js");
  return createAuthorizedManager({ authMethod: "jwt" }, "bearer", "p1", serverIds, 5_000);
}

async function listThrough(config: Record<string, unknown>) {
  const baseFetch = config.baseFetch as typeof fetch;
  const headers = new Headers((config.requestInit as RequestInit).headers);
  headers.set("content-type", "application/json");
  const response = await baseFetch(BASE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
  });
  return (await response.json()) as {
    result?: { tools: Array<{ name: string; description?: string }> };
    error?: { code: number; data: { code: string; tools: string[] } };
  };
}

describe("createAuthorizedManager with a variant entry", () => {
  const originalFetch = global.fetch;
  const originalHosted = process.env.VITE_MCPJAM_HOSTED_MODE;

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://convex.example.test";
    // Local mode dials the stubbed global fetch instead of the egress guard.
    process.env.VITE_MCPJAM_HOSTED_MODE = "false";
    vi.resetModules();
    managerConfigs.length = 0;
    baseRequests.length = 0;
    revealedFor.length = 0;
    refreshedFor.length = 0;
    authorizeBodies.length = 0;
    baseTools = [SHOW, LIST];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalHosted === undefined) delete process.env.VITE_MCPJAM_HOSTED_MODE;
    else process.env.VITE_MCPJAM_HOSTED_MODE = originalHosted;
  });

  it("connects the base as the base would, and rewrites only the variant's tools/list", async () => {
    mockFetch({ base1: entry(), v1: entry({ variant: await variantDefinition() }) });
    await createManager(["base1", "v1"]);
    const configs = managerConfigs[0]!;

    // Asked for variants by name, and given the base's address and stored
    // header, revealed for the base's own id.
    expect(authorizeBodies[0]).toMatchObject({ serverIds: ["base1", "v1"], variantSupport: 1 });
    expect(configs.v1!.url).toBe(BASE_URL);
    expect(revealedFor.sort()).toEqual(["base1", "base1"]);
    expect(configs.v1!.replayable).toBe(false);
    expect(configs.base1!.replayable).toBeUndefined();

    const viaVariant = await listThrough(configs.v1!);
    expect(viaVariant.result!.tools).toEqual([{ ...SHOW, description: "Edited." }, LIST]);
    expect(baseRequests.at(-1)!.get("x-api-key")).toBe("k1");
    const viaBase = await listThrough(configs.base1!);
    expect(viaBase.result!.tools).toEqual([SHOW, LIST]);
  });

  it("serves the variant on each account connection of a Playground chat turn", async () => {
    mockFetch({
      v1: entry({
        variant: await variantDefinition(),
        serverConfig: { transportType: "http", url: BASE_URL, useOAuth: true },
        oauthConnections: [
          { connectionId: "acct1", accessToken: "tok1", isDefault: true },
          { connectionId: "acct2", accessToken: "tok2", isDefault: false },
        ],
      }),
    });
    const { createAuthorizedManager } = await import("../auth.js");
    // The options `chat-turn/managed-connections.ts` passes for a chat turn.
    await createAuthorizedManager({ authMethod: "jwt" }, "bearer", "p1", ["v1"], 5_000, undefined, undefined, {
      multiConnection: true,
      tolerateServerRefusals: ["v1"],
      observeFeatures: true,
    });

    const connections = Object.values(managerConfigs[0]!);
    expect(connections).toHaveLength(2);
    for (const config of connections) {
      expect(config.replayable).toBe(false);
      expect((await listThrough(config)).result!.tools[0]!.description).toBe("Edited.");
    }
    // Each account's own token reached the base.
    expect(baseRequests.map((headers) => headers.get("authorization")).sort()).toEqual([
      "Bearer tok1",
      "Bearer tok2",
    ]);
  });

  it("refreshes the base's credentials when the variant's connection gets a 401", async () => {
    mockFetch({
      v1: entry({
        variant: await variantDefinition(),
        serverConfig: { transportType: "http", url: BASE_URL, useOAuth: true },
        oauthAccessToken: "tok-old",
        oauthCredentialId: "cred1",
      }),
    });
    await createManager(["v1"]);
    const config = managerConfigs[0]!.v1! as {
      onUnauthorized: (context: { error?: unknown }) => Promise<{ accessToken: string }>;
    };

    await expect(config.onUnauthorized({})).resolves.toEqual({ accessToken: "tok-new" });
    expect(refreshedFor).toEqual(["base1"]);
  });

  it("answers VARIANT_BASE_DRIFTED once the base changes an edited tool", async () => {
    mockFetch({ v1: entry({ variant: await variantDefinition() }) });
    await createManager(["v1"]);
    baseTools = [{ ...SHOW, description: "Show every server." }, LIST];

    const answer = await listThrough(managerConfigs[0]!.v1!);
    expect(answer.error).toMatchObject({
      code: -32090,
      data: { code: "VARIANT_BASE_DRIFTED", tools: ["show_servers"] },
    });
  });

  it("refuses a variant it can't read, or whose base isn't HTTP, instead of dialing the base", async () => {
    mockFetch({ v1: entry({ variant: await variantDefinition({ editsHash: "not-a-hash" }) }) });
    await expect(createManager(["v1"])).rejects.toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
    });

    mockFetch({
      v1: entry({
        variant: await variantDefinition(),
        serverConfig: { transportType: "stdio", command: "node" },
      }),
    });
    await expect(createManager(["v1"])).rejects.toMatchObject({
      status: 400,
      details: { code: "VARIANT_UNSUPPORTED_SERVER" },
    });
    expect(managerConfigs).toHaveLength(0);
  });
});
