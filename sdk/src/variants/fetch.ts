/**
 * Serves a variant by passing every request through to its base server.
 *
 * Each request reaches `baseFetch` exactly as it came: method, URL, headers
 * (credentials included), body and signal. Only the responses to the
 * JSON-RPC `tools/list` requests in a POST body are rewritten, matched by
 * their ids, in `application/json` and `text/event-stream` alike. Every other
 * response is the base's own, still streaming.
 */

import { createToolsPageOverlay, isRecord } from "./overlay.js";
import { rewriteSseEvents } from "./sse.js";
import type { VariantDefinition } from "./types.js";

type RequestId = string | number;
/** The `tools/list` requests in one POST: id → the cursor it asked for. */
type ToolsListRequests = Map<RequestId, string | undefined>;
type PageOverlay = ReturnType<typeof createToolsPageOverlay>;

export type CreateVariantFetchOptions = {
  baseFetch: typeof fetch;
  variant: Pick<VariantDefinition, "variantId" | "edits" | "toolHashes">;
};

export function createVariantFetch(
  options: CreateVariantFetchOptions
): typeof fetch {
  const overlay = createToolsPageOverlay(options.variant);
  const variantFetch: typeof fetch = async (input, init) => {
    const requests = await toolsListRequests(input, init);
    const response = await options.baseFetch(input, init);
    if (!requests || !response.ok || !response.body) return response;
    const rewrite = (message: unknown) =>
      rewriteMessage(message, requests, overlay);
    const type = response.headers.get("content-type");
    switch (type?.split(";")[0]?.trim().toLowerCase()) {
      case "application/json": {
        const text = await response.text();
        const message = parseJson(text);
        const next = message === undefined ? undefined : await rewrite(message);
        return new Response(
          next === undefined ? text : JSON.stringify(next),
          rebuiltInit(response)
        );
      }
      case "text/event-stream": {
        const body = rewriteSseEvents(response.body, async (data) => {
          const message = parseJson(data);
          const next =
            message === undefined ? undefined : await rewrite(message);
          return next === undefined ? undefined : JSON.stringify(next);
        });
        return new Response(body, rebuiltInit(response));
      }
      default:
        return response;
    }
  };
  return variantFetch;
}

/** The `tools/list` requests in a POST body, or `undefined` when there are none. */
async function toolsListRequests(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<ToolsListRequests | undefined> {
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method.toUpperCase() !== "POST") return undefined;
  const text = await requestText(input, init);
  const message = text === undefined ? undefined : parseJson(text);
  const requests: ToolsListRequests = new Map();
  for (const entry of Array.isArray(message) ? message : [message]) {
    if (!isRecord(entry) || entry.method !== "tools/list") continue;
    if (typeof entry.id !== "string" && typeof entry.id !== "number") continue;
    const cursor = isRecord(entry.params) ? entry.params.cursor : undefined;
    requests.set(entry.id, typeof cursor === "string" ? cursor : undefined);
  }
  return requests.size > 0 ? requests : undefined;
}

/** The request body as text, read without consuming what is forwarded. */
async function requestText(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<string | undefined> {
  const body = init?.body;
  if (body === undefined || body === null) {
    return input instanceof Request ? input.clone().text() : undefined;
  }
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }
  if (body instanceof Blob) return body.text();
  if (body instanceof ReadableStream) {
    // Reading it would consume what the base must receive, and forwarding it
    // unread could serve the base's tools/list without the edits.
    throw new TypeError(
      "A variant server can't read a streamed request body, so it didn't send the request. Send the JSON-RPC body as text."
    );
  }
  // Form data and URL-encoded bodies can't carry JSON-RPC.
  return undefined;
}

/** `message` with its matched `tools/list` responses rewritten, or `undefined` if none were. */
async function rewriteMessage(
  message: unknown,
  requests: ToolsListRequests,
  overlay: PageOverlay
): Promise<unknown> {
  if (!Array.isArray(message)) {
    const next = await rewriteResponse(message, requests, overlay);
    return next === message ? undefined : next;
  }
  const next: unknown[] = [];
  for (const entry of message) {
    next.push(await rewriteResponse(entry, requests, overlay));
  }
  return next.some((entry, index) => entry !== message[index])
    ? next
    : undefined;
}

async function rewriteResponse(
  message: unknown,
  requests: ToolsListRequests,
  overlay: PageOverlay
): Promise<unknown> {
  // Only a response has a result. A server-to-client request can reuse the
  // same id from its own sequence, and has none.
  if (!isRecord(message) || !isRecord(message.result)) return message;
  const { id } = message;
  if ((typeof id !== "string" && typeof id !== "number") || !requests.has(id)) {
    return message;
  }
  const outcome = await overlay(message.result, requests.get(id));
  if (!outcome) return message;
  return "error" in outcome
    ? { jsonrpc: "2.0", id, error: outcome.error }
    : { ...message, result: outcome.result };
}

/** `undefined` for text that isn't JSON, which can't be a JSON-RPC message. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The base response's status and headers, minus a length the rebuilt body may not have. */
function rebuiltInit(response: Response): ResponseInit {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
  };
}
