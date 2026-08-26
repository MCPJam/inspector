/**
 * The MCP server the GitHub PR-check walking skeleton tests against.
 *
 * This file is the seed for the public repo `mcpjam/mcp-check-fixture` (see the
 * README next to it). It exists so the check pipeline can be exercised
 * end-to-end against something we control: a deliberately boring,
 * deterministic, dependency-free streamable-HTTP MCP server.
 *
 * Two properties are load-bearing for the check pipeline and must not be
 * "cleaned up":
 *
 *   1. It listens on 3001, the exact port the check recipe declares ($PORT is
 *      a local-run convenience only; the check worker sets no override, so
 *      relying on it in CI would probe a port nobody listens on).
 *      The bind address is NOT load-bearing — E2B's bridge proxies
 *      from inside the box and reaches loopback-bound servers too
 *      (e2e-verified) — but the PORT is: listening anywhere else reports
 *      `server_unhealthy`.
 *   2. It answers `initialize` immediately on `/mcp`. That handshake IS the
 *      health probe — the worker polls it until it succeeds, so anything that
 *      delays it (a warm-up, a lazy route mount) shows up as an unhealthy
 *      server.
 *
 * The tools are intentionally trivial and side-effect-free: the eval suite's job
 * here is to prove the pipeline works, not to be an interesting test.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

const PORT = Number(process.env.PORT ?? 3001);
/** All interfaces. Not required by the bridge (see property 1) — kept because
 *  it is the least surprising default for a fixture people copy from. */
const HOST = "0.0.0.0";
const MCP_PATH = "/mcp";
const PROTOCOL_VERSION = "2025-06-18";
/** Bound on the request body; nothing here needs a large one. */
const MAX_BODY_BYTES = 256 * 1024;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const TOOLS = [
  {
    name: "echo",
    description: "Return the text you pass in, unchanged.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo." } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "add",
    description: "Add two numbers and return the sum.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First addend." },
        b: { type: "number", description: "Second addend." },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
  },
  {
    name: "server_info",
    description:
      "Return this fixture server's name and version. Takes no arguments.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
] as const;

function textResult(text: string) {
  return { content: [{ type: "text", text }] };
}

function callTool(
  name: string,
  args: Record<string, unknown>,
): { result?: unknown; error?: { code: number; message: string } } {
  switch (name) {
    case "echo": {
      const text = args?.text;
      if (typeof text !== "string") {
        return { error: { code: -32602, message: "`text` must be a string" } };
      }
      return { result: textResult(text) };
    }
    case "add": {
      const { a, b } = args ?? {};
      if (typeof a !== "number" || typeof b !== "number") {
        return {
          error: { code: -32602, message: "`a` and `b` must be numbers" },
        };
      }
      return { result: textResult(String(a + b)) };
    }
    case "server_info":
      return {
        result: textResult(
          JSON.stringify({ name: "mcp-check-fixture", version: "1.0.0" }),
        ),
      };
    default:
      return { error: { code: -32601, message: `Unknown tool: ${name}` } };
  }
}

/**
 * A well-formed MCP message: a request WITH an id, or a notification WITHOUT
 * one.
 *
 * The whole envelope is checked, not just `method`, because this fixture is the
 * control for the check pipeline: if it accepts sloppier input than the spec
 * allows, a PR whose server is equally sloppy passes its check. MCP is stricter
 * than bare JSON-RPC 2.0 here — a request MUST carry a string or integer id
 * (never `null`), and a notification MUST NOT carry one at all, since any
 * message with an `id` field is by definition a request.
 */
function isRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as JsonRpcRequest & { id?: unknown };
  if (candidate.jsonrpc !== "2.0") return false;
  if (typeof candidate.method !== "string") return false;

  if (isNotificationMethod(candidate.method)) {
    return !("id" in candidate);
  }
  return isValidRpcId(candidate.id);
}

/** Notifications are exactly the `notifications/*` methods. */
function isNotificationMethod(method: string): boolean {
  return method.startsWith("notifications/");
}

/** A legal request id: a string, or an integer-valued number. Never `null`. */
function isValidRpcId(id: unknown): boolean {
  if (typeof id === "string") return true;
  return typeof id === "number" && Number.isInteger(id);
}

