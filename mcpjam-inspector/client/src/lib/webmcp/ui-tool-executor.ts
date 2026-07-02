/**
 * Client-side fulfillment for WebMCP UI tool calls streamed back by the
 * server (which registered them as no-execute AI SDK tools).
 *
 * Called first from each chat surface's `useChat.onToolCall`; returns `false`
 * for names that aren't ours so the app-tool and server-tool paths run
 * unchanged. Dispatch is gated on registry membership / the per-session
 * shipped-name set — never the `ui_` prefix alone — so a genuine server tool
 * named `ui_something` falls through untouched.
 *
 * Approval (`requireToolApproval`): the AI SDK fires `onToolCall` on
 * `tool-input-available`, BEFORE the server's `tool-approval-request` chunk
 * reaches the client — so when the flag is on, mutating UI tool calls are
 * DEFERRED here (claimed, but not executed) and resolved by the approval
 * pill: Approve executes via `fulfillApprovedUiToolCall` and ships the
 * result (never a bare approval response — the server cannot execute a
 * no-execute tool); Deny sends the normal approval response. The
 * client/server gate must agree, so both read the shared
 * `uiToolCallNeedsApproval`.
 */

import { uiToolCallNeedsApproval } from "@/shared/client-fulfilled-tools.js";
import {
  useUiToolsRegistry,
  type UiToolDefinition,
  type UiToolResult,
} from "./ui-tools-registry";

export interface HandleUiToolCallOptions {
  toolName: string;
  toolCallId: string;
  input: unknown;
  addToolOutput: (output: {
    tool: string;
    toolCallId: string;
    output: UiToolResult;
  }) => void;
  /**
   * Fired BEFORE `execute` when the resolved tool is flagged `mayNavigate` —
   * the seam where a route-bound surface hands the conversation off to the
   * side panel before the route commits. Best-effort: a throwing callback
   * must never block the tool output (the stream would hang).
   */
  onNavigationToolCall?: (toolName: string) => void;
  /** The turn's approval flag — defers mutating tools to the approval pill. */
  requireToolApproval?: boolean;
}

/**
 * Tool calls already executed (or executing). The server can legitimately
 * re-emit `tool-input-available` for a call that already ran (its
 * approval-resume path re-fires client `onToolCall`), and the pill's
 * Approve button can race a double-click — neither may double-execute a
 * side-effectful tool like `ui_execute_tool`.
 */
const settledOrInFlightToolCallIds = new Set<string>();

/** Calls claimed-but-deferred, awaiting the user's approval. */
const deferredUiToolCalls = new Map<
  string,
  { toolName: string; input: unknown }
>();

export function __resetUiToolExecutorForTests(): void {
  settledOrInFlightToolCallIds.clear();
  deferredUiToolCalls.clear();
}

/** Deferred calls, for the orphaned-defer fallback (see ui-tool-approval). */
export function listDeferredUiToolCalls(): Array<{
  toolCallId: string;
  toolName: string;
  input: unknown;
}> {
  return [...deferredUiToolCalls.entries()].map(([toolCallId, v]) => ({
    toolCallId,
    ...v,
  }));
}

async function executeResolvedUiTool(
  def: UiToolDefinition,
  opts: Pick<
    HandleUiToolCallOptions,
    "toolName" | "toolCallId" | "input" | "addToolOutput"
  >
): Promise<void> {
  const { toolName, toolCallId, input, addToolOutput } = opts;
  settledOrInFlightToolCallIds.add(toolCallId);
  deferredUiToolCalls.delete(toolCallId);
  let output: UiToolResult;
  try {
    const args =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    output = await def.execute(args);
  } catch (error) {
    output = {
      content: [
        {
          type: "text",
          text: `UI tool failed: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        },
      ],
      isError: true,
    };
  }
  addToolOutput({ tool: toolName, toolCallId, output });
}

function unavailableOutput(toolName: string): UiToolResult {
  return {
    content: [
      {
        type: "text",
        text: `UI tool "${toolName}" is no longer available.`,
      },
    ],
    isError: true,
  };
}

/**
 * Returns `true` when the call was ours and was either resolved (output
 * supplied) or deferred to the approval pill; `false` when the name doesn't
 * belong to the UI tool layer and the caller should fall through to its
 * other handlers.
 */
export async function handleUiToolCall(
  opts: HandleUiToolCallOptions,
): Promise<boolean> {
  const { toolName, toolCallId, input, addToolOutput } = opts;
  const registry = useUiToolsRegistry.getState();
  const def = registry.resolve(toolName);

  if (!def) {
    // The name was advertised to the server in an earlier snapshot but the
    // tool is gone (HMR teardown, unmount). An output MUST still be
    // supplied or the paused server stream waits forever — same rule as
    // closed app iframes in the app-tool path.
    if (registry.wasShipped(toolName)) {
      addToolOutput({
        tool: toolName,
        toolCallId,
        output: unavailableOutput(toolName),
      });
      return true;
    }
    return false;
  }

  // Re-emission of an already-executed call (approval-resume path): claimed,
  // and its output already exists in the transcript — do nothing.
  if (settledOrInFlightToolCallIds.has(toolCallId)) return true;

  if (
    uiToolCallNeedsApproval({
      readOnly: def.readOnly,
      requireToolApproval: opts.requireToolApproval === true,
    })
  ) {
    deferredUiToolCalls.set(toolCallId, { toolName, input });
    return true;
  }

  if (def.mayNavigate) {
    try {
      opts.onNavigationToolCall?.(toolName);
    } catch {
      // Handoff is best-effort; the tool output must still be delivered.
    }
  }

  await executeResolvedUiTool(def, { toolName, toolCallId, input, addToolOutput });
  return true;
}

/**
 * Execute a UI tool call the user just APPROVED (or one whose approval
 * request never arrived — the orphaned-defer fallback). `toolName`/`input`
 * fall back to the deferred stash, and callers pass the part's own values
 * for the reload case where the stash is gone.
 */
export async function fulfillApprovedUiToolCall(opts: {
  toolCallId: string;
  toolName?: string;
  input?: unknown;
  addToolOutput: HandleUiToolCallOptions["addToolOutput"];
  onNavigationToolCall?: (toolName: string) => void;
}): Promise<void> {
  const { toolCallId, addToolOutput } = opts;
  if (settledOrInFlightToolCallIds.has(toolCallId)) return;
  const stashed = deferredUiToolCalls.get(toolCallId);
  const toolName = opts.toolName ?? stashed?.toolName;
  if (!toolName) return;
  const input = opts.input !== undefined ? opts.input : stashed?.input;

  const registry = useUiToolsRegistry.getState();
  const def = registry.resolve(toolName);
  if (!def) {
    settledOrInFlightToolCallIds.add(toolCallId);
    deferredUiToolCalls.delete(toolCallId);
    addToolOutput({
      tool: toolName,
      toolCallId,
      output: unavailableOutput(toolName),
    });
    return;
  }

  if (def.mayNavigate) {
    try {
      opts.onNavigationToolCall?.(toolName);
    } catch {
      // Best-effort, same as the un-gated path.
    }
  }

  await executeResolvedUiTool(def, { toolName, toolCallId, input, addToolOutput });
}
