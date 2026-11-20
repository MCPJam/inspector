import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { ConvexError } from "convex/values";
import { getFunctionName } from "convex/server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { MCPClientManager } from "@mcpjam/sdk";
import { computeContentHash, computeEditsHash, type VariantEdit } from "@mcpjam/sdk/variants";

/**
 * `POST /v1/projects/:projectId/variant-servers` against an in-process base
 * MCP server and a fake backend that stores variants the way the contract
 * says: content-addressed per project, behind the beta flag.
 */

const { runEphemeralConnectionMock, backend } = vi.hoisted(() => ({
  runEphemeralConnectionMock: vi.fn(),
  backend: { query: vi.fn(), mutation: vi.fn() },
}));

vi.mock("../../web/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../web/auth.js")>()),
  runEphemeralConnection: runEphemeralConnectionMock,
}));
vi.mock("../convex-client.js", () => ({ createConvexClient: () => backend }));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-token",
}));

import variantServers from "../variant-servers.js";
import { v1OnError } from "../envelope.js";
import { setManagerVariants } from "../../../utils/variant-servers.js";

const PROJECT = "proj1aaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE_ID = "base1aaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VARIANT_SERVER_ID = "vsrv1aaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EDITS = [
  {
    feature: "tools.description",
    target: "show_servers",
    op: "set",
    value: "Lists every saved server and connects to each to report its health.",
  },
  {
    feature: "tools.description",
    target: "list_project_servers",
    op: "set",
    value: "Returns the saved server configuration without connecting.",
  },
];

/** The base: two tools, one with an annotation the client's schema keeps. */
function baseFetch(): typeof fetch {
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: "base", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.registerTool(
      "show_servers",
      {
        description: "Show servers.",
        inputSchema: { project: z.string() },
        annotations: { readOnlyHint: true },
      },
      async () => ({ content: [] }),
    );
    server.registerTool(
      "list_project_servers",
      { description: "List servers." },
      async () => ({ content: [] }),
    );
    return server;
  });
  return (input, init) => handler.fetch(new Request(input, init));
}

/** What authorize-batch would have sent had the base been a variant. */
const VARIANT_OF_BASE = {
  variantId: "variant0",
  serverId: BASE_ID,
  baseServerId: "base0aaaaaaaaaaaaaaaaaaaaaaaaaaa",
  edits: [{ feature: "tools.description" as const, target: "show_servers", op: "set" as const, value: "x" }],
  editsHash: "0".repeat(64),
  baseSurfaceHash: "1".repeat(64),
  toolHashes: [{ tool: "show_servers", hash: "2".repeat(64) }],
  contentHash: "3".repeat(64),
};

/** What the backend's create takes; it recomputes the other hashes. */
type StoreArgs = {
  projectId: string;
  baseServerId: string;
  edits: VariantEdit[];
  baseSurfaceHash: string;
  toolHashes: Array<{ tool: string; hash: string }>;
  label?: string;
  createdVia: string;
};

type Answer = {
  code?: string;
  message?: string;
  details?: unknown;
  variant?: Record<string, unknown>;
  diff?: unknown;
};

let markBaseAsVariant = false;
const stored = new Map<string, Record<string, unknown>>();

