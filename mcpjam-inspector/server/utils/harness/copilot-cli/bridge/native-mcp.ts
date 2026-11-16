/**
 * Native MCP for the GitHub Copilot CLI client: the CLI's own MCP client dials
 * MCPJam's per-server proxy or, on a forwarded turn, MCPJam's forwarder.
 *
 * The CLI asks before every MCP call. That prompt reaches the host as the
 * shared approval pause, and the host decides who answers it: the person, or
 * MCPJam on a forwarded turn, where the forwarder's own gate then asks about
 * the request. A turn that approves everything (`allow-all`) is not asked.
 *
 * On a forwarded turn MCPJam's correlation id rides in `_meta`, so the
 * forwarder can file each result under the call the stream shows. A proxied
 * call carries no such key: the proxy passes request metadata to the server.
 *
 * Shapes measured on CLI 1.0.92 with SDK 1.0.11: `tool.execution_start` names
 * the configured server key and the server's tool, then the permission request
 * follows with the same `toolCallId` and the tool as the model sees it
 * (`<server>-<tool>`); the pre-call hook carries that id too, and `metaToUse`
 * reaches the wire.
 */
import { randomUUID } from "node:crypto";
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
 * The servers a turn delivers, validated before the CLI may dial them. The
 * same entry shape as Codex's `nativeMcpServersSchema`, checked by hand so the
 * in-sandbox bundle carries no schema library.
 */
export function parseNativeMcpServers(value: unknown): NativeServers {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("Invalid MCP servers.");
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
        throw new Error(`Invalid MCP server ${key}.`);
      return [key, entry as NativeServer] as const;
    }),
  );
}

/** Session options that expose only the delivered servers' tools. */
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
/** The host's answer to one `tool-approval-request`. */
type AskHost = (approvalId: string) => Promise<{ approved: boolean; reason?: string }>;

// CLI 1.0.92 refuses SDK 1.0.11's `denied-interactively-by-user` as a
// malformed answer, so a denial is the variant both accept.
const DENIED = { kind: "reject" } as const;
/** With feedback the CLI tells the model and the turn goes on, as a denied
 *  call does on MCPJam's engine; without it the CLI ends the turn. */
const denied = (reason?: string) =>
  ({ kind: "reject", feedback: reason ?? "Denied" }) as const;

/**
 * One turn's native MCP calls. Calls are named `mcp__<server>__<tool>`, the
 * scheme host attribution already parses; a result is the CLI's view of it.
 *
 * `ask` is absent when the turn approves every call. With it, each call to a
 * configured server waits on the host's answer before the CLI may send it,
 * so nothing reaches the server while the decision is pending.
 */
export function createNativeMcpCalls(input: {
  servers: NativeServers;
  emit: Emit;
  ask?: AskHost;
}) {
  const { servers, emit, ask } = input;
  const open = new Map<string, string>();
  const announce = (toolCallId: string, server: string, tool: string, args: unknown) => {
    if (open.has(toolCallId)) return;
    const toolName = `mcp__${server}__${tool}`;
    open.set(toolCallId, toolName);
    emit({
      type: "tool-call",
      toolCallId,
      toolName,
      input: JSON.stringify(args ?? {}),
      providerExecuted: true,
      dynamic: true,
    });
  };

  return {
    /** Tool parts for configured servers' calls; true when the event was one. */
    translate(event: SessionEvent): boolean {
      if (event.type === "tool.execution_start") {
        const { mcpServerName, mcpToolName, toolCallId } = event.data;
        if (!mcpServerName || !mcpToolName) return false;
        if (!Object.hasOwn(servers, mcpServerName)) return false;
        announce(toolCallId, mcpServerName, mcpToolName, event.data.arguments);
        return true;
      }
      if (event.type === "tool.execution_complete") {
        const toolName = open.get(event.data.toolCallId);
        if (!toolName) return false;
        open.delete(event.data.toolCallId);
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
    },

    /** The CLI's own permission prompt. Anything but a configured server's
     *  correlated MCP call is denied: no other tool reaches the CLI. */
    async permission(request: PermissionRequest): Promise<PermissionRequestResult> {
      if (
        request.kind !== "mcp" ||
        !Object.hasOwn(servers, request.serverName) ||
        typeof request.toolCallId !== "string" ||
        request.toolCallId.length === 0
      )
        return DENIED;
      if (!ask) return { kind: "approve-once" };
      // Already announced by `tool.execution_start`; this covers the reverse order.
      const prefix = `${request.serverName}-`;
      const tool = request.toolName.startsWith(prefix)
        ? request.toolName.slice(prefix.length)
        : request.toolName;
      announce(request.toolCallId, request.serverName, tool, request.args);
      // Unique per call: the host applies a stored decision to any later
      // request that reuses its id.
      const approvalId = `copilot-approval-${randomUUID()}`;
      emit({ type: "tool-approval-request", approvalId, toolCallId: request.toolCallId });
      // The host pauses the turn at the end of a step, so the step ends here.
      emit({
        type: "finish-step",
        finishReason: { unified: "tool-calls", raw: "awaiting-approval" },
        usage: { inputTokens: { total: undefined }, outputTokens: { total: undefined } },
      });
      const decision = await ask(approvalId);
      return decision.approved
        ? { kind: "approve-once", approvedInteractively: true }
        : denied(decision.reason);
    },
  };
}
