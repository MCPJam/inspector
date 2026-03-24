import type { ClientCapabilityOptions } from "./types.js";

export const MCP_UI_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const MCP_UI_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges MCP `extensions` maps by extension id so workspace/server partial
 * configs do not replace the entire `extensions` object (which would drop
 * unrelated extension entries).
 */
function mergeExtensionsMaps(
  base?: Record<string, unknown>,
  override?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!base) {
    return { ...override };
  }
  if (!override) {
    return { ...base };
  }

  const merged: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const b = merged[key];
    const o = override[key];
    if (isPlainObject(b) && isPlainObject(o)) {
      merged[key] = { ...b, ...o };
    } else {
      merged[key] = o;
    }
  }
  return merged;
}

export function getDefaultClientCapabilities(): ClientCapabilityOptions {
  return {
    extensions: {
      [MCP_UI_EXTENSION_ID]: {
        mimeTypes: [MCP_UI_RESOURCE_MIME_TYPE],
      },
    },
  } as ClientCapabilityOptions;
}

export function normalizeClientCapabilities(
  capabilities?: ClientCapabilityOptions,
): ClientCapabilityOptions {
  const normalized: ClientCapabilityOptions = {
    ...(capabilities ?? {}),
  };

  if (!normalized.elicitation) {
    normalized.elicitation = {};
  }

  return normalized;
}

export function mergeClientCapabilities(
  base?: ClientCapabilityOptions,
  overrides?: ClientCapabilityOptions,
): ClientCapabilityOptions {
  const merged: Record<string, unknown> = {
    ...(base ?? {}),
    ...(overrides ?? {}),
  };

  if (
    overrides &&
    Object.prototype.hasOwnProperty.call(overrides, "extensions")
  ) {
    const overExt = overrides.extensions;
    if (overExt === undefined) {
      merged.extensions = base?.extensions;
    } else if (isPlainObject(overExt)) {
      if (Object.keys(overExt).length === 0) {
        merged.extensions = {};
      } else if (isPlainObject(base?.extensions)) {
        merged.extensions = mergeExtensionsMaps(
          base!.extensions as Record<string, unknown>,
          overExt,
        );
      } else {
        merged.extensions = { ...overExt };
      }
    } else {
      merged.extensions = overExt;
    }
  }

  return normalizeClientCapabilities(merged as ClientCapabilityOptions);
}
