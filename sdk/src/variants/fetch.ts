/**
 * Serves a variant by passing every request to its base exactly as it came:
 * method, URL, headers (credentials included), body and signal. `tools/list`
 * requests in POST bodies are remembered until answered, and each answer is
 * rewritten on whichever stream carries it: a POST's reply, the GET stream,
 * or a stream resumed with `Last-Event-ID`. A page of tools that answers none
 * of them becomes `VARIANT_BASE_DRIFTED`. SSE still streams event by event.
 */

import {
  createToolsPageOverlay,
  isRecord,
  variantDriftError,
  type VariantDriftRpcError,
} from "./overlay.js";
import { rewriteSseEvents } from "./sse.js";
import type { VariantDefinition } from "./types.js";

/** Unanswered `tools/list` requests kept, at most. Older ones are forgotten. */
const MAX_PENDING_LISTS = 256;

export type CreateVariantFetchOptions = {
  baseFetch: typeof fetch;
  variant: Pick<VariantDefinition, "variantId" | "edits" | "toolHashes">;
};

/** What one variant fetch has asked for, and how it answers. */
type Serving = {
  /** Unanswered `tools/list` requests: id key → the cursor each asked for. */
  pending: Map<string, string | undefined>;
  overlay: ReturnType<typeof createToolsPageOverlay>;
  refusal: () => VariantDriftRpcError;
};

export function createVariantFetch(
  options: CreateVariantFetchOptions
): typeof fetch {
  const { variant } = options;
  const targets = variant.edits.map((edit) => edit.target);
  const serving: Serving = {
    pending: new Map(),
    overlay: createToolsPageOverlay(variant),
    refusal: () => variantDriftError(variant.variantId, [...targets]),
  };
  const rewrite = async (message: unknown) => {
    const next = await rewriteMessage(message, serving);
    return next === undefined ? undefined : JSON.stringify(next);
  };
  const variantFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (method === "POST") await rememberToolsLists(input, init, serving);
    const response = await options.baseFetch(input, init);
    if (!response.ok || !response.body) return response;
    const type = response.headers.get("content-type");
    const accept = new Headers(init?.headers ?? request?.headers).get("accept");
    // The client reads a GET it opened as SSE, whatever its content type says.
    if (
      mediaType(type) === "text/event-stream" ||
      (method === "GET" && accept?.includes("text/event-stream"))
    ) {
      const body = rewriteSseEvents(response.body, async (data) => {
        const message = parseJson(data);
        return message === undefined ? undefined : rewrite(message);
      });
      return new Response(body, rebuiltInit(response));
    }
    if (mediaType(type) !== "application/json") return response;
    const text = await response.text();
    const message = parseJson(text);
    const next = message === undefined ? undefined : await rewrite(message);
    return new Response(next ?? text, rebuiltInit(response));
  };
  return variantFetch;
}

/**
 * The MCP client matches a response to its request by `Number(id)`, so `"3"`
 * answers request 3. An id that isn't a number matches only itself.
 */
function idKey(id: unknown): string | undefined {
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  const number = Number(id);
  return Number.isNaN(number) ? `text:${id}` : `number:${number}`;
}

/** Remembers each `tools/list` request in a POST body until it is answered. */
async function rememberToolsLists(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  { pending }: Serving
): Promise<void> {
  const text = await requestText(input, init);
  const message = text === undefined ? undefined : parseJson(text);
  for (const entry of Array.isArray(message) ? message : [message]) {
    if (!isRecord(entry) || entry.method !== "tools/list") continue;
    const key = idKey(entry.id);
    if (key === undefined) continue;
    const cursor = isRecord(entry.params) ? entry.params.cursor : undefined;
    pending.delete(key);
    pending.set(key, typeof cursor === "string" ? cursor : undefined);
    const oldest = pending.keys().next();
    if (pending.size > MAX_PENDING_LISTS && !oldest.done)
      pending.delete(oldest.value);
  }
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
    // unread would leave a tools/list it carries unremembered.
    throw new TypeError(
      "A variant server can't read a streamed request body, so it didn't send the request. Send the JSON-RPC body as text."
    );
  }
  // Form data and URL-encoded bodies can't carry JSON-RPC.
  return undefined;
}

/** `message`, one or a batch, with its pages of tools rewritten, or `undefined` if none were. */
async function rewriteMessage(
  message: unknown,
  serving: Serving
): Promise<unknown> {
  const entries = Array.isArray(message) ? message : [message];
  const next: unknown[] = [];
  for (const entry of entries) next.push(await rewriteResponse(entry, serving));
  if (next.every((entry, index) => entry === entries[index])) return undefined;
  return Array.isArray(message) ? next : next[0];
}

/**
 * An answer to a remembered `tools/list` gets the overlay; any other page of
 * tools is refused. Requests and notifications, with no result or error, pass.
 */
async function rewriteResponse(
  message: unknown,
  serving: Serving
): Promise<unknown> {
  if (!isRecord(message) || !("result" in message || "error" in message)) {
    return message;
  }
  const key = idKey(message.id);
  const answers = key !== undefined && serving.pending.has(key);
  const cursor = key === undefined ? undefined : serving.pending.get(key);
  if (key !== undefined) serving.pending.delete(key);
  const { result } = message;
  if (!isRecord(result) || !Array.isArray(result.tools)) return message;
  const outcome = answers
    ? await serving.overlay(result, result.tools, cursor)
    : { error: serving.refusal() };
  return "error" in outcome
    ? { jsonrpc: "2.0", id: message.id, error: outcome.error }
    : { ...message, result: outcome.result };
}

function mediaType(header: string | null): string | undefined {
  return header?.split(";")[0]?.trim().toLowerCase();
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
  return { status: response.status, statusText: response.statusText, headers };
}
