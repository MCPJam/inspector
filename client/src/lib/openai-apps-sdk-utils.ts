/**
 * Utilities for OpenAI Apps SDK integration
 *
 * This module provides helper functions for detecting and handling OpenAI Apps SDK
 * components in MCP tool responses.
 */

/**
 * OpenAI component metadata structure
 */
export interface OpenAIComponentMetadata {
  url: string;
  htmlBlob?: string;
}

/**
 * Extract OpenAI Apps SDK component URL from a tool result
 *
 * Checks for the `openai/outputTemplate` meta field which contains the
 * component URL (either ui:// for resources or http(s):// for direct URLs)
 *
 * @param payload - Tool result payload (may be wrapped or direct)
 * @returns Component metadata if found, null otherwise
 */
export function extractOpenAIComponent(
  payload: any,
): OpenAIComponentMetadata | null {
  if (!payload) return null;

  // If payload is an array, try the first element
  const actualPayload = Array.isArray(payload) ? payload[0] : payload;
  if (!actualPayload) return null;

  // TODO: Fix this hack. This is a hack to get the meta container from the payload.
  const findMetaContainer = (node: any): any => {
    if (!node || typeof node !== "object") return null;

    if (Object.prototype.hasOwnProperty.call(node, "_meta")) {
      return node;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findMetaContainer(item);
        if (found) return found;
      }
      return null;
    }

    for (const value of Object.values(node)) {
      const found = findMetaContainer(value);
      if (found) return found;
    }

    return null;
  };
  const metaContainer = findMetaContainer(actualPayload);
  const meta = metaContainer?._meta;
  if (meta && typeof meta === "object") {
    const outputTemplate = meta["openai/outputTemplate"];
    if (outputTemplate && typeof outputTemplate === "string") {
      // For ui:// URIs, we need to extract the HTML blob
      if (outputTemplate.startsWith("ui://")) {
        // Look for the resource content in the payload
        const findResource = (obj: any): any => {
          if (!obj) return null;

          // Check direct resource
          if (obj.resource?.uri === outputTemplate) {
            return obj.resource;
          }

          // Check content array
          if (Array.isArray(obj.content)) {
            for (const item of obj.content) {
              if (
                item?.type === "resource" &&
                item?.resource?.uri === outputTemplate
              ) {
                return item.resource;
              }
            }
          }

          return null;
        };

        const resource = findResource(actualPayload);
        if (resource?.blob || resource?.text) {
          return {
            url: outputTemplate,
            htmlBlob: resource.blob || resource.text,
          };
        }

        // If no blob found, return URL anyway - the HTTP endpoint will fetch it
        return { url: outputTemplate };
      }

      // Return HTTP(S) URLs as-is
      return { url: outputTemplate };
    }
  }
  return null;
}
