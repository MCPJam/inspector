/**
 * Native MCP for the forward-only GitHub Copilot CLI client.
 *
 * The CLI's own MCP client dials MCPJam's forwarder, and the forwarder's gate
 * asks the user about every request. So the CLI's own permission prompt is
 * answered here for forwarded servers only, and MCPJam's correlation id rides
 * in `_meta` so the forwarder can file each result under the call the stream
 * shows. Shapes measured on CLI 1.0.92 with SDK 1.0.11: `tool.execution_start`
 * names the configured server key and the server's tool, the permission
 * request and the pre-call hook carry the same `toolCallId`, and `metaToUse`
 * reaches the wire.
 */
import type { BridgeEvent } from "@ai-sdk/harness/bridge";
import type {
  MCPServerConfig,
  PermissionRequest,
  PermissionRequestResult,
  SessionEvent,
  SessionHooks,
} from "@github/copilot-sdk";

type PreMcpToolCall = NonNullable<SessionHooks["onPreMcpToolCall"]>;

/** The `_meta` key the forwarder reads (`forwardingRuntime.correlationKey`). */
export const COPILOT_CORRELATION_KEY = "mcpjam/toolCallId";

type NativeServer = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
};
type NativeServers = Record<string, NativeServer>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The servers a turn forwards, validated before the CLI may dial them. The
 * same entry shape as Codex's `nativeMcpServersSchema`, checked by hand so the
 * in-sandbox bundle carries no schema library.
 */
export function parseNativeMcpServers(value: unknown): NativeServers {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("Invalid forwarded MCP servers.");
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (
        !isRecord(entry) ||
        entry.type !== "http" ||
        typeof entry.url !== "string" ||
        !URL.canParse(entry.url) ||
        Object.keys(entry).some(
          (field) => !["type", "url", "headers", "timeout"].includes(field),
        ) ||
        (entry.headers !== undefined &&
          (!isRecord(entry.headers) ||
            Object.values(entry.headers).some((v) => typeof v !== "string"))) ||
        (entry.timeout !== undefined &&
          (typeof entry.timeout !== "number" ||
            !Number.isFinite(entry.timeout) ||
            entry.timeout <= 0))
      )
        throw new Error(`Invalid forwarded MCP server ${key}.`);
      return [key, entry as NativeServer] as const;
    }),
  );
}

/** Session options that expose only the forwarded servers' tools. */
export function nativeMcpSessionConfig(servers: NativeServers): {
  mcpServers?: Record<string, MCPServerConfig>;
  mcpToolPatterns: string[];
} {
  const keys = Object.keys(servers);
  if (keys.length === 0) return { mcpToolPatterns: [] };
  return {
    mcpServers: Object.fromEntries(
      keys.map((key) => [key, { ...servers[key], tools: ["*"] }]),
    ),
    // Built-in MCPs and config discovery are off, so these are the only
    // MCP tools the session can see.
    mcpToolPatterns: ["mcp:*"],
  };
}

/** Allow the CLI to call a forwarded server; the forwarder still asks. */
export function nativeMcpPermission(
  request: PermissionRequest,
  servers: NativeServers,
): PermissionRequestResult {
  return request.kind === "mcp" &&
    Object.hasOwn(servers, request.serverName) &&
    typeof request.toolCallId === "string" &&
    request.toolCallId.length > 0
    ? { kind: "approve-once" }
    : { kind: "denied-interactively-by-user" };
}

/** Add MCPJam's correlation id to the request `_meta` the CLI would send. */
export function stampNativeMcpCall(
  input: Parameters<PreMcpToolCall>[0],
): Awaited<ReturnType<PreMcpToolCall>> {
  if (!input.toolCallId) return;
  return {
    metaToUse: { ...input._meta, [COPILOT_CORRELATION_KEY]: input.toolCallId },
  };
}

type Emit = (part: BridgeEvent) => void;

/**
 * Translate forwarded calls into tool parts named `mcp__<server>__<tool>`,
 * the scheme host attribution already parses. The result is the CLI's view;
 * the turn shows the forwarder's recorded result in its place.
 */
export function createNativeMcpTranslator(servers: NativeServers, emit: Emit) {
  const calls = new Map<string, string>();
  return (event: SessionEvent): boolean => {
    if (event.type === "tool.execution_start") {
      const { mcpServerName, mcpToolName, toolCallId } = event.data;
      if (!mcpServerName || !mcpToolName) return false;
      if (!Object.hasOwn(servers, mcpServerName)) return false;
      const toolName = `mcp__${mcpServerName}__${mcpToolName}`;
      calls.set(toolCallId, toolName);
      emit({
        type: "tool-call",
        toolCallId,
        toolName,
        input: JSON.stringify(event.data.arguments ?? {}),
        providerExecuted: true,
        dynamic: true,
      });
      return true;
    }
    if (event.type === "tool.execution_complete") {
      const toolName = calls.get(event.data.toolCallId);
      if (!toolName) return false;
      calls.delete(event.data.toolCallId);
      const { success, result, error } = event.data;
      emit({
        type: "tool-result",
        toolCallId: event.data.toolCallId,
        toolName,
        result: success
          ? {
              content: result?.contents ?? [
                { type: "text", text: result?.content ?? "" },
              ],
              ...(result?.structuredContent !== undefined
                ? { structuredContent: result.structuredContent }
                : {}),
            }
          : {
              content: [{ type: "text", text: error?.message ?? "" }],
              isError: true,
            },
        ...(success ? {} : { isError: true }),
      });
      return true;
    }
    return false;
  };
}
