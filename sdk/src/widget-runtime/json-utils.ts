/**
 * Pure JSON helpers shared by the widget runtime and the inspector. Framework-
 * free, browser- and Node-safe. Relocated here from the inspector in Phase
 * 3d-ii so the (soon-to-relocate) widget renderer and the inspector share one
 * implementation instead of duplicating it across the package boundary.
 */

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, canonicalizeJsonValue(nestedValue)]),
    );
  }

  return value;
}

/** Deterministic JSON: deep object-key sort, then `JSON.stringify`. */
export function stableStringifyJson(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}

/**
 * Extract a method/label from a widget transport message. MCP Apps messages are
 * JSON-RPC (`method`/`result`/`error`); OpenAI-shim messages carry an
 * `openai:`-prefixed `type`. `protocol` defaults to the JSON-RPC reading.
 */
export function extractMethod(
  message: unknown,
  protocol?: "mcp-apps" | "openai-apps",
): string {
  // OpenAI Apps: extract from "type" (e.g., "openai:callTool" → "callTool").
  if (protocol === "openai-apps") {
    const msg = message as { type?: string };
    if (typeof msg?.type === "string") {
      return msg.type.replace("openai:", "");
    }
    return "unknown";
  }

  // MCP Apps (JSON-RPC): extract from method/result/error.
  const msg = message as {
    method?: string;
    result?: unknown;
    error?: unknown;
  };
  if (typeof msg?.method === "string") return msg.method;
  if (msg?.result !== undefined) return "result";
  if (msg?.error !== undefined) return "error";
  return "unknown";
}
