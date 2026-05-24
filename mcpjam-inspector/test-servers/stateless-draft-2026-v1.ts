/**
 * Fixture HTTP server for the DRAFT-2026-v1 stateless transport preview.
 * Stands up a minimal "spec-conforming enough" target so unit + integration
 * tests can exercise `StatelessDraft2026V1PreviewClient` without an
 * external dependency.
 *
 * What it implements (per `peppy-popping-flask.md` PR2 prerequisite):
 *   - Accepts POSTs without `initialize` / `Mcp-Session-Id`.
 *   - Validates body `_meta.io.modelcontextprotocol/protocolVersion ===
 *     "DRAFT-2026-v1"` — rejects with `-32004` + `data.supported:
 *     ["DRAFT-2026-v1"]`.
 *   - Validates required headers match body case-insensitively
 *     (RFC 9110) — rejects with `-32001 HeaderMismatch`.
 *   - Surfaces one plain tool and one annotated tool (`x-mcp-header:
 *     Region` on `region`). Honors `ttlMs` per SEP-2549.
 *   - Test-only mode (constructor flag) returns `mcp-session-id: foo` on
 *     every response — for asserting preview warn + discard + non-conf.
 *   - Responds to `tools/list`, `tools/call`, `resources/list`,
 *     `resources/read`, `prompts/list`, `prompts/get`, `ping`.
 *
 * What it intentionally does NOT implement (out of scope per plan):
 *   - SSE `tools/list_changed` long-lived stream.
 *   - `server/discover`, MRTR, subscriptions/listen.
 *   - Pagination — tests assert single-page behavior, and the preview
 *     fails loud on pagination during header discovery.
 *
 * Run as a standalone process for ad-hoc testing:
 *   npx tsx test-servers/stateless-draft-2026-v1.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const DRAFT_2026_V1 = "DRAFT-2026-v1";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";

export interface StatelessDraft2026V1FixtureOptions {
  /** Emit `mcp-session-id` on every response — asserts preview warn/discard. */
  emitSessionId?: boolean;
  /** Override `ttlMs` returned in `tools/list`. Default 60_000. */
  toolsListTtlMs?: number;
  /** Host to bind. Defaults to 127.0.0.1. */
  host?: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: {
    name?: string;
    uri?: string;
    arguments?: Record<string, unknown>;
    cursor?: string;
    _meta?: Record<string, unknown>;
  };
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

interface JsonRpcResult {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

export function startStatelessDraft2026V1Fixture(
  port = 0,
  opts: StatelessDraft2026V1FixtureOptions = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  const ttlMs = opts.toolsListTtlMs ?? 60_000;
  const host = opts.host ?? "127.0.0.1";

  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      respondHttpError(res, 405, "POST only");
      return;
    }

    const body = await readJsonBody(req);
    if (!isJsonRpcRequest(body)) {
      respondJsonRpcError(res, null, -32600, "Invalid Request", undefined, opts);
      return;
    }

    // 1. Validate _meta protocolVersion.
    const meta = (body.params?._meta ?? {}) as Record<string, unknown>;
    if (meta[PROTOCOL_VERSION_META_KEY] !== DRAFT_2026_V1) {
      respondJsonRpcError(
        res,
        body.id,
        -32004,
        "Unsupported protocol version",
        { supported: [DRAFT_2026_V1] },
        opts,
      );
      return;
    }

    // 2. Validate MCP-Protocol-Version header matches.
    const headerVersion = headerLookup(req, "mcp-protocol-version");
    if (headerVersion !== DRAFT_2026_V1) {
      respondJsonRpcError(
        res,
        body.id,
        -32001,
        "HeaderMismatch",
        {
          field: "MCP-Protocol-Version",
          expected: DRAFT_2026_V1,
          got: headerVersion ?? null,
        },
        opts,
      );
      return;
    }

    // 3. Validate Mcp-Method matches body.
    const headerMethod = headerLookup(req, "mcp-method");
    if (headerMethod !== body.method) {
      respondJsonRpcError(
        res,
        body.id,
        -32001,
        "HeaderMismatch",
        { field: "Mcp-Method", expected: body.method, got: headerMethod ?? null },
        opts,
      );
      return;
    }

    // 4. For Mcp-Name-bearing methods, validate header matches body.
    if (
      body.method === "tools/call" ||
      body.method === "resources/read" ||
      body.method === "prompts/get"
    ) {
      const expected =
        body.method === "resources/read"
          ? body.params?.uri
          : body.params?.name;
      const headerName = headerLookup(req, "mcp-name");
      if (expected !== undefined && headerName !== expected) {
        respondJsonRpcError(
          res,
          body.id,
          -32001,
          "HeaderMismatch",
          { field: "Mcp-Name", expected, got: headerName ?? null },
          opts,
        );
        return;
      }
    }

    // 5. Dispatch.
    try {
      const result = await dispatch(body, req, ttlMs);
      respondJsonRpcResult(res, body.id, result, opts);
    } catch (err) {
      if (err instanceof HeaderMismatchError) {
        respondJsonRpcError(
          res,
          body.id,
          -32001,
          "HeaderMismatch",
          { detail: err.message },
          opts,
        );
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      respondJsonRpcError(res, body.id, -32603, message, undefined, opts);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort =
        typeof address === "object" && address !== null ? address.port : port;
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((resolveClose) =>
            server.close(() => resolveClose()),
          ),
      });
    });
  });
}

