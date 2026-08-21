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
  const body = await new Promise<string>((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => resolve(text));
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

/** A request's JSON-RPC id, normalized to what an error response must echo. */
export function requestId(body: JsonRpcRequestBody): string | number | null {
  const id = body.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}
