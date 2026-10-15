import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import { createMrtrFixtureHandler } from "./support/mrtr-fixture.js";
import { toNodeHandler } from "@modelcontextprotocol/node";

describe("complete tools/call metadata on actual wire", () => {
  it("keeps legacy metadata-only options out of request transport options", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "metadata-fixture", version: "1" },
            }
          : body.method === "tools/list"
          ? { tools: [] }
          : body.method === "tools/call"
          ? (calls.push(body.params),
            { content: [{ type: "text", text: "ok" }] })
          : null;
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            ...(result
              ? { result }
              : { error: { code: -32601, message: "Not found" } }),
          })
        );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const manager = new MCPClientManager();
    try {
      await manager.connectToServer("fixture", {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
        mcpProtocolVersion: "2025-11-25",
      });
      await manager.executeTool(
        "fixture",
        "echo",
        { n: 0 },
        { metadata: { "example/nested": { list: [false, 0, "☀"] } } }
      );
      expect(calls).toEqual([
        {
          name: "echo",
          arguments: { n: 0 },
          _meta: { "example/nested": { list: [false, 0, "☀"] } },
        },
      ]);
    } finally {
      await manager.disconnectAllServers();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
  it("preserves metadata on both initial and continued modern legs", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const handler = createMrtrFixtureHandler();
    const server = http.createServer(
      toNodeHandler({
        fetch: async (request, context) => {
          if (request.method === "POST") {
            const body = await request.clone().json();
            if (body.method === "tools/call") calls.push(body.params);
          }
          return handler.fetch(request, context);
        },
      })
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const manager = new MCPClientManager();
    manager.setMrtrInputCollector("fixture", async () => ({
      q: { action: "accept", content: { answer: "yes" } },
    }));
    try {
      await manager.connectToServer("fixture", {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
        mcpProtocolVersion: "2026-07-28",
      });
      await manager.executeTool(
        "fixture",
        "confirm",
        { topic: "metadata" },
        { metadata: { "example/opaque": { zero: 0, no: false } } }
      );
      expect(calls).toHaveLength(2);
      for (const call of calls)
        expect(call._meta).toMatchObject({
          "example/opaque": { zero: 0, no: false },
        });
    } finally {
      await manager.disconnectAllServers();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
