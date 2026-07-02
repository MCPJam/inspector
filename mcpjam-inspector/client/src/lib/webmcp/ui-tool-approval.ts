/**
 * UI-tool-aware approval responses, shared by every chat surface.
 *
 * MCP/skill tools resolve approvals server-side: the client sends
 * `addToolApprovalResponse` and the server's resume path executes or denies.
 * UI tools CANNOT — they have no server execute, so an approved-but-
 * resultless approval response would strand the turn. Instead:
 *
 *   Approve → execute in the browser via `fulfillApprovedUiToolCall` and
 *             ship the tool-result (`addToolOutput`). No approval response
 *             is sent; the SDK treats an unanswered approval request on an
 *             output-bearing part as resolved, and auto-resume fires off
 *             the completed tool set.
 *   Deny    → normal `addToolApprovalResponse({approved:false})`; both
 *             server engines already synthesize the denial result.
 *
 * Non-UI tool names fall through to the plain approval response untouched.
 */

import type { UIMessage } from "@ai-sdk/react";
import {
  fulfillApprovedUiToolCall,
  listDeferredUiToolCalls,
  settleDeniedUiToolCall,
  type HandleUiToolCallOptions,
} from "./ui-tool-executor";
import { useUiToolsRegistry } from "./ui-tools-registry";

interface ToolPartLike {
  type?: string;
  toolName?: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  approval?: { id?: string };
}

interface LocatedToolPart {
  toolName: string;
  toolCallId: string;
  state?: string;
  input: unknown;
}

function toolNameFromPart(part: ToolPartLike): string | null {
  if (typeof part.toolName === "string" && part.toolName) return part.toolName;
  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    return part.type.slice("tool-".length);
  }
  return null;
}

function findPartByApprovalId(
  messages: UIMessage[],
  approvalId: string
): LocatedToolPart | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = (messages[i] as { parts?: unknown[] }).parts;
    if (!Array.isArray(parts)) continue;
    for (const raw of parts) {
      const part = raw as ToolPartLike;
      if (part?.approval?.id !== approvalId) continue;
      const toolName = toolNameFromPart(part);
      if (!toolName || typeof part.toolCallId !== "string") return null;
      return {
        toolName,
        toolCallId: part.toolCallId,
        state: part.state,
        input: part.input,
      };
    }
  }
  return null;
}

function findPartByToolCallId(
  messages: UIMessage[],
  toolCallId: string
): LocatedToolPart | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = (messages[i] as { parts?: unknown[] }).parts;
    if (!Array.isArray(parts)) continue;
    for (const raw of parts) {
      const part = raw as ToolPartLike;
      if (part?.toolCallId !== toolCallId) continue;
      const toolName = toolNameFromPart(part);
      if (!toolName) return null;
      return { toolName, toolCallId, state: part.state, input: part.input };
    }
  }
  return null;
}

function isUiToolWeOwn(toolName: string): boolean {
  const registry = useUiToolsRegistry.getState();
  return registry.resolve(toolName) !== null || registry.wasShipped(toolName);
}

export interface UiAwareApprovalHandlerDeps {
  getMessages: () => UIMessage[];
  addToolApprovalResponse: (response: { id: string; approved: boolean }) => void;
  addToolOutput: HandleUiToolCallOptions["addToolOutput"];
  onNavigationToolCall?: (toolName: string) => void;
}

export function createUiAwareApprovalResponseHandler(
  deps: UiAwareApprovalHandlerDeps
): (response: { id: string; approved: boolean }) => void {
  return ({ id, approved }) => {
    const located = findPartByApprovalId(deps.getMessages(), id);
    if (!located || !isUiToolWeOwn(located.toolName)) {
      deps.addToolApprovalResponse({ id, approved });
      return;
    }
    if (!approved) {
      // Settle first: the server's denial machinery supplies the result,
      // and a later duplicate approve event must not be able to execute a
      // call the user explicitly rejected.
      settleDeniedUiToolCall(located.toolCallId);
      deps.addToolApprovalResponse({ id, approved: false });
      return;
    }
    void fulfillApprovedUiToolCall({
      toolCallId: located.toolCallId,
      toolName: located.toolName,
      // Reload case: the deferred stash is gone; the part's own input is
      // authoritative anyway.
      input: located.input,
      addToolOutput: deps.addToolOutput,
      ...(deps.onNavigationToolCall
        ? { onNavigationToolCall: deps.onNavigationToolCall }
        : {}),
    });
  };
}

/**
 * Orphaned-defer fallback: a call deferred by the executor whose part never
 * became `approval-requested` (the POST body's flag and the server's gate
 * disagreed for one turn — e.g. the toggle flipped mid-stream). Once the
 * stream settles, execute such calls so the turn can't hang. Calls whose
 * parts DID get an approval request stay parked for the pill.
 */
export function fulfillOrphanedDeferredUiToolCalls(deps: {
  messages: UIMessage[];
  addToolOutput: HandleUiToolCallOptions["addToolOutput"];
  onNavigationToolCall?: (toolName: string) => void;
}): void {
  for (const { toolCallId, toolName, input } of listDeferredUiToolCalls()) {
    const part = findPartByToolCallId(deps.messages, toolCallId);
    if (!part || part.state !== "input-available") continue;
    void fulfillApprovedUiToolCall({
      toolCallId,
      toolName,
      input,
      addToolOutput: deps.addToolOutput,
      ...(deps.onNavigationToolCall
        ? { onNavigationToolCall: deps.onNavigationToolCall }
        : {}),
    });
  }
}
