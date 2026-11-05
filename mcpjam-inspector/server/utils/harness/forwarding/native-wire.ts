import {
  deriveMirroredBodyValues,
  findMcpHeaderIssues,
  type McpParamCrossCheck,
} from "@mcpjam/sdk";

export type NativeMessage = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};
export class NativeWireError extends Error {
  constructor(readonly code: string) {
    super(`Native MCP request refused (${code}).`);
    this.name = "NativeWireError";
  }
}

// JSON.parse would silently choose one of two decision keys. Reject duplicates
// at every depth before inspecting any method, account or argument.
function checkDuplicateKeys(text: string): void {
  let pos = 0;
  const space = () => {
    while (/\s/.test(text[pos] ?? "") && pos < text.length) pos++;
  };
  const string = (): string => {
    const start = pos++;
    while (pos < text.length) {
      if (text[pos] === "\\") pos += 2;
      else if (text[pos++] === '"') break;
    }
    return JSON.parse(text.slice(start, pos));
  };
  const value = (depth: number): void => {
    if (depth > 128) throw new NativeWireError("too_deep");
    space();
    if (text[pos] === "{") {
      pos++;
      space();
      const keys = new Set<string>();
      while (text[pos] !== "}") {
        const key = string();
        if (keys.has(key)) throw new NativeWireError("duplicate_key");
        keys.add(key);
        space();
        pos++;
        value(depth + 1);
        space();
        if (text[pos] !== ",") break;
        pos++;
        space();
      }
      pos++;
    } else if (text[pos] === "[") {
      pos++;
      space();
      while (text[pos] !== "]") {
        value(depth + 1);
        space();
        if (text[pos] !== ",") break;
        pos++;
      }
      pos++;
    } else if (text[pos] === '"') string();
    else while (pos < text.length && !/[\s,}\]]/.test(text[pos])) pos++;
  };
  value(0);
}

export function parseNativeMessage(
  raw: string,
  headers: Headers,
  params?: McpParamCrossCheck,
): NativeMessage {
  if (Buffer.byteLength(raw) > 1024 * 1024)
    throw new NativeWireError("request_too_large");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new NativeWireError("invalid_json");
  }
  checkDuplicateKeys(raw);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("jsonrpc" in value) ||
    value.jsonrpc !== "2.0"
  )
    throw new NativeWireError("invalid_message");
  const message = value as NativeMessage;
  if (
    message.id !== undefined &&
    message.id !== null &&
    typeof message.id !== "string" &&
    (typeof message.id !== "number" || !Number.isFinite(message.id))
  )
    throw new NativeWireError("invalid_id");
  if (message.method !== undefined && typeof message.method !== "string")
    throw new NativeWireError("invalid_method");
  if (
    message.method === undefined &&
    !("result" in value) &&
    !("error" in value)
  )
    throw new NativeWireError("invalid_message");
  if (message.method !== undefined) {
    if ("result" in value || "error" in value)
      throw new NativeWireError("ambiguous_message");
    if (message.method.startsWith("notifications/")) {
      if ("id" in value) throw new NativeWireError("notification_has_id");
    } else if (
      typeof message.id !== "string" &&
      typeof message.id !== "number"
    ) {
      throw new NativeWireError("request_requires_id");
    }
  } else if (
    "result" in value === "error" in value ||
    (typeof message.id !== "string" && typeof message.id !== "number")
  ) {
    throw new NativeWireError("invalid_response");
  }
  const headerValues: Record<string, string> = {};
  headers.forEach((value, name) => {
    headerValues[name] = value;
  });
  if (
    findMcpHeaderIssues(headerValues, deriveMirroredBodyValues(raw), params)
      .length
  )
    throw new NativeWireError("header_mismatch");
  if (
    Object.keys(headerValues).some((name) => name.startsWith("mcp-param-")) &&
    !params?.declarations
  )
    throw new NativeWireError("unqualified_param_headers");
  return message;
}

const requestHeaders = new Set([
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
  "mcp-method",
  "mcp-name",
  "mcp-client-info",
  "mcp-client-capabilities",
  "user-agent",
  "traceparent",
]);
export function nativeRequestHeaders(
  incoming: Headers,
  trusted?: HeadersInit,
): Headers {
  const headers = new Headers();
  incoming.forEach((value, name) => {
    if (requestHeaders.has(name) || name.startsWith("mcp-param-"))
      headers.set(name, value);
  });
  new Headers(trusted).forEach((value, name) => {
    if (
      !requestHeaders.has(name) &&
      !name.startsWith("mcp-") &&
      !name.startsWith("x-mcpjam-")
    )
      headers.set(name, value);
  });
  return headers;
}
export function nativeResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const name of [
    "content-type",
    "mcp-protocol-version",
    "mcp-session-id",
    "retry-after",
    "cache-control",
    "last-event-id",
  ]) {
    const value = upstream.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

export async function readNativeBody(
  request: Request,
  limit = 1024 * 1024,
): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
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
  return Buffer.concat(chunks).toString("utf8");
}
