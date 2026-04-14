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
    listResources: async () => ({ resources: [] }),
    listPrompts: async () => ({ prompts: [] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
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

test("exportServerSnapshot includes capabilities, metadata, and templates", async () => {
  const manager = createMockManager({
    listTools: async () => ({
      tools: [
        {
          name: "draw",
          description: "Draw a shape",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
      ],
    }),
    getAllToolsMetadata: () => ({ draw: { title: "Draw" } }),
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

  const result = await exportServerSnapshot(manager, "srv", "https://example.com/mcp");

  assert.equal(result.target, "https://example.com/mcp");
  assert.deepEqual(result.initInfo, { protocolVersion: "2025-11-25" });
  assert.deepEqual(result.capabilities, { tools: {}, resources: {} });
  assert.deepEqual(result.toolsMetadata, { draw: { title: "Draw" } });
  assert.equal(result.tools[0]?.name, "draw");
  assert.equal(result.resources[0]?.uri, "ui://widget");
  assert.equal(result.resourceTemplates[0]?.uriTemplate, "note://{id}");
  assert.equal(result.prompts[0]?.name, "prompt-1");
});