async function dispatch(
  req: JsonRpcRequest,
  httpReq: IncomingMessage,
  ttlMs: number,
): Promise<unknown> {
  switch (req.method) {
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: [
          {
            name: "echo",
            description: "Echo the input string back.",
            inputSchema: {
              type: "object",
              properties: {
                value: { type: "string" },
              },
              required: ["value"],
            },
          },
          {
            name: "regional-echo",
            description: "Echo, with Mcp-Param-Region header conveyance.",
            inputSchema: {
              type: "object",
              properties: {
                value: { type: "string" },
                region: { type: "string", "x-mcp-header": "Region" },
              },
              required: ["value"],
            },
          },
        ],
        ttlMs,
      };
    case "tools/call": {
      const name = req.params?.name;
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      if (name === "echo") {
        return {
          content: [
            { type: "text", text: String(args.value ?? "") },
          ],
        };
      }
      if (name === "regional-echo") {
        // SEP-2243 mirror contract: when a param is annotated with
        // `x-mcp-header`, the client MUST send the value both in the
        // body AND in the header. The fixture asserts mirroring so a
        // client that strips the body slot (the original preview bug)
        // fails loudly here rather than silently producing a "looks
        // ok" echo response.
        const region = headerLookup(httpReq, "mcp-param-region");
        const bodyRegion = args.region;
        if (region === undefined && bodyRegion === undefined) {
          // Both absent: param wasn't supplied at all. Allowed —
          // schema's `required` field controls strictness.
          return {
            content: [{ type: "text", text: JSON.stringify({ value: args.value ?? null, region: null }) }],
          };
        }
        // Mirror semantics: decoded header value must equal the body
        // value when both are present. We only test ASCII primitives
        // in the fixture, so a string-equality check is exact.
        const decoded = decodeHeaderValue(region);
        if (decoded === undefined || bodyRegion === undefined ||
            String(bodyRegion) !== decoded) {
          // Surface as a JSON-RPC error so tests see the contract
          // violation directly. Mirrors how a draft-conforming server
          // would respond with -32001 when headers don't match body.
          throw new HeaderMismatchError(
            `Mcp-Param-Region (${region ?? "<absent>"}) must mirror params.arguments.region (${
              bodyRegion === undefined ? "<absent>" : JSON.stringify(bodyRegion)
            })`,
          );
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                value: args.value ?? null,
                region: decoded,
              }),
            },
          ],
        };
      }
      throw new Error(`Unknown tool "${name}"`);
    }
    case "resources/list":
      return {
        resources: [
          { uri: "test://hello", name: "hello", mimeType: "text/plain" },
        ],
      };
    case "resources/read":
      return {
        contents: [
          {
            uri: req.params?.uri,
            mimeType: "text/plain",
            text: `read:${req.params?.uri}`,
          },
        ],
      };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "prompts/list":
      return {
        prompts: [{ name: "greet", description: "Say hi" }],
      };
    case "prompts/get":
      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text: `prompt:${req.params?.name}` },
          },
        ],
      };
    default:
      throw new Error(`Method "${req.method}" not implemented in fixture`);
  }
}

function respondJsonRpcResult(
  res: ServerResponse,
  id: number | string,
  result: unknown,
  opts: StatelessDraft2026V1FixtureOptions,
): void {
  const payload: JsonRpcResult = { jsonrpc: "2.0", id, result };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.emitSessionId) headers["Mcp-Session-Id"] = "foo";
  res.writeHead(200, headers);
  res.end(JSON.stringify(payload));
}

function respondJsonRpcError(
  res: ServerResponse,
  id: number | string | null,
  code: number,
  message: string,
  data: unknown,
  opts: StatelessDraft2026V1FixtureOptions,
): void {
  const payload: JsonRpcError = {
    jsonrpc: "2.0",
    id,
    error: data !== undefined ? { code, message, data } : { code, message },
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.emitSessionId) headers["Mcp-Session-Id"] = "foo";
  // JSON-RPC errors over HTTP still return 200 — the JSON envelope
  // carries the error code. Mirror upstream Streamable HTTP behavior.
  res.writeHead(200, headers);
  res.end(JSON.stringify(payload));
}

function respondHttpError(
  res: ServerResponse,
  status: number,
  message: string,
): void {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(message);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    typeof (value as { method?: unknown }).method === "string" &&
    "id" in (value as Record<string, unknown>)
  );
}

function headerLookup(
  req: IncomingMessage,
  nameLower: string,
): string | undefined {
  const v = req.headers[nameLower];
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Sentinel for the dispatcher to surface header/body mismatches as
 * `-32001 HeaderMismatch` (SEP-2243). Plain string error → -32603;
 * this class keeps the boundary explicit.
 */
class HeaderMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeaderMismatchError";
  }
}

/**
 * Decode a SEP-2243 `Mcp-Param-*` header value. Plain ASCII passes
 * through verbatim; the `=?base64?<payload>?=` envelope is unwrapped
 * and UTF-8-decoded. Returns `undefined` for missing / malformed
 * envelopes — the caller treats that as a mirror failure.
 */
function decodeHeaderValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const m = raw.match(/^=\?base64\?([^?]*)\?=$/);
  if (!m) return raw;
  try {
    return Buffer.from(m[1], "base64").toString("utf-8");
  } catch {
    return undefined;
  }
}

// Stand-alone runner: `npx tsx test-servers/stateless-draft-2026-v1.ts`
// Picks port 4040 by default; override with PORT env.
if (
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1]?.endsWith("stateless-draft-2026-v1.ts")
) {
  const port = Number(process.env.PORT ?? 4040);
  startStatelessDraft2026V1Fixture(port).then(({ port: bound }) => {
    // eslint-disable-next-line no-console
    console.log(`stateless-draft-2026-v1 fixture listening on ${bound}`);
  });
}
