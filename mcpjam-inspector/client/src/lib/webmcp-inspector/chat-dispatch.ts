/**
 * Fulfilling a model's WebMCP page-tool call.
 *
 * The model names an opaque `page_<8hex>` alias; this resolves it back to the
 * live session and tool it stands for, runs it through the inspector store, and
 * shapes the outcome as MCP-style tool content the chat stream can carry.
 *
 * Every failure resolves rather than throws. A client-fulfilled tool call that
 * never produces a result leaves the turn paused forever waiting on a browser
 * that is not going to answer, so "the page is gone" has to come back as an
 * error RESULT, not an exception.
 */
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";
import { buildPageToolSnapshot } from "./page-tool-aliases";
import type { PageToolSnapshotEntry } from "@/shared/chat-v2";
import { isPageToolAlias } from "@/shared/client-fulfilled-tools";

/** The turn's snapshot, so an alias can be resolved when its call arrives. */
let advertised: PageToolSnapshotEntry[] = [];

/**
 * Page calls arrive on `onToolCall` before the AI SDK has applied the
 * `tool-approval-request` chunk. Keep them parked until the approval pill
 * explicitly fulfills them. This is deliberately separate from the live
 * snapshot: an approval may be answered after the page has navigated or the
 * inspector has refreshed its tool list.
 */
const deferredPageToolCalls = new Map<
  string,
  { alias: string; input: unknown }
>();
const settledPageToolCallIds = new Set<string>();
const shippedPageToolAliases = new Set<string>();
const MAX_SHIPPED_PAGE_ALIASES = 128;
const MAX_SETTLED_PAGE_CALL_IDS = 256;

function markPageToolCallSettled(toolCallId: string): void {
  settledPageToolCallIds.add(toolCallId);
  while (settledPageToolCallIds.size > MAX_SETTLED_PAGE_CALL_IDS) {
    const oldest = settledPageToolCallIds.values().next().value;
    if (oldest === undefined) break;
    settledPageToolCallIds.delete(oldest);
  }
}

export function setAdvertisedPageTools(entries: PageToolSnapshotEntry[]): void {
  advertised = entries;
  for (const entry of entries) {
    shippedPageToolAliases.add(entry.alias);
    while (shippedPageToolAliases.size > MAX_SHIPPED_PAGE_ALIASES) {
      const oldest = shippedPageToolAliases.values().next().value;
      if (oldest === undefined) break;
      shippedPageToolAliases.delete(oldest);
    }
  }
}

/** Test seam and session cleanup for client-fulfilled page calls. */
export function __resetPageToolDispatchForTests(): void {
  advertised = [];
  deferredPageToolCalls.clear();
  settledPageToolCallIds.clear();
  shippedPageToolAliases.clear();
}

/** Whether an alias belongs to a page snapshot owned by this client. */
export function ownsPageToolAlias(alias: string): boolean {
  return (
    isPageToolAlias(alias) &&
    (resolvePageToolAlias(alias) !== undefined ||
      shippedPageToolAliases.has(alias) ||
      [...deferredPageToolCalls.values()].some((call) => call.alias === alias))
  );
}

/**
 * Claim a page call without executing it. The approval request is delivered
 * after this callback returns, so this function must remain synchronous.
 */
export function deferPageToolCallForApproval(options: {
  toolName: string;
  toolCallId: string;
  input: unknown;
}): boolean {
  if (!isPageToolAlias(options.toolName)) return false;
  if (!ownsPageToolAlias(options.toolName)) return false;
  if (
    settledPageToolCallIds.has(options.toolCallId) ||
    deferredPageToolCalls.has(options.toolCallId)
  ) {
    return true;
  }
  deferredPageToolCalls.set(options.toolCallId, {
    alias: options.toolName,
    input: options.input,
  });
  return true;
}

/** Make a denied call terminal so a duplicate approval event cannot execute it. */
export function settleDeniedPageToolCall(toolCallId: string): void {
  markPageToolCallSettled(toolCallId);
  deferredPageToolCalls.delete(toolCallId);
}

/**
 * Snapshot the open session's tools for the turn being sent, and remember what
 * was advertised so the model's reply can be resolved back to real tools.
 *
 * Called at POST time rather than memoized: a page registers and drops tools as
 * the user moves through it, and a turn should offer what the page has now.
 */
export function snapshotPageToolsForTurn(): PageToolSnapshotEntry[] {
  const { session, tools, pageToolsLive } = useWebmcpInspectorStore.getState();
  // Gated here as well as at the caller. A "closed" status arrives as an
  // ordinary session event and leaves the last tool snapshot in place, so a
  // snapshot taken from state alone would advertise a browser that is gone —
  // and the model would then be offered tools nothing can run.
  const entries = pageToolsLive()
    ? buildPageToolSnapshot(session?.sessionId, tools)
    : [];
  setAdvertisedPageTools(entries);
  return entries;
}

export function resolvePageToolAlias(
  alias: string,
): PageToolSnapshotEntry | undefined {
  return advertised.find((entry) => entry.alias === alias);
}

export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function textResult(text: string, isError = false): McpToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function invokePageToolForChat(
  alias: string,
  input: Record<string, unknown>,
): Promise<McpToolResult> {
  const entry = resolvePageToolAlias(alias);
  if (!entry) {
    return textResult(
      "That page tool is no longer available — the WebMCP browser session was closed after this tool was offered.",
      true,
    );
  }

  const store = useWebmcpInspectorStore.getState();
  if (store.session?.sessionId !== entry.sessionId) {
    // The snapshot was taken against a session that has since been replaced,
    // so invoking would run against a different page than the model was told
    // about.
    return textResult(
      `The browser session that offered "${entry.rawName}" is gone. Reopen the page in the WebMCP tab and try again.`,
      true,
    );
  }

  const result = await store.invokeToolForResult(entry.toolKey, input);

  if (result.state === "succeeded") {
    const text =
      typeof result.output === "string"
        ? result.output
        : JSON.stringify(result.output ?? null);
    return textResult(
      result.outputTruncated
        ? `${text}\n\n[This result was truncated by the inspector.]`
        : text,
    );
  }
  if (result.state === "cancelled") {
    return textResult(
      `The invocation of "${entry.rawName}" was cancelled before it finished.`,
      true,
    );
  }
  if (result.state === "timeout") {
    return textResult(
      `"${entry.rawName}" did not respond in time and was cancelled.`,
      true,
    );
  }
  return textResult(result.errorMessage ?? `"${entry.rawName}" failed.`, true);
}

/** Fulfill a page call after the user approves it. */
export async function fulfillApprovedPageToolCall(options: {
  toolCallId: string;
  alias?: string;
  input?: unknown;
  addToolOutput: (output: {
    tool: string;
    toolCallId: string;
    output: McpToolResult;
  }) => void;
}): Promise<void> {
  if (settledPageToolCallIds.has(options.toolCallId)) return;
  const deferred = deferredPageToolCalls.get(options.toolCallId);
  const alias = options.alias ?? deferred?.alias;
  if (!alias) return;
  const input = options.input !== undefined ? options.input : deferred?.input;
  markPageToolCallSettled(options.toolCallId);
  deferredPageToolCalls.delete(options.toolCallId);

  let output: McpToolResult;
  try {
    output = await invokePageToolForChat(
      alias,
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {},
    );
  } catch (error) {
    output = textResult(
      `The WebMCP page tool failed: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      true,
    );
  }
  options.addToolOutput({
    tool: alias,
    toolCallId: options.toolCallId,
    output,
  });
}
