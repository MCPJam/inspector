import type { ClientCapabilityOptions } from "./types.js";

export const MCP_UI_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const MCP_UI_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

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
  return normalizeClientCapabilities({
    ...(base ?? {}),
    ...(overrides ?? {}),
  } as ClientCapabilityOptions);
}
