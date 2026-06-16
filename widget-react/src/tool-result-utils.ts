/**
 * Shared helpers for reading metadata and server IDs from tool results.
 *
 * Tool results may carry `_meta` and `_serverId` either at the top level or
 * nested under a `.value` wrapper. These utilities normalise access across both
 * shapes. Pure (no deps) — relocated from the inspector in Phase 3d-ii.
 */

import type { CallToolResult } from "@modelcontextprotocol/client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readToolResultObject(
  result: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(result)) return undefined;
  return result;
}

export function readToolResultMeta(
  result: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(result)) return undefined;

  if (isRecord(result._meta)) {
    return result._meta;
  }

  if (isRecord(result.value) && isRecord(result.value._meta)) {
    return result.value._meta;
  }

  return undefined;
}

export function readToolResultServerId(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;

  if (typeof result._serverId === "string") {
    return result._serverId;
  }

  if (isRecord(result.value) && typeof result.value._serverId === "string") {
    return result.value._serverId;
  }

  const meta = readToolResultMeta(result);
  return typeof meta?._serverId === "string" ? meta._serverId : undefined;
}

/**
 * Normalise a tool output into a real `CallToolResult` before it is handed to
 * an MCP App bridge via `bridge.sendToolResult`.
 *
 * Why this exists: native MCP Apps widgets read `toolResult.structuredContent`
 * (e.g. the platform `show_servers` widget at `mcp/src/ui/app.tsx`). But the
 * chat pipeline collapses an MCP tool result down to its bare payload before
 * the renderer sees it (`getToolInfo` → `output.value ?? rawOutput`), so the
 * value reaching the bridge is the structured payload itself, not a
 * `{ content, structuredContent, _meta }` envelope. Sending that bare object
 * straight through (the old `toolOutput as CallToolResult` cast) leaves the
 * widget's `structuredContent` slot empty → "Missing structured content".
 *
 * This re-envelopes the payload so every surface hands the widget bundle the
 * same shape the Playground already delivers directly. It is shape-agnostic and
 * idempotent:
 *   - a real `CallToolResult` (has `structuredContent` and/or a `content`
 *     array) passes through unchanged — never double-wrapped;
 *   - an AI-SDK `{ value, _meta }` wrapper is unwrapped, re-attaching the
 *     wrapper's `_meta` when the inner value lacks its own;
 *   - a bare structured payload is wrapped as
 *     `{ content: [], structuredContent: payload }`;
 *   - a non-object output yields an empty result.
 */
export function toCallToolResult(toolOutput: unknown): CallToolResult {
  if (!isRecord(toolOutput)) {
    return { content: [] };
  }

  // Already a result envelope: carries the fields widgets read. Pass through.
  if ("structuredContent" in toolOutput || Array.isArray(toolOutput.content)) {
    return toolOutput as unknown as CallToolResult;
  }

  // AI-SDK `{ value, _meta }` wrapper: the result/payload lives under `.value`.
  if (isRecord(toolOutput.value)) {
    const inner = toCallToolResult(toolOutput.value);
    if (!inner._meta && isRecord(toolOutput._meta)) {
      return { ...inner, _meta: toolOutput._meta };
    }
    return inner;
  }

  // Bare structured payload — re-envelope so `toolResult.structuredContent`
  // resolves for MCP Apps widgets that read it.
  return {
    content: [],
    structuredContent: toolOutput,
    ...(isRecord(toolOutput._meta) ? { _meta: toolOutput._meta } : {}),
  };
}