beforeEach(() => {
  vi.clearAllMocks();
  markBaseAsVariant = false;
  stored.clear();
  runEphemeralConnectionMock.mockImplementation(
    async (
      _c: unknown,
      rawBody: Record<string, unknown>,
      schema: { parse: (value: unknown) => { serverId: string } },
      fn: (manager: MCPClientManager, body: unknown) => Promise<unknown>,
    ) => {
      const body = schema.parse(rawBody);
      const manager = new MCPClientManager({
        [body.serverId]: { url: "https://base.test/mcp", baseFetch: baseFetch() },
      });
      if (markBaseAsVariant) {
        setManagerVariants(manager, new Map([[body.serverId, VARIANT_OF_BASE]]));
      }
      try {
        return await fn(manager, body);
      } finally {
        await manager.disconnectAllServers();
      }
    },
  );
  backend.query.mockResolvedValue([
    { _id: BASE_ID, name: "mcpjam-mcp-checkout", transportType: "http" },
    { _id: "stdio1aaaaaaaaaaaaaaaaaaaaaaaaaa", name: "local", transportType: "stdio" },
  ]);
  backend.mutation.mockImplementation(
    async (ref: Parameters<typeof getFunctionName>[0], args: StoreArgs) => {
      expect(getFunctionName(ref)).toBe("serverVariants:createVariantServer");
      const editsHash = await computeEditsHash(args.edits);
      const { baseServerId, baseSurfaceHash, toolHashes } = args;
      const contentHash = await computeContentHash({
        baseServerId,
        baseSurfaceHash,
        editsHash,
        toolHashes,
      });
      const existing = stored.get(contentHash);
      if (existing) return { ...existing, created: false };
      const variant = {
        variantId: `variant${stored.size + 1}`,
        serverId: VARIANT_SERVER_ID,
        baseServerId,
        edits: args.edits,
        editsHash,
        baseSurfaceHash,
        toolHashes: args.toolHashes,
        contentHash,
        ...(args.label ? { label: args.label } : {}),
      };
      stored.set(contentHash, variant);
      return { ...variant, created: true };
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function create(body: unknown, headers: Record<string, string> = {}) {
  const app = new Hono();
  app.route("/", variantServers);
  app.onError((error, c) => v1OnError(error, c));
  const response = await app.request(`/projects/${PROJECT}/variant-servers`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Answer };
}

describe("POST /projects/:projectId/variant-servers", () => {
  it("stores a variant of the live base, then answers the same one again", async () => {
    const launcher = { "x-mcpjam-launcher": JSON.stringify({ kind: "mcp" }) };
    const first = await create(
      { server: "mcpjam-mcp-checkout", edits: EDITS, label: "sweep 8" },
      launcher,
    );

    expect(first.status).toBe(200);
    expect(first.body.variant).toMatchObject({
      variantId: "variant1",
      serverId: VARIANT_SERVER_ID,
      baseServerId: BASE_ID,
      label: "sweep 8",
      created: true,
    });
    expect(first.body.diff).toEqual([
      { tool: "show_servers", field: "description", before: "Show servers.", after: EDITS[0].value },
      { tool: "list_project_servers", field: "description", before: "List servers.", after: EDITS[1].value },
    ]);
    const args = backend.mutation.mock.calls[0]![1] as StoreArgs;
    expect(args).toMatchObject({
      projectId: PROJECT,
      baseServerId: BASE_ID,
      edits: EDITS,
      label: "sweep 8",
      createdVia: "mcp",
    });
    expect(args.baseSurfaceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(args.toolHashes.map((entry) => entry.tool)).toEqual([
      "show_servers",
      "list_project_servers",
    ]);

    const again = await create({ server: BASE_ID, edits: EDITS });
    expect(again.status).toBe(200);
    expect(again.body.variant).toMatchObject({ variantId: "variant1", created: false });
    expect(backend.mutation.mock.calls[1]![1]).toEqual({ ...args, createdVia: "rest", label: undefined });
  });

  it("refuses an edit naming a tool the base lacks, before storing anything", async () => {
    const { status, body } = await create({
      server: "mcpjam-mcp-checkout",
      edits: [{ ...EDITS[0], target: "show_everything" }],
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({
      code: "VALIDATION_ERROR",
      message:
        "mcpjam-mcp-checkout has no tool named show_everything. Check the name with list_server_tools.",
      details: { code: "VARIANT_UNKNOWN_TARGET" },
    });
    expect(backend.mutation).not.toHaveBeenCalled();
  });

  it("keeps the backend's refusal when the beta is off", async () => {
    backend.mutation.mockRejectedValueOnce(
      new ConvexError({
        code: "FEATURE_UNAVAILABLE",
        message: "Server variants aren't available for your organization yet.",
        feature: "variant-servers",
      }),
    );

    const { status, body } = await create({ server: "mcpjam-mcp-checkout", edits: EDITS });

    expect(status).toBe(403);
    expect(body).toMatchObject({
      code: "FORBIDDEN",
      message: "Server variants aren't available for your organization yet.",
      details: { code: "FEATURE_UNAVAILABLE", feature: "variant-servers" },
    });
  });

  it("keeps the code and sentence of the backend's other refusals", async () => {
    backend.mutation.mockRejectedValueOnce(
      new ConvexError({
        code: "NOT_FOUND",
        message: "Server not found. Check the server ID with list_project_servers.",
      }),
    );
    const missing = await create({ server: BASE_ID, edits: EDITS });
    expect(missing).toMatchObject({
      status: 404,
      body: { code: "NOT_FOUND", message: "Server not found. Check the server ID with list_project_servers." },
    });

    backend.mutation.mockRejectedValueOnce(
      new ConvexError({ code: "VARIANT_IMMUTABLE", message: "A variant server can't be changed. Create a new variant instead." }),
    );
    const immutable = await create({ server: BASE_ID, edits: EDITS });
    expect(immutable).toMatchObject({
      status: 400,
      body: { code: "VALIDATION_ERROR", details: { code: "VARIANT_IMMUTABLE" } },
    });

    const withKey = await create({ server: BASE_ID, edits: EDITS, idempotencyKey: "k" });
    expect(withKey.status).toBe(400);
  });

  it("refuses a base that isn't an HTTP server, or is itself a variant", async () => {
    const stdio = await create({ server: "local", edits: EDITS });
    expect(stdio.status).toBe(400);
    expect(stdio.body.details).toEqual({ code: "VARIANT_UNSUPPORTED_SERVER" });
    expect(runEphemeralConnectionMock).not.toHaveBeenCalled();

    markBaseAsVariant = true;
    const variant = await create({ server: BASE_ID, edits: EDITS });
    expect(variant.status).toBe(400);
    expect(variant.body).toMatchObject({
      message: "Variants can only be made from an HTTP server that isn't already a variant.",
      details: { code: "VARIANT_UNSUPPORTED_SERVER" },
    });
    expect(backend.mutation).not.toHaveBeenCalled();
  });

  it("needs at least one edit, and at most the contract's limit", async () => {
    const none = await create({ server: BASE_ID, edits: [] });
    expect(none.status).toBe(400);
    expect(none.body.message).toBe(
      "edits: A variant needs at least one edit. Add one to edits.",
    );

    const tooMany = await create({
      server: BASE_ID,
      edits: Array.from({ length: 201 }, (_, index) => ({ ...EDITS[0], target: `t${index}` })),
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.details).toEqual({ code: "VARIANT_TOO_LARGE" });
    expect(runEphemeralConnectionMock).not.toHaveBeenCalled();
  });
});