function invalidRequest(value: unknown): { status: number; body?: unknown } {
  // Echo the id only when it is a legal JSON-RPC id. A malformed request can
  // carry anything here (an object, NaN), and reflecting that produces a
  // response a strict client will itself reject — `null` is what the spec asks
  // for when the id cannot be determined.
  const candidate =
    typeof value === "object" && value !== null
      ? (value as { id?: unknown }).id
      : null;
  const id =
    typeof candidate === "string" ||
    (typeof candidate === "number" && Number.isFinite(candidate))
      ? candidate
      : null;
  return {
    status: 400,
    body: {
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "Invalid Request" },
    },
  };
}

function handleRpc(request: JsonRpcRequest): {
  status: number;
  body?: unknown;
} {
  switch (request.method) {
    case "initialize":
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            // `icons` is inline so the fixture needs no network, and orange so
            // a server-branded tool call is distinguishable at a glance from
            // the monochrome /mcp.svg placeholder.
            serverInfo: {
              name: "mcp-check-fixture",
              version: "1.0.0",
              icons: [
                {
                  src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%23e8590c'/%3E%3C/svg%3E",
                  mimeType: "image/svg+xml",
                },
              ],
            },
          },
        },
      };
    // Notifications carry no id and get no body — 202 per the transport.
    case "notifications/initialized":
      return { status: 202 };
    case "ping":
      return {
        status: 200,
        body: { jsonrpc: "2.0", id: request.id ?? null, result: {} },
      };
    case "tools/list":
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: { tools: TOOLS },
        },
      };
    case "tools/call": {
      const name = String(request.params?.name ?? "");
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
      const outcome = callTool(name, args);
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: request.id ?? null,
          ...(outcome.error
            ? { error: outcome.error }
            : { result: outcome.result }),
        },
      };
    }
    default:
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: {
            code: -32601,
            message: `Method not found: ${request.method ?? "(none)"}`,
          },
        },
      };
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );

  // A plain liveness endpoint, for humans. The CHECK's health probe is the MCP
  // `initialize` on /mcp, not this.
  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname !== MCP_PATH) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  if (req.method !== "POST") {
    // No server-initiated stream in this fixture.
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 413, { error: "Payload too large" });
    return;
  }

  let parsed: JsonRpcRequest | JsonRpcRequest[];
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  // Batches are legal on the wire; answer them so a client that sends one
  // doesn't look like a broken server.
  if (Array.isArray(parsed)) {
    // An EMPTY batch is itself an invalid request per JSON-RPC 2.0 — not a batch
    // of zero notifications. Answering 202 there would tell a client its
    // malformed payload was accepted.
    if (parsed.length === 0) {
      const { status, body } = invalidRequest(null);
      sendJson(res, status, body);
      return;
    }
    const bodies = parsed
      .map((entry) =>
        isRpcRequest(entry) ? handleRpc(entry) : invalidRequest(entry),
      )
      .filter((entry) => entry.body !== undefined)
      .map((entry) => entry.body);
    if (bodies.length === 0) {
      res.writeHead(202).end();
      return;
    }
    sendJson(res, 200, bodies);
    return;
  }

  // `JSON.parse` happily yields `null`, a number, or a string — none of which
  // have a `.method`. Dispatching those threw inside the request handler and
  // left the client hanging instead of getting a JSON-RPC error.
  const { status, body } = isRpcRequest(parsed)
    ? handleRpc(parsed)
    : invalidRequest(parsed);
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  sendJson(res, status, body);
});

server.listen(PORT, HOST, () => {
  // Log the LISTEN ADDRESS explicitly — the port is what matters (a port other
  // than the recipe's is the likely `server_unhealthy` cause; the bind address
  // is not, the bridge reaches loopback too). A failed health check reports the
  // tail of this log, and "listening on ..." is how you tell "never started"
  // from "started and never answered".
  //
  // Written straight to stdout: `console.log` is prohibited repository-wide, and
  // the inspector's logger cannot be imported here because this file is the seed
  // for a SEPARATE public repo and must stay dependency-free — its whole recipe is
  // `npm ci && npm run build` over nothing but typescript + @types/node, so that
  // import would not resolve once the file is copied out.
  process.stdout.write(
    `mcp-check-fixture listening on http://${HOST}:${PORT}${MCP_PATH}\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
