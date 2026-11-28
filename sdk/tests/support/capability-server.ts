/**
 * A 2025-era server that only answers what it declared, for the checks that
 * send requests on a session of their own.
 *
 * `capabilities` is what its `initialize` answer declares. A listing it did
 * not declare is refused with HTTP 404 and JSON-RPC `-32601`, the way a server
 * without that feature answers. `ping` is always answered: it needs no
 * capability.
 *
 * One function from a request to a `Response`, used as a scripted `fetch` by
 * the unit tests and behind a socket by the integration tests.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface CapabilityServerOptions {
  /** The capabilities `initialize` declares. */
  capabilities: Record<string, unknown>;
  /** How a declared listing is answered. JSON by default. */
  listings?: "json" | "sse" | "broken-sse";
  /** How `ping` is answered. JSON by default. */
  ping?: "json" | "sse";
}

/** One line per request, in arrival order, e.g. `POST tools/list`, `DELETE`. */
export type CapabilityLog = string[];

const LISTINGS: Record<string, { capability: string; key: string }> = {
  "tools/list": { capability: "tools", key: "tools" },
  "prompts/list": { capability: "prompts", key: "prompts" },
  "resources/list": { capability: "resources", key: "resources" },
};

function json(status: number, body: unknown, headers = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function stream(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

export function createCapabilityServer(
  options: CapabilityServerOptions,
  log: CapabilityLog,
  /** The parsed body of each POST, in order, for a test that reads them. */
  bodies: Array<Record<string, unknown>> = []
): (request: {
  httpMethod: string;
  body?: Record<string, unknown>;
}) => Response {
  return ({ httpMethod, body }) => {
    if (httpMethod !== "POST" || body === undefined) {
      log.push(httpMethod);
      return new Response(null, { status: 405 });
    }
    const method = String(body.method ?? "");
    log.push(`POST ${method}`);
    bodies.push(body);
    const result = (payload: Record<string, unknown>) => ({
      jsonrpc: "2.0",
      id: body.id,
      result: payload,
    });

    if (method === "initialize") {
      const params = body.params as { protocolVersion?: string } | undefined;
      return json(
        200,
        result({
          protocolVersion: params?.protocolVersion ?? "2025-11-25",
          capabilities: options.capabilities,
          serverInfo: { name: "capability-fixture", version: "1" },
        }),
        { "Mcp-Session-Id": "session-1" }
      );
    }
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (method === "ping") {
      const answer = result({});
      return options.ping === "sse"
        ? stream(`data: ${JSON.stringify(answer)}\n\n`)
        : json(200, answer);
    }

    const listing = LISTINGS[method];
    const declared =
      listing !== undefined &&
      options.capabilities[listing.capability] !== undefined &&
      options.capabilities[listing.capability] !== null;
    if (!listing || !declared) {
      return json(404, {
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
    const answer = result({ [listing.key]: [] });
    if (options.listings === "sse") {
      return stream(`data: ${JSON.stringify(answer)}\n\n`);
    }
    if (options.listings === "broken-sse") {
      // A stream that opens and never delivers a complete event.
      return stream("data: {");
    }
    return json(200, answer);
  };
}

/** The capability server as a scripted `fetch`. */
export function capabilityServerFetch(
  options: CapabilityServerOptions,
  log: CapabilityLog,
  bodies: Array<Record<string, unknown>> = []
): typeof fetch {
  const server = createCapabilityServer(options, log, bodies);
  return async (_input, init) =>
    server({
      httpMethod: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
}

/** The capability server behind a real socket. */
export async function serveCapabilityServer(
  options: CapabilityServerOptions
): Promise<{ url: string; log: CapabilityLog; close: () => Promise<void> }> {
  const log: CapabilityLog = [];
  const answerFor = createCapabilityServer(options, log);
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    const answer = answerFor({
      httpMethod: req.method ?? "GET",
      body: text ? JSON.parse(text) : undefined,
    });
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    log,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
