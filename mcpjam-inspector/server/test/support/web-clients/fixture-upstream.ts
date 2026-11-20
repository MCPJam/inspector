/**
 * A tiny MCP server over Streamable HTTP that records every request it
 * receives, so a test can assert what actually reached the project's server:
 * the method, the arguments, the `_meta` and the headers.
 *
 * JSON responses only, one tool (`echo`), no sessions. Enough for a vendor's
 * MCP client to initialize, list and call through the forwarding endpoint.
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export type UpstreamReceipt = {
  method: string;
  id?: string | number | null;
  params?: Record<string, unknown>;
  headers: IncomingHttpHeaders;
};

export type FixtureUpstream = {
  url: string;
  received: UpstreamReceipt[];
  close(): Promise<void>;
};

const ECHO_TOOL = {
  name: "echo",
  description: "Returns the message it was given.",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
};

export async function startFixtureUpstream(): Promise<FixtureUpstream> {
  const received: UpstreamReceipt[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id?: string | number | null;
      method: string;
      params?: Record<string, unknown>;
    };
    received.push({
      method: body.method,
      id: body.id,
      params: body.params,
      headers: request.headers,
    });
    if (body.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result = (() => {
      switch (body.method) {
        case "initialize":
          return {
            protocolVersion:
              (body.params?.protocolVersion as string | undefined) ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture-upstream", version: "1.0.0" },
          };
        case "tools/list":
          return { tools: [ECHO_TOOL] };
        case "tools/call": {
          const args = (body.params?.arguments ?? {}) as { message?: unknown };
          return {
            content: [{ type: "text", text: `echo: ${String(args.message)}` }],
          };
        }
        default:
          return undefined;
      }
    })();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        result === undefined
          ? { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } }
          : { jsonrpc: "2.0", id: body.id, result },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    received,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
