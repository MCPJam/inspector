import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { OfficialSdkClientAdapter } from "../src/mcp-client-manager/official-sdk-client-adapter.js";
import { LogLevelMetaClient } from "../src/mcp-client-manager/log-level-meta-client.js";
import { TraceContextMetaClient } from "../src/mcp-client-manager/trace-context-meta-client.js";

describe("injected extension request schemas over a legacy wire", () => {
  it("preserves validated extension data through both decorators and rejects invalid params", async () => {
    const server = new Server({
      name: "disposable-extension-fixture",
      version: "0.0.0",
    });
    const client = new Client(
      { name: "fixture-host", version: "0.0.0" },
      {
        supportedProtocolVersions: ["2025-11-25"],
        capabilities: { extensions: { "fixture/elicitation": { form: {} } } },
      }
    );
    const schemas = {
      params: z
        .object({
          message: z.string(),
          requestedSchema: z.record(z.string(), z.unknown()),
        })
        .passthrough(),
      result: z.object({
        action: z.literal("accept"),
        content: z.record(z.string(), z.unknown()),
      }),
    };
    const handler = vi.fn(async (request) => ({
      action: "accept",
      content: { message: request.params.message },
    }));
    const adapter = new TraceContextMetaClient(
      new LogLevelMetaClient(
        new OfficialSdkClientAdapter(client),
        () => undefined
      ),
      () => undefined
    );
    adapter.setRequestHandler("fixture/elicitation/create", handler, schemas);
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(a), adapter.connect(b)]);
      const params = {
        message: "Rich form",
        requestedSchema: {
          type: "object",
          properties: { file: { "x-fixture-input": { type: "resource" } } },
        },
        _meta: { unknown: { preserved: true } },
      };
      const result = await server.request(
        { method: "fixture/elicitation/create", params },
        schemas.result
      );
      expect(result).toEqual({
        action: "accept",
        content: { message: "Rich form" },
      });
      expect(handler.mock.calls[0][0]).toEqual({
        method: "fixture/elicitation/create",
        params,
      });
      await expect(
        server.request(
          {
            method: "fixture/elicitation/create",
            params: { ...params, message: 42 },
          },
          schemas.result
        )
      ).rejects.toMatchObject({ code: -32602 });
      expect(handler).toHaveBeenCalledTimes(1);
      adapter.removeRequestHandler("fixture/elicitation/create");
      await expect(
        server.request(
          { method: "fixture/elicitation/create", params },
          schemas.result
        )
      ).rejects.toMatchObject({ code: -32601 });
    } finally {
      await Promise.allSettled([server.close(), adapter.close()]);
    }
  });
});
