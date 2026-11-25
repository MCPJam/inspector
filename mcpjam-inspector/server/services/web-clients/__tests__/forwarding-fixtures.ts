/**
 * Test doubles for the forwarding endpoint: an MCP server on a loopback port
 * that records exactly what reached it, and a vendor MCP client that speaks
 * to the endpoint the way claude.ai's does.
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hono } from "hono";

export type Received = {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

/** Headers a raw server sends that the vendor must never see through the endpoint. */
export const UPSTREAM_NOISE = {
  "x-powered-by": "fixture",
  "access-control-allow-origin": "*",
  "set-cookie": "fixture=1",
};
export const SESSION_ID = "fixture-session-1";

type Message = {
  id?: string | number;
  method?: string;
  params?: { name?: string; arguments?: { message?: string } };
};

function resultFor(message: Message): unknown {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      };
    case "server/discover":
      return {
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
        resultType: "complete",
      };
    case "tools/list":
      return {
        tools: [
          {
            name: "echo",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
            },
          },
        ],
      };
    default:
      return {
        content: [
          { type: "text", text: `echo: ${message.params?.arguments?.message}` },
        ],
      };
  }
}

const sse = (value: unknown) => `event: message\ndata: ${JSON.stringify(value)}\n\n`;

/**
 * Answers JSON, except `tools/call` for `stream` (SSE with a progress
 * notification first) and `cut` (SSE that ends before the answer), and
 * `/redirect/<status>`, which sends any request on to `/mcp` (or to
 * `hooks.redirectTo`).
 */
export async function startFixtureServer() {
  const received: Received[] = [];
  const hooks: { onRedirect?: () => void; redirectTo?: string } = {};
  /** The raw bytes of the last SSE answer, to compare with what the vendor read. */
  let lastStream = "";
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      });
      for (const [name, value] of Object.entries(UPSTREAM_NOISE))
        res.setHeader(name, value);
      const redirect = /^\/redirect\/(30[12378])$/.exec(req.url ?? "");
      if (redirect) {
        hooks.onRedirect?.();
        res
          .writeHead(Number(redirect[1]), {
            location: hooks.redirectTo ?? "/mcp",
          })
          .end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const parsed: Message | Message[] = JSON.parse(body.toString("utf8"));
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      const answers = messages
        .filter((message) => message.id !== undefined)
        .map((message) => ({
          jsonrpc: "2.0",
          id: message.id,
          result: resultFor(message),
        }));
      if (answers.length === 0) {
        res.writeHead(202).end();
        return;
      }
      const first = messages[0];
      if (!Array.isArray(parsed) && first?.method === "tools/call") {
        const name = first.params?.name;
        if (name === "stream" || name === "cut") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "mcp-session-id": SESSION_ID,
          });
          const progress = sse({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken: first.id, progress: 1, total: 2 },
          });
          lastStream =
            name === "stream" ? progress + sse(answers[0]) : progress;
          res.end(lastStream);
          return;
        }
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": SESSION_ID,
      });
      res.end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    redirectUrl: (status: number) =>
      `http://127.0.0.1:${port}/redirect/${status}`,
    received,
    hooks,
    lastStream: () => lastStream,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export const ORIGIN = "https://inspector.example.test";

/** claude.ai's MCP client, as the spike saw it: its own user agent and session, a bearer when it has one. */
export function vendorClient(
  app: Hono,
  options: {
    path: string;
    token?: string;
    protocolVersion?: string;
    /** The scheme and Host the request names; the Inspector's own by default. */
    origin?: string;
  },
) {
  let sessionId: string | undefined;
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const url = `${options.origin ?? ORIGIN}${options.path}`;
    const response = await app.request(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "user-agent": "Claude-User",
        "mcp-protocol-version": options.protocolVersion ?? "2025-11-25",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    return response;
  };
  return {
    post,
    initialize: () =>
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: { elicitation: {}, roots: {} },
          clientInfo: { name: "claude-ai", version: "0.1.0" },
        },
      }),
    initialized: () =>
      post({ jsonrpc: "2.0", method: "notifications/initialized" }),
    listTools: () => post({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    /** Raw text, so the test can check the bytes the server received. */
    callToolRaw: (id: number, name: string, message: string) =>
      `{"jsonrpc":"2.0", "id":${id},"method":"tools/call","params":{"name":${JSON.stringify(name)},"arguments":{"message":${JSON.stringify(message)}},"_meta":{"progressToken":${id},"claudecode/toolUseId":"toolu_${id}"}}}`,
  };
}
