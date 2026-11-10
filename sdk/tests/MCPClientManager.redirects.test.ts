/**
 * A server whose saved URL redirects to its real endpoint.
 *
 * `https://mcp.excalidraw.com/` answers every request with `308 → /mcp`. The
 * transport follows same-origin hops itself, calling the manager's fetch with
 * `redirect: "manual"`, so every layer under it sees the 308 before the hop is
 * taken. These tests run the three protected calls (`tools/call`,
 * `resources/read`, `prompts/get`) through that redirect on a real socket,
 * and pin what must still be refused: a redirect to another origin, and a
 * `301` that would turn the POST into a GET.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import { createPinnedStreamingFetch } from "../src/oauth/pinned-stream-fetch.js";

type JsonRpcBody = { id?: number; method: string };
type Seen = { path: string; method: string; authorization?: string };
type Route = (path: string, body: JsonRpcBody) => string | undefined;

const PROTOCOL_VERSION = "2025-11-25";
const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

function answer(body: JsonRpcBody) {
  switch (body.method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "redirect-fixture", version: "1" },
      };
    case "tools/list":
      return { tools: [] };
    case "tools/call":
      return { content: [{ type: "text", text: "drawn" }] };
    case "resources/read":
      return {
        contents: [
          { uri: "ui://fixture/app.html", mimeType: "text/html", text: "<p/>" },
        ],
      };
    case "prompts/get":
      return {
        messages: [{ role: "user", content: { type: "text", text: "hi" } }],
      };
    default:
      return undefined;
  }
}

/**
 * Serves MCP at `/mcp`. `route` names the `Location` to send instead, and
 * `redirectStatus` the status to send it with.
 */
async function startServer(
  route: Route,
  redirectStatus = 308
): Promise<{ origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as JsonRpcBody;
    const path = req.url ?? "/";
    seen.push({
      path,
      method: body.method,
      authorization: req.headers.authorization,
    });
    const location = route(path, body);
    if (location) {
      res
        .writeHead(redirectStatus, {
          location,
          "content-type": "application/json",
        })
        .end(JSON.stringify({ redirect: location }));
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (body.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result = answer(body);
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        ...(result
          ? { result }
          : { error: { code: -32601, message: "Method not found" } }),
      })
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  stops.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      })
  );
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, seen };
}

async function connect(
  url: string,
  extra: {
    baseFetch?: typeof fetch;
    requestInit?: RequestInit;
  } = {}
): Promise<MCPClientManager> {
  const manager = new MCPClientManager();
  stops.push(() => manager.disconnectAllServers());
  await manager.connectToServer("fixture", {
    url,
    mcpProtocolVersion: PROTOCOL_VERSION,
    ...extra,
  });
  return manager;
}

async function runProtectedCalls(manager: MCPClientManager) {
  return {
    tool: await manager.executeTool("fixture", "create_view", {}),
    resource: await manager.readResource("fixture", {
      uri: "ui://fixture/app.html",
    }),
    prompt: await manager.getPrompt("fixture", { name: "greet" }),
  };
}

const rootToMcp: Route = (path) => (path === "/" ? "/mcp" : undefined);

describe("MCPClientManager behind a redirecting URL", () => {
  it("follows a same-origin 308 for tools/call, resources/read and prompts/get", async () => {
    const { origin, seen } = await startServer(rootToMcp);
    const manager = await connect(`${origin}/`);

    const { tool, resource, prompt } = await runProtectedCalls(manager);

    expect(tool).toMatchObject({ content: [{ type: "text", text: "drawn" }] });
    expect(resource.contents[0]).toMatchObject({ uri: "ui://fixture/app.html" });
    expect(prompt.messages).toHaveLength(1);
    for (const method of ["tools/call", "resources/read", "prompts/get"]) {
      expect(
        seen.filter((entry) => entry.method === method).map((e) => e.path)
      ).toEqual(["/", "/mcp"]);
    }
  });

  it("dials every hop through the pinned fetch, so each one is egress-checked", async () => {
    const { origin } = await startServer(rootToMcp);
    const dialed: Array<{ url: string; rpc: string }> = [];
    const pinned = createPinnedStreamingFetch({ allowLoopback: true });
    const baseFetch = (async (input, init) => {
      dialed.push({
        url: String(input),
        rpc: JSON.parse(String(init?.body ?? "{}")).method ?? "",
      });
      return pinned(input, init);
    }) as typeof fetch;
    const manager = await connect(`${origin}/`, { baseFetch });

    await runProtectedCalls(manager);

    for (const rpc of ["tools/call", "resources/read", "prompts/get"]) {
      expect(
        dialed.filter((entry) => entry.rpc === rpc).map((entry) => entry.url)
      ).toEqual([`${origin}/`, `${origin}/mcp`]);
    }
  });

  it("refuses a redirect to another origin, naming it, without sending stored headers there", async () => {
    const target = await startServer(() => undefined);
    const redirector = await startServer((path) =>
      path === "/" ? `${target.origin}/mcp` : undefined
    );

    const error = await connect(`${redirector.origin}/`, {
      requestInit: { headers: { authorization: "Bearer stored-secret" } },
    }).catch((caught: unknown) => caught);

    expect(String(error)).toContain(
      `Redirect to ${target.origin}/mcp not followed`
    );
    expect(target.seen).toEqual([]);
  });

  it("refuses a 301 on a protected call, which would turn the POST into a GET", async () => {
    // Everything else is served where the client was pointed; only the tool
    // call is moved, so the refusal is the protected call's own.
    const { origin, seen } = await startServer(
      (path, body) =>
        path === "/mcp" && body.method === "tools/call" ? "/moved" : undefined,
      301
    );
    const manager = await connect(`${origin}/mcp`);

    await expect(
      manager.executeTool("fixture", "create_view", {})
    ).rejects.toThrow(`Redirect to ${origin}/moved not followed`);
    expect(seen.some((entry) => entry.path === "/moved")).toBe(false);
  });
});
