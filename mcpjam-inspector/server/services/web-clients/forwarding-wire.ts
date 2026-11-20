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
import { logger } from "../../utils/logger.js";

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

/** A JSON-RPC 2.0 response to one of our requests: an id and exactly one of a result or an error. */
export function answerId(message: unknown): RpcId | undefined {
  return isRecord(message) &&
    message.jsonrpc === "2.0" &&
    message.method === undefined &&
    "result" in message !== "error" in message &&
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
      try {
        await reader.cancel();
      } catch {
        // The body is refused either way; a stream that already failed has nothing left to stop.
      }
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

/** Long enough that JSON.parse may round it: 16 digits, or an exponent of 100 or more. */
const LONG_NUMBER = /\d{16}|[eE]\+?\d{3}/;

/** Whether JSON.parse reads this number literal as another value. */
function rounds(source: string): boolean {
  const value = Number(source);
  if (!Number.isFinite(value)) return true;
  return (
    /^-?\d+$/.test(source) &&
    !Number.isSafeInteger(value) &&
    BigInt(source) !== BigInt(value)
  );
}

/**
 * Whether a tool call's arguments hold a number JSON.parse rounds. The gate
 * would approve and hash the rounded value, while a server that reads
 * integers exactly runs the one in the bytes.
 */
function roundsToolArguments(text: string): boolean {
  if (!LONG_NUMBER.test(text)) return false;
  // Every object or array with a rounded number somewhere inside it.
  const rounded = new WeakSet<object>();
  const value: unknown = JSON.parse(
    text,
    function (
      this: object,
      _key: string,
      parsed: unknown,
      context?: { source?: string },
    ) {
      const inside =
        typeof parsed === "number"
          ? context?.source === undefined || rounds(context.source)
          : typeof parsed === "object" &&
            parsed !== null &&
            rounded.has(parsed);
      if (inside) rounded.add(this);
      return parsed;
    },
  );
  return (Array.isArray(value) ? value : [value]).some(
    (message) =>
      isRecord(message) &&
      message.method === "tools/call" &&
      isRecord(message.params) &&
      typeof message.params.arguments === "object" &&
      message.params.arguments !== null &&
      rounded.has(message.params.arguments),
  );
}

/**
 * Reads the vendor's body strictly. The gate decides on what the server will
 * run, so a body two parsers could read differently (invalid UTF-8, a
 * repeated key, a tool argument JSON.parse rounds) or whose
 * `Mcp-Method`/`Mcp-Name` headers disagree with it is refused rather than
 * forwarded.
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
  if (
    messages.some((message) => message.method === "tools/call") &&
    roundsToolArguments(text)
  )
    throw new NativeWireError("rounded_number");
  if (batch) {
    // One header can't say which message of a batch it describes.
    if (headers.has("mcp-method") || headers.has("mcp-name"))
      throw new NativeWireError("header_mismatch");
  } else {
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

/**
 * Reads the `data` of each SSE event as the text goes past, so each character
 * is looked at once. A line ends at CR, LF or CRLF, and an LF right after a
 * CR belongs to it even across chunks. An event whose data outgrows
 * MAX_OBSERVED_CHARS is passed over whole, and the events after it are still
 * read.
 */
function sseEvents(onData: (data: string) => void): (text: string) => void {
  let line = "";
  /** The line in flight outgrew the limit: its text is dropped, but it is not blank. */
  let longLine = false;
  let data: string | undefined;
  let oversized = false;
  let afterCR = false;
  const endLine = () => {
    if (longLine) {
      oversized = true;
      data = undefined;
    } else if (line === "") {
      if (data && !oversized) onData(data);
      data = undefined;
      oversized = false;
    } else if (!oversized && line.startsWith("data:")) {
      const value = line.slice(5).replace(/^ /, "");
      data = data === undefined ? value : `${data}\n${value}`;
      if (data.length > MAX_OBSERVED_CHARS) {
        oversized = true;
        data = undefined;
      }
    }
    line = "";
    longLine = false;
  };
  return (text) => {
    if (!text) return;
    let start = afterCR && text[0] === "\n" ? 1 : 0;
    afterCR = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (char !== "\r" && char !== "\n") continue;
      if (!longLine) line += text.slice(start, i);
      endLine();
      if (char === "\r" && i + 1 === text.length) afterCR = true;
      else if (char === "\r" && text[i + 1] === "\n") i++;
      start = i + 1;
    }
    if (!longLine) line += text.slice(start);
    if (line.length > MAX_OBSERVED_CHARS) {
      longLine = true;
      line = "";
    }
  };
}

/**
 * Whether an upstream answer came through a followed redirect. A guarded
 * fetch follows redirects itself and leaves `redirected` false, so the final
 * URL counts too.
 */
export function followedRedirect(
  response: Response,
  requested: string,
): boolean {
  if (response.redirected) return true;
  if (!response.url) return false;
  try {
    const [final, asked] = [new URL(response.url), new URL(requested)];
    final.hash = asked.hash = "";
    return final.href !== asked.href;
  } catch {
    // An answer URL that can't be read can't show it is the one asked for.
    return true;
  }
}

/** Drops a body nobody will read. */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that already failed has nothing left to release.
  }
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
  let observing = args.kind === "json";
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
    for (const message of Array.isArray(value) ? value : [value]) {
      try {
        args.onMessage(message);
      } catch (error) {
        // Watching is never a reason to break the answer the vendor reads.
        logger.warn("[web-clients] an upstream message could not be observed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  const sse = args.kind === "sse" ? sseEvents(emit) : undefined;
  const take = (text: string, done: boolean) => {
    sse?.(text);
    if (!observing) return;
    pending += text;
    if (done) emit(pending);
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
