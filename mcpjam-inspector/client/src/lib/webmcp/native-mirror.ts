/**
 * Best-effort mirror of MCPJam UI tools into the browser's native WebMCP API
 * (https://developer.chrome.com/docs/ai/webmcp), so browser-native agents can
 * call the same tools MCPJam's own chat agents use.
 *
 * The API is an origin-trial proposal and still moving, so every native
 * touchpoint lives behind this one adapter and is fully try/caught: native
 * breakage must never affect in-app registration or the chat pipeline.
 *
 * Surface resolution: `document.modelContext` is the preferred home;
 * `navigator.modelContext` is deprecated (Chrome 150) and kept only as a
 * legacy fallback. Native return values are WebMCP-friendly plain strings —
 * the MCP `{content:[...]}` envelope is MCPJam's internal chat-pipeline
 * shape, not assumed to be the browser-native one.
 */

import type { UiToolDefinition, UiToolResult } from "./ui-tools-registry";

interface ModelContextLike {
  registerTool: (
    descriptor: Record<string, unknown>,
    opts?: { signal?: AbortSignal },
  ) => unknown;
}

function asModelContextLike(value: unknown): ModelContextLike | null {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as ModelContextLike).registerTool === "function"
  ) {
    return value as ModelContextLike;
  }
  return null;
}

export function getNativeModelContext(): ModelContextLike | null {
  try {
    if (typeof document !== "undefined") {
      const ctx = asModelContextLike(
        (document as { modelContext?: unknown }).modelContext,
      );
      if (ctx) return ctx;
    }
    if (typeof navigator !== "undefined") {
      // Deprecated as of Chrome 150; legacy fallback only.
      const ctx = asModelContextLike(
        (navigator as { modelContext?: unknown }).modelContext,
      );
      if (ctx) return ctx;
    }
  } catch {
    // Feature detection must never throw.
  }
  return null;
}

function toNativeText(result: UiToolResult): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * Register `def` with the native model context, when present.
 *
 * Returns a disposer that unregisters via the `AbortSignal` contract
 * (`registerTool(descriptor, {signal})`), or `null` when the native API is
 * absent or registration failed.
 */
export function mirrorUiToolToNative(
  def: UiToolDefinition,
): (() => void) | null {
  const ctx = getNativeModelContext();
  if (!ctx) return null;
  try {
    const controller = new AbortController();
    ctx.registerTool(
      {
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema ?? {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: def.readOnly },
        execute: async (args: unknown) => {
          const input =
            args && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {};
          const result = await def.execute(input);
          const text = toNativeText(result);
          if (result.isError) {
            throw new Error(text || `UI tool "${def.name}" failed.`);
          }
          return text;
        },
      },
      { signal: controller.signal },
    );
    return () => {
      try {
        controller.abort();
      } catch {
        // Best-effort teardown.
      }
    };
  } catch (error) {
    console.warn(
      `[webmcp] native registerTool failed for "${def.name}"`,
      error,
    );
    return null;
  }
}
