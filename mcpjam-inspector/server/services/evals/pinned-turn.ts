/**
 * pinned-turn.ts — execute one model-free "pinned tool call" turn.
 *
 * A pinned turn is the unified-engine replacement for the old `widget_probe`
 * synthetic monitor: instead of asking the model, the runner executes a fixed
 * tool call (fixture input) and renders its widget through the SAME
 * browser-session-context render+observe pipeline the model turns use. Shared
 * by every iteration function (local AI-SDK, hosted backend, streaming) so the
 * pinned-turn semantics live in exactly one place.
 *
 * The render observation and any tool error are collected on the shared
 * browser context / returned record; the caller folds them into the iteration
 * transcript and verdict exactly as it does for model turns.
 */

import type { MCPClientManager } from "@mcpjam/sdk";
import type { ToolCall, ToolErrorRecord } from "@/shared/eval-matching";
import type { PinnedToolCall } from "@/shared/prompt-turns";
import type { BrowserSessionContext } from "../browser-session-context";

/** Stable error token for "the pinned turn's server isn't connected to this run". */
export const PINNED_SERVER_NOT_CONNECTED = "pinned_server_not_connected";

/** First text block of a CallToolResult, for content-error messages. */
export function extractResultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      return (part as { text: string }).text;
    }
  }
  return undefined;
}

export interface RunPinnedTurnParams {
  pinned: PinnedToolCall;
  /** Manager key for the pinned server, pre-resolved by the caller against the
   *  run environment's bindings. `undefined` ⇒ the server isn't connected:
   *  records a not-connected error instead of executing. */
  resolvedServerKey: string | undefined;
  mcpClientManager: MCPClientManager;
  /** Shared render path — records an explicit `no_ui_resource` observation for
   *  a tool that declares no UI resource (so a render check fails closed). */
  browser: Pick<BrowserSessionContext, "renderPinnedToolResult">;
  /** Turn index, used to build a unique synthetic toolCallId. */
  promptIndex: number;
}

export interface PinnedTurnResult {
  /** The pinned call, recorded only when an MCP call actually happened
   *  (success or error). `null` for a not-connected server — no phantom call. */
  toolCall: ToolCall | null;
  /** Tool failure (content-error / protocol-error), threaded to the transcript
   *  so `noToolErrors` gates correctly even though there is no trace. */
  toolError?: ToolErrorRecord;
  /** Fatal, iteration-level error (server not connected). */
  iterationError?: string;
  /** Human-readable one-line outcome for the synthesized assistant message. */
  summary: string;
}

/**
 * Execute a pinned tool call and render its widget. Mirrors the legacy
 * `runProbeIteration` body: only a clean tool call is rendered (an errored
 * call has no widget data worth mounting, and the render predicates fail
 * closed without an observation — the verdict we want).
 */
export async function runPinnedTurn(
  params: RunPinnedTurnParams,
): Promise<PinnedTurnResult> {
  const { pinned, resolvedServerKey, mcpClientManager, browser, promptIndex } =
    params;
  const args = (pinned.arguments ?? {}) as Record<string, unknown>;

  if (!resolvedServerKey) {
    return {
      toolCall: null,
      iterationError: `${PINNED_SERVER_NOT_CONNECTED}: "${pinned.serverName}" is not connected in this run's environment`,
      summary: `Pinned tool call skipped: server "${pinned.serverName}" not connected`,
    };
  }

  let rawResult: unknown;
  let toolCallOk = false;
  let toolError: ToolErrorRecord | undefined;
  try {
    rawResult = await mcpClientManager.executeTool(
      resolvedServerKey,
      pinned.toolName,
      args,
    );
    const isError =
      !!rawResult &&
      typeof rawResult === "object" &&
      (rawResult as { isError?: unknown }).isError === true;
    if (isError) {
      toolError = {
        toolName: pinned.toolName,
        kind: "content-error",
        message: extractResultText(rawResult),
      };
    } else {
      toolCallOk = true;
    }
  } catch (error) {
    toolError = {
      toolName: pinned.toolName,
      kind: "protocol-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (toolCallOk) {
    await browser.renderPinnedToolResult({
      toolCallId: `pinned-${promptIndex}-${Date.now()}`,
      toolName: pinned.toolName,
      serverId: resolvedServerKey,
      toolInput: args,
      output: rawResult,
    });
  }

  const toolCall: ToolCall | null =
    toolCallOk || toolError
      ? { toolName: pinned.toolName, arguments: args }
      : null;
  const summary = toolCallOk
    ? `Pinned tool call ${pinned.toolName} executed`
    : `Pinned tool call ${pinned.toolName} failed: ${toolError?.message ?? "unknown error"}`;

  return {
    toolCall,
    ...(toolError ? { toolError } : {}),
    summary,
  };
}
