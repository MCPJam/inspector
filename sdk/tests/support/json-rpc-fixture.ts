/**
 * Shared plumbing for hand-rolled JSON-RPC fixture servers.
 *
 * Hand-rolled servers exist because the defects under test are things a
 * conforming server framework will not emit on request: a `tools/list` with no
 * `ttlMs`, an envelope with `"id": null`, a header compared by exact string. But
 * every one of them has to survive the same hazard, and three of them got it
 * wrong independently before this file existed:
 *
 * THE CONFORMANCE RUN DELIBERATELY POSTS AN UNPARSEABLE BODY. The readiness lane
 * probes parse-error handling on every modern run. A fixture that calls
 * `JSON.parse` unguarded throws inside its `end` handler, the request never gets
 * a response, and every probe after it hangs to its timeout — a fixture bug that
 * reads as a product hang.
 *
 * {@link readJsonRpcBody} answers such a body the way JSON-RPC 2.0 says to
 * (`-32700`, `id: null` — the one case where a null id is required) and tells
 * the caller to stop.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export interface JsonRpcRequestBody {
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Collect and parse a JSON-RPC request body.
 *
 * Resolves to the parsed body, or `undefined` when the body was unparseable —
 * in which case a `-32700` response has already been written and the caller
 * must return without writing another.
 */
export async function readJsonRpcBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<JsonRpcRequestBody | undefined> {
  // Accumulate chunks and decode once: a multi-byte character split across two
  // chunks decodes to replacement characters under per-chunk stringification,
  // which would turn a valid body into a fabricated parse error.
  const body = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    // A socket that dies mid-body would otherwise leave this promise pending
    // forever, hanging the fixture instead of failing the test.
    req.on("error", () => resolve(""));
  });

  try {
    return JSON.parse(body) as JsonRpcRequestBody;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        // JSON-RPC 2.0 requires `null` here: the id genuinely could not be
        // detected. This is the case the wire-schema check exempts.
        id: null,
        error: { code: -32700, message: "Parse error" },
      }),
    );
    return undefined;
  }
}

/**
 * A request's JSON-RPC id, normalized to what an error response must echo.
 *
 * JSON-RPC 2.0: an error response's id "MUST be the same as the value of the id
 * member in the Request Object", and `null` is reserved for the case where
 * detecting it failed. A fixture that always answered `null` would train the
 * suite to accept a real violation — `wire-schema-valid` caught exactly that in
 * this repo's own mock server.
 *
 * Takes `unknown` so callers that never ran the body through
 * {@link readJsonRpcBody} can share the one implementation.
 */
export function requestId(body: unknown): string | number | null {
  const id = (body as { id?: unknown } | undefined)?.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}
