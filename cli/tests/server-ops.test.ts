import assert from "node:assert/strict";
import test from "node:test";
import {
  exportServerSnapshot,
  listToolsWithMetadata,
} from "../src/lib/server-ops.js";

function createMockManager(overrides: Record<string, any> = {}) {
  return {
    listTools: async () => ({ tools: [], nextCursor: undefined }),
    getAllToolsMetadata: () => ({}),
    listResources: async () => ({ resources: [], nextCursor: undefined }),
    listPrompts: async () => ({ prompts: [], nextCursor: undefined }),
    listResourceTemplates: async () => ({
      resourceTemplates: [],
      nextCursor: undefined,
    }),
    getInitializationInfo: () => null,
    getServerCapabilities: () => null,
    ...overrides,
  } as any;
}

test("listToolsWithMetadata returns tools metadata and token estimate", async () => {
  const manager = createMockManager({
    listTools: async () => ({
      tools: [{ name: "echo", description: "Echo input" }],
      nextCursor: "next-page",
    }),
    getAllToolsMetadata: () => ({ echo: { executionCount: 1 } }),
  });

  const result = await listToolsWithMetadata(manager, {
    serverId: "srv",
    modelId: "gpt-5",
    cursor: "cur",
  });

  assert.deepEqual(result.toolsMetadata, { echo: { executionCount: 1 } });
  assert.equal(result.nextCursor, "next-page");
  assert.equal(result.tools[0]?.name, "echo");
  assert.ok(typeof result.tokenCount === "number");
  assert.ok(result.tokenCount! > 0);
});

test("exportServerSnapshot preserves the raw export contract", async () => {
  const manager = createMockManager({
    listTools: async () => ({
      tools: [
        {
          name: "draw",
          description: "Draw a shape",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          _meta: { title: "Draw" },
        },
      ],
    }),
    listResources: async () => ({
      resources: [
        {
          uri: "ui://widget",
          name: "Widget",
          description: "UI widget",
          mimeType: "text/html",
        },
      ],
    }),
    listResourceTemplates: async () => ({
      resourceTemplates: [
        {
          uriTemplate: "note://{id}",
          name: "Note",
          description: "Note template",
          mimeType: "text/plain",
        },
      ],
    }),
    listPrompts: async () => ({
      prompts: [
        {
          name: "prompt-1",
          description: "Prompt",
          arguments: [{ name: "id" }],
        },
      ],
    }),
    getInitializationInfo: () => ({ protocolVersion: "2025-11-25" }),
    getServerCapabilities: () => ({ tools: {}, resources: {} }),
  });

  const result = await exportServerSnapshot(
    manager,
    "srv",
    "https://example.com/mcp",
  );

  assert.equal(result.target, "https://example.com/mcp");
  assert.ok("exportedAt" in result);
  assert.ok(typeof (result as { exportedAt: string }).exportedAt === "string");
  assert.deepEqual(result.initInfo, { protocolVersion: "2025-11-25" });
  assert.deepEqual(result.capabilities, { tools: {}, resources: {} });
  assert.deepEqual(result.toolsMetadata, { draw: { title: "Draw" } });
  assert.equal(result.tools[0]?.name, "draw");
  assert.equal(result.resources[0]?.uri, "ui://widget");
  assert.equal(result.resourceTemplates[0]?.uriTemplate, "note://{id}");
  assert.equal(result.prompts[0]?.name, "prompt-1");
});

test("exportServerSnapshot supports the stable snapshot mode", async () => {
  const manager = createMockManager({
    listTools: async () => ({
      tools: [
        {
          name: "zeta",
          description: "Zeta tool",
          _meta: { z: true, a: true },
        },
        {
          name: "alpha",
          description: "Alpha tool",
        },
      ],
      nextCursor: undefined,
    }),
    listResources: async () => ({
      resources: [{ uri: "file:///z.txt" }, { uri: "file:///a.txt" }],
      nextCursor: undefined,
    }),
    listResourceTemplates: async () => ({
      resourceTemplates: [],
      nextCursor: undefined,
    }),
    listPrompts: async () => ({
      prompts: [{ name: "zeta" }, { name: "alpha" }],
      nextCursor: undefined,
    }),
  });

  const result = await exportServerSnapshot(
    manager,
    "srv",
    "https://example.com/mcp",
    { mode: "stable" },
  );

  assert.equal((result as any).kind, "server-snapshot");
  assert.equal((result as any).schemaVersion, 1);
  assert.equal("exportedAt" in result, false);
  assert.deepEqual(
    result.tools.map((tool: { name: string }) => tool.name),
    ["alpha", "zeta"],
  );
  assert.deepEqual(
    result.resources.map((resource: { uri: string }) => resource.uri),
    ["file:///a.txt", "file:///z.txt"],
  );
  assert.deepEqual(
    result.prompts.map((prompt: { name: string }) => prompt.name),
    ["alpha", "zeta"],
  );
  assert.deepEqual(result.toolsMetadata, { zeta: { a: true, z: true } });
});
