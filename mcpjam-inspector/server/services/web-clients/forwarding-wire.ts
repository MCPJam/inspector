/**
 * The wire half of the forwarding endpoint: reading what the vendor's MCP
 * client sent without changing a byte, deciding what it asks the server to
 * run, and watching the server's answer go past without holding it back.
 */
import { deriveMirroredBodyValues, findMcpHeaderIssues } from "@mcpjam/sdk";
import {
  checkDuplicateKeys,
  NativeWireError,
} from "../../utils/harness/forwarding/native-wire.js";

/** Room for a tool call that carries a file; bounded so one request can't hold the process. */
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
/** What the observer holds to parse one JSON body or SSE event. The bytes pass through regardless. */
const MAX_OBSERVED_CHARS = 8 * 1024 * 1024;

export type RpcId = string | number;
export type RpcMessage = {
  jsonrpc: "2.0";
  id?: RpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};
export type RpcRequest = RpcMessage & { method: string; id: RpcId };
export type RpcBody = { batch: boolean; messages: RpcMessage[] };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRpcId(value: unknown): value is RpcId {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

export function isRequest(message: RpcMessage): message is RpcRequest {
  return typeof message.method === "string" && isRpcId(message.id);
}

/** A response to one of our requests: an id and a result or an error, no method. */
export function answerId(message: unknown): RpcId | undefined {
  return isRecord(message) &&
    message.method === undefined &&
    ("result" in message || "error" in message) &&
    isRpcId(message.id)
    ? message.id
    : undefined;
}

export async function readBodyBytes(
  request: Request,
  limit = MAX_REQUEST_BYTES,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new NativeWireError("request_too_large");
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks);
}

function checkMessage(value: unknown): RpcMessage {
  if (!isRecord(value) || value.jsonrpc !== "2.0")
    throw new NativeWireError("invalid_message");
  const message = value as RpcMessage;
  if (message.id !== undefined && message.id !== null && !isRpcId(message.id))
    throw new NativeWireError("invalid_id");
  if (message.method === undefined) {
    if ("result" in value === "error" in value || !isRpcId(message.id))
      throw new NativeWireError("invalid_response");
    return message;
  }
  if (typeof message.method !== "string")
    throw new NativeWireError("invalid_method");
  if ("result" in value || "error" in value)
    throw new NativeWireError("ambiguous_message");
  if (message.method.startsWith("notifications/")) {
    if ("id" in value) throw new NativeWireError("notification_has_id");
  } else if (!isRpcId(message.id)) {
    // Without an id a `tools/call` would be a notification nobody answers.
    throw new NativeWireError("request_requires_id");
  }
  return message;
}

/**
 * Reads the vendor's body strictly. The gate decides on what the server will
 * run, so a body two parsers could read differently (invalid UTF-8, a
 * repeated key) or whose `Mcp-Method`/`Mcp-Name` headers disagree with it is
 * refused rather than forwarded.
 */
export function parseRpcBody(bytes: Uint8Array, headers: Headers): RpcBody {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new NativeWireError("invalid_json");
  }
  checkDuplicateKeys(text);
  const batch = Array.isArray(value);
  const messages = Array.isArray(value)
    ? value.map(checkMessage)
    : [checkMessage(value)];
  if (messages.length === 0) throw new NativeWireError("empty_batch");
  const ids = messages.filter(isRequest).map((message) => message.id);
  if (new Set(ids).size !== ids.length)
    throw new NativeWireError("duplicate_id");
  if (!batch) {
    const values: Record<string, string> = {};
    headers.forEach((headerValue, name) => {
      values[name] = headerValue;
    });
    const issues = findMcpHeaderIssues(values, deriveMirroredBodyValues(text));
    if (
      issues.some(
        (issue) => issue.kind === "mismatch" || issue.kind === "undecodable",
      )
    )
      throw new NativeWireError("header_mismatch");
  }
  return { batch, messages };
}

/** Where the first complete SSE event ends (after its blank line), once it has. */
function eventEnd(text: string): number | undefined {
  let lineStart = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char !== "\n" && char !== "\r") continue;
    // A trailing CR may be the first half of a CRLF still in flight.
    if (char === "\r" && i + 1 === text.length) return undefined;
    const next = char === "\r" && text[i + 1] === "\n" ? i + 2 : i + 1;
    if (i === lineStart) return next;
    lineStart = next;
    i = next - 1;
  }
  return undefined;
}

function eventData(event: string): string {
  return event
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
}

export type BodyKind = "json" | "sse" | "other";

export function bodyKind(contentType: string | null): BodyKind {
  const media = contentType?.split(";")[0]?.trim().toLowerCase();
  if (media === "text/event-stream") return "sse";
  return media === "application/json" ? "json" : "other";
}

/**
 * Passes the upstream's bytes through unchanged and hands every JSON-RPC
 * message in them to `onMessage` before the chunk that carries it is
 * released, so the ledger is settled by the time the vendor reads the
 * answer. `onEnd` runs once, however the stream ends.
 */
export function observeBody(args: {
  body: ReadableStream<Uint8Array>;
  kind: BodyKind;
  onMessage: (message: unknown) => void;
  onEnd: () => void;
}): ReadableStream<Uint8Array> {
  const reader = args.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let observing = args.kind !== "other";
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    args.onEnd();
  };
  const emit = (data: string) => {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      // Not JSON-RPC: the bytes still go through, there is just nothing to record.
      return;
    }
    for (const message of Array.isArray(value) ? value : [value])
      args.onMessage(message);
  };
  const take = (text: string, done: boolean) => {
    if (!observing) return;
    pending += text;
    if (args.kind === "json") {
      if (done) emit(pending);
    } else {
      let boundary = eventEnd(pending);
      while (boundary !== undefined) {
        const data = eventData(pending.slice(0, boundary));
        pending = pending.slice(boundary);
        if (data) emit(data);
        boundary = eventEnd(pending);
      }
    }
    // Too large to keep in hand: stop reading it, keep passing it on.
    if (pending.length > MAX_OBSERVED_CHARS) {
      observing = false;
      pending = "";
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        end();
        controller.error(error);
        return;
      }
      if (chunk.done) {
        take(decoder.decode(), true);
        end();
        controller.close();
        return;
      }
      take(decoder.decode(chunk.value, { stream: true }), false);
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      end();
      await reader.cancel(reason);
    },
  });
}
