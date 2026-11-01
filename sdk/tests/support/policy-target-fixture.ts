/**
 * A real MCP server on a loopback socket, shaped for tool-policy tests.
 *
 *   - `read_note`   — annotated `readOnlyHint: true`
 *   - `delete_note` — annotated `destructiveHint: true`
 *   - `echo`        — no annotations at all (an UNKNOWN classification)
 *
 * Every tool counts its executions, so a test asserts what actually reached
 * the server — a denied `delete_note` must leave its counter at zero — rather
 * than what the client believed it sent.
 *
 * `signIn` makes named tools refuse with a sign-in challenge: `unauthorized`
 * answers their `tools/call` with HTTP 401 and the given `WWW-Authenticate`
 * (the call never runs); `meta` makes the tool return `isError: true` with
 * the given `_meta["mcp/www_authenticate"]`.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export type PolicyTargetFixture = {
  url: string;
  calls: Record<string, number>;
  /** Every JSON-RPC method the server was asked for, in arrival order. */
  methods: string[];
  close: () => Promise<void>;
};

export async function servePolicyTargetFixture(
  options: {
    name?: string;
    extraTools?: string[];
    signIn?: {
      unauthorized?: Record<string, string>;
      meta?: Record<string, string>;
    };
  } = {}
): Promise<PolicyTargetFixture> {
  const calls: Record<string, number> = {
    read_note: 0,
    delete_note: 0,
    echo: 0,
  };
  for (const extra of options.extraTools ?? []) calls[extra] = 0;
  const methods: string[] = [];

  const build = () => {
    const server = new McpServer(
      { name: options.name ?? "policy-target-fixture", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    server.registerTool(
      "read_note",
      {
        description: "Read a note by id.",
        inputSchema: { id: z.string() },
        annotations: { readOnlyHint: true },
      },
      async (args) => {
        calls.read_note! += 1;
        return {
          content: [
            {
              type: "text" as const,
              text: `note ${String(args.id)}: buy milk`,
            },
          ],
        };
      }
    );
    server.registerTool(
      "delete_note",
      {
        description: "Delete a note by id.",
        inputSchema: { id: z.string() },
        annotations: { destructiveHint: true },
      },
      async (args) => {
        calls.delete_note! += 1;
        return {
          content: [
            { type: "text" as const, text: `deleted ${String(args.id)}` },
          ],
        };
      }
    );
    server.registerTool(
      "echo",
      {
        description: "Echo a message.",
        inputSchema: { message: z.string() },
      },
      async (args) => {
        calls.echo! += 1;
        return {
          content: [{ type: "text" as const, text: String(args.message) }],
        };
      }
    );
    for (const extra of options.extraTools ?? []) {
      server.registerTool(
        extra,
        { description: `Extra tool ${extra}.`, inputSchema: {} },
        async () => {
          calls[extra]! += 1;
          const challenge = options.signIn?.meta?.[extra];
          if (challenge !== undefined) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: "Sign in required." }],
              _meta: { "mcp/www_authenticate": [challenge] },
            };
          }
          return { content: [{ type: "text" as const, text: extra }] };
        }
      );
    }
    return server;
  };

  const handler = createMcpHandler(build);
  const fetchHandler = async (
    input: Request | string | URL,
    init?: RequestInit
  ) => {
    const request = input instanceof Request ? input : new Request(input, init);
    try {
      const body = (await request.clone().json()) as
        | { method?: unknown; params?: { name?: unknown } }
        | Array<{ method?: unknown; params?: { name?: unknown } }>;
      for (const message of Array.isArray(body) ? body : [body]) {
        if (typeof message?.method === "string") methods.push(message.method);
        const toolName = message?.params?.name;
        const challenge =
          message?.method === "tools/call" && typeof toolName === "string"
            ? options.signIn?.unauthorized?.[toolName]
            : undefined;
        if (challenge !== undefined) {
          return new Response(null, {
            status: 401,
            headers: { "WWW-Authenticate": challenge },
          });
        }
      }
    } catch {
      // Not JSON (a GET for the event stream); nothing to record.
    }
    return (handler.fetch as (request: Request) => Promise<Response>)(request);
  };
  const httpServer = http.createServer(
    toNodeHandler({ fetch: fetchHandler } as never)
  );
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve)
  );
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    methods,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      }),
  };
}
