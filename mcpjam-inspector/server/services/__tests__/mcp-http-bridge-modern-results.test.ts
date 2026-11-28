/**
 * Results for a 2026-07-28 client carry `resultType`, and cacheable ones
 * `ttlMs` and `cacheScope`. MCPJam's client drops `resultType` when it
 * decodes the upstream's result, and Claude Code refuses a 2026-07-28 result
 * without it, so the bridge restores it.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MCPClientManager } from "@mcpjam/sdk";
import { handleJsonRpc } from "../mcp-http-bridge";
import { encodeModernResult, isModernRequest } from "../bridge-modern-result";

const MODERN = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };

async function modernServer() {
  const handler = createMcpHandler(() => {
    const mcp = new McpServer(
      { name: "modern-results-fixture", version: "1" },
      { capabilities: { tools: { listChanged: true } } },
    );
    mcp.registerTool("echo", {}, async () => ({
      content: [{ type: "text", text: "echo: hi" }],
    }));
    return mcp;
  });
  const server = http.createServer(toNodeHandler(handler));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function connected() {
  const served = await modernServer();
  cleanups.push(served.close);
  const manager = new MCPClientManager();
  cleanups.push(() => manager.disconnectAllServers());
  await manager.connectToServer("srv", { url: served.url, timeout: 5_000 });
  return manager;
}

const request = (method: string, params: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params,
});

describe("results for a 2026-07-28 client", () => {
  it("stamp resultType on a list, beside the upstream's cache fields", async () => {
    const response = await handleJsonRpc(
      "srv",
      request("tools/list", { _meta: MODERN }),
      await connected(),
      "adapter",
    );
    expect(response.result).toMatchObject({
      resultType: "complete",
      tools: [expect.objectContaining({ name: "echo" })],
    });
    expect(Number.isInteger(response.result.ttlMs)).toBe(true);
    expect(["public", "private"]).toContain(response.result.cacheScope);
  });

  it("stamp resultType on a tool result, with no cache fields", async () => {
    const response = await handleJsonRpc(
      "srv",
      request("tools/call", { _meta: MODERN, name: "echo", arguments: {} }),
      await connected(),
      "adapter",
    );
    expect(response.result).toMatchObject({
      resultType: "complete",
      content: [{ type: "text", text: "echo: hi" }],
    });
    expect(response.result.ttlMs).toBeUndefined();
  });

  it("fill missing cache fields with the spec's defaults", async () => {
    // A server whose list carries no cache fields.
    const manager = { listPrompts: async () => ({ prompts: [] }) };
    const response = await handleJsonRpc(
      "srv",
      request("prompts/list", { _meta: MODERN }),
      manager as never,
      "adapter",
    );
    expect(response.result).toMatchObject({
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "private",
    });
  });

  it("leave a 2025-era request's result as it was", async () => {
    const response = await handleJsonRpc(
      "srv",
      request("tools/list"),
      await connected(),
      "adapter",
    );
    expect(response.result.resultType).toBeUndefined();
  });
});

describe("encodeModernResult", () => {
  it("leaves a result that already names a non-complete type as it is", () => {
    const inputRequired = {
      resultType: "input_required",
      inputRequests: { a: {} },
    };
    expect(encodeModernResult("tools/call", inputRequired)).toBe(inputRequired);
  });

  it("replaces cache fields the spec would refuse", () => {
    expect(
      encodeModernResult("resources/read", {
        contents: [],
        ttlMs: -5,
        cacheScope: "everyone",
      }),
    ).toEqual({
      contents: [],
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "private",
    });
  });

  it("leaves anything that is not a result object alone", () => {
    expect(encodeModernResult("tools/list", null)).toBeNull();
    expect(encodeModernResult("tools/list", [1])).toEqual([1]);
  });
});

describe("isModernRequest", () => {
  it("reads the revision from the request's _meta, then from initialize", () => {
    expect(isModernRequest({ _meta: MODERN }, undefined)).toBe(true);
    expect(isModernRequest({}, "2026-07-28")).toBe(true);
    expect(isModernRequest({}, "2025-11-25")).toBe(false);
    expect(isModernRequest(undefined, undefined)).toBe(false);
  });
});
