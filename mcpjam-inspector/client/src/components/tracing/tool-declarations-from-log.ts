/**
 * Recover a tool's SEP-2243 `x-mcp-header` declarations from the log itself.
 *
 * Judging a `Mcp-Param-*` header needs two things capture deliberately does not
 * store: the call's `arguments` (no request bodies are ever captured — see
 * `http-exchange-log.ts`) and the tool's `inputSchema`. The arguments come from
 * the correlated JSON-RPC frame. The schema comes from here: a `tools/list`
 * RESULT the same connection already logged.
 *
 * Reading the log rather than a tool cache is a deliberate choice. This module
 * runs inside a debugger view whose whole contract is "render what was
 * captured" — reaching for a hook that fetches tools would make opening a log
 * row issue network requests, and would show declarations that may postdate the
 * call being inspected. The log's own `tools/list` is contemporaneous with the
 * call by construction, which is exactly the schema the client mirrored from.
 *
 * On a modern connection a `tools/list` is close to guaranteed to be present:
 * `MCPClientManager` warms one before any modern `tools/call` precisely so the
 * mirroring has a source. When there is none, the caller falls back to saying
 * the params are unchecked, which is the honest answer.
 */

import {
  scanXMcpHeaderDeclarations,
  type McpParamCrossCheck,
  type XMcpHeaderDeclaration,
} from "@mcpjam/sdk/browser";
import {
  findFrameForExchange,
  frameIdentity,
  type CorrelatableLogItem,
} from "./correlate-http-exchange";

/** The shape a `tools/list` response frame carries. */
type ToolsListResultFrame = {
  result?: {
    tools?: Array<{ name?: unknown; inputSchema?: unknown }>;
  };
};

function toolsFromFrame(
  payload: unknown,
): Array<{ name?: unknown; inputSchema?: unknown }> | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const tools = (payload as ToolsListResultFrame).result?.tools;
  return Array.isArray(tools) ? tools : undefined;
}

/**
 * The validated declarations for `(serverId, toolName)`, or `undefined` when
 * the log holds no `tools/list` result naming that tool.
 *
 * `undefined` and `[]` mean different things and the caller must keep them
 * apart: `[]` is "the tool declares nothing", which makes any `Mcp-Param-*` on
 * the wire undeclared; `undefined` is "we don't know", which decides nothing.
 *
 * An INVALID scan also yields `undefined`. The spec's answer to a malformed
 * declaration is that the whole tool definition is invalid — surfacing that is
 * the conformance check's job (`tools-x-mcp-header-declarations-valid`), and
 * inventing per-header verdicts from a schema we have just judged unusable
 * would be worse than saying nothing.
 *
 * Newest listing wins: a `list_changed` mid-session means the later result is
 * the one the call was mirrored from.
 */
export function findToolDeclarations(
  serverId: string,
  toolName: string,
  items: CorrelatableLogItem[],
  /**
   * The call being judged. Only listings at or before this instant are
   * eligible: a `list_changed` mid-session can add, remove, or rename a
   * declaration, and judging an older call against a NEWER schema would
   * report a correctly mirrored header as undeclared (or bless one that was
   * invalid at the time). The schema in force is the last one the client saw
   * before the call.
   */
  notAfter: number,
): readonly XMcpHeaderDeclaration[] | undefined {
  const listings = items
    .filter((item) => {
      if (item.serverId !== serverId || item.source !== "mcp-server") {
        return false;
      }
      const at = Date.parse(item.timestamp);
      // STRICTLY at or before — no slack. `findExchangeForFrame` allows 1s
      // because it pairs a frame against an EXCHANGE, two capture points whose
      // clocks can skew. This compares two frames from the same rpcLogger, so
      // there is no skew to absorb, and borrowing that tolerance would admit a
      // `list_changed` listing that landed just after the call — the exact
      // future schema this bound exists to exclude.
      return !Number.isNaN(at) && at <= notAfter;
    })
    .sort(
      (a, b) =>
        Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
        b.id.localeCompare(a.id),
    );

  for (const item of listings) {
    const tools = toolsFromFrame(item.payload);
    if (!tools) continue;
    // A malformed listing must not take down the log row it is rendered in:
    // entries come off the wire and can be anything.
    const tool = tools.find(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        candidate.name === toolName,
    );
    if (!tool || tool.inputSchema === undefined) continue;
    const scan = scanXMcpHeaderDeclarations(tool.inputSchema);
    return scan.valid ? scan.declarations : undefined;
  }
  return undefined;
}

/**
 * The `params.arguments` of a `tools/call` request frame. `undefined` for
 * every other frame — only `tools/call` mirrors arguments into headers.
 */
export function toolCallArguments(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const { method, params } = payload as {
    method?: unknown;
    params?: { arguments?: unknown };
  };
  return method === "tools/call" ? params?.arguments : undefined;
}

/**
 * The {@link McpParamCrossCheck} for a `tools/call` frame, or `undefined` when
 * the log cannot supply the tool's schema.
 *
 * `undefined` is not a failure — it is the difference between "these headers
 * are wrong" and "we cannot say", and the UI must render the second as
 * unchecked rather than as a pass.
 */
export function paramCrossCheckForFrame(
  frame: CorrelatableLogItem,
  items: CorrelatableLogItem[],
): McpParamCrossCheck | undefined {
  const identity = frameIdentity(frame.payload);
  if (identity?.method !== "tools/call" || identity.name === undefined) {
    return undefined;
  }
  const frameAt = Date.parse(frame.timestamp);
  if (Number.isNaN(frameAt)) return undefined;
  const declarations = findToolDeclarations(
    frame.serverId,
    identity.name,
    items,
    frameAt,
  );
  if (declarations === undefined) return undefined;
  // `arguments` is spread unconditionally: its PRESENCE is what tells
  // `evaluateMcpHeaders` the body values are in hand, and a no-argument call
  // legitimately has `undefined` here.
  return { declarations, arguments: toolCallArguments(frame.payload) };
}

/**
 * {@link paramCrossCheckForFrame} for a dedicated HTTP row, which holds an
 * exchange and no frame. Pairs back to the frame through the SAME correlation
 * the inline disclosure runs forward, so the two views can never attribute the
 * same exchange to different calls.
 */
export function paramCrossCheckForExchangeItem(
  exchangeItem: CorrelatableLogItem,
  items: CorrelatableLogItem[],
): McpParamCrossCheck | undefined {
  const frame = findFrameForExchange(exchangeItem, items);
  return frame ? paramCrossCheckForFrame(frame, items) : undefined;
}
