import { describe, expect, it, vi } from "vitest";
import type { MCPClientManager } from "@mcpjam/sdk";
import { enhancedMcpResponse, enhancedToolPolicy } from "../enhanced-mcp";
const app = {
  name: "change",
  inputSchema: { type: "object" },
  _meta: { ui: { visibility: ["app"] } },
};
const model = {
  name: "show",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
  _meta: { ui: { resourceUri: "ui://counter" } },
};
function manager() {
  return {
    getInitializationInfo: vi.fn(() => ({
      protocolVersion: "2026-07-28",
      serverCapabilities: { tools: {}, resources: {} },
    })),
    hasServer: vi.fn(() => true),
    listTools: vi.fn(async () => ({
      tools: [model, app],
      nextCursor: "next",
      _meta: { retained: true },
    })),
    executeTool: vi.fn(),
    readResource: vi.fn(),
  };
}
const signal = new AbortController().signal;
const message = (method: string, params: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0" as const,
  id: "request",
  method,
  params,
});
const args = (m: ReturnType<typeof manager>) => ({
  manager: m as unknown as MCPClientManager,
  serverId: "server",
  signal,
  respectVisibility: true,
});
describe("modern App delivery", () => {
  it("filters App-only tools, retains pagination/metadata, and refuses hidden calls", async () => {
    const m = manager();
    const settle = vi.fn();
    const response = await enhancedMcpResponse({
      ...args(m),
      message: message("tools/list", { cursor: "first" }),
      settle,
    });
    const delivered = await response.json();
    expect(delivered.result).toMatchObject({
      tools: [model],
      nextCursor: "next",
      _meta: { retained: true },
    });
    expect(delivered.result.tools).toHaveLength(1);
    expect(m.listTools).toHaveBeenCalledWith(
      "server",
      { cursor: "first" },
      { signal },
    );
    expect(
      JSON.parse(settle.mock.calls[0][0].resultJson).result.tools,
    ).toHaveLength(2);
    const policy = await enhancedToolPolicy(
      m as unknown as MCPClientManager,
      "server",
      message("tools/call", { name: "change" }),
      {
        mode: "default",
        known: ["show", "change"],
        denied: {},
        unknownTool: "allow",
      },
      true,
      signal,
    );
    expect(policy.denied.change).toEqual({
      reason: "denyList",
      classification: "unknown",
    });
  });
  it("settles and returns the complete error result with text, image, structured data and private metadata", async () => {
    const m = manager();
    const result = {
      content: [
        { type: "text", text: "state" },
        { type: "image", mimeType: "image/png", data: "AA==" },
      ],
      structuredContent: { count: 3 },
      _meta: { private: "widget-only" },
      isError: true,
    };
    m.executeTool.mockResolvedValue(result);
    const settle = vi.fn();
    const response = await enhancedMcpResponse({
      ...args(m),
      message: message("tools/call", { name: "show", arguments: {} }),
      settle,
    });
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: "request",
      result: { content: result.content, isError: true },
    });
    expect(settle).toHaveBeenCalledWith({
      outcome: "tool_error",
      resultJson: JSON.stringify({ jsonrpc: "2.0", id: "request", result }),
    });
    expect(m.executeTool).toHaveBeenCalledWith(
      "server",
      "show",
      {},
      { signal },
    );
  });
  it("uses the CLI protocol downstream and cancels App resource reads", async () => {
    const m = manager();
    m.readResource.mockResolvedValue({ contents: [] });
    const response = await enhancedMcpResponse({
      ...args(m),
      message: message("initialize", { protocolVersion: "2025-11-25" }),
    });
    expect((await response.json()).result.protocolVersion).toBe("2025-11-25");
    await enhancedMcpResponse({
      ...args(m),
      message: message("resources/read", { uri: "ui://counter" }),
    });
    expect(m.readResource).toHaveBeenCalledWith(
      "server",
      { uri: "ui://counter" },
      { signal },
    );
  });
  it("refuses legacy connections before executing", async () => {
    const m = manager();
    m.getInitializationInfo.mockReturnValue({
      protocolVersion: "2025-11-25",
      serverCapabilities: { tools: {}, resources: {} },
    });
    await expect(
      enhancedMcpResponse({
        ...args(m),
        message: message("tools/call", { name: "show" }),
      }),
    ).rejects.toThrow("stateless");
    expect(m.executeTool).not.toHaveBeenCalled();
  });
});
it("does not expose private metadata from legacy ChatGPT App tool metadata", async () => {
  const m = manager();
  m.listTools.mockResolvedValue({
    tools: [{ ...model, _meta: { "openai/outputTemplate": "ui://legacy" } }],
    nextCursor: "next",
    _meta: { retained: true },
  } as never);
  const original = {
    content: [{ type: "text", text: "visible" }],
    structuredContent: { secret: true },
    _meta: { private: "private-sentinel" },
  };
  m.executeTool.mockResolvedValue(original);
  const settle = vi.fn();
  const response = await enhancedMcpResponse({
    ...args(m),
    message: message("tools/call", { name: "show" }),
    settle,
  });
  expect(await response.json()).toEqual({
    jsonrpc: "2.0",
    id: "request",
    result: { content: original.content },
  });
  expect(settle.mock.calls[0][0].resultJson).toContain("private-sentinel");
});
