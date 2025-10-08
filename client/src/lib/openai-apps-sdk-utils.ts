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
/**
 * Recursively search for _meta field in an object
 */
function findMetaRecursive(
  obj: any,
  maxDepth: number = 5,
  currentDepth: number = 0,
): any {
  if (!obj || typeof obj !== "object" || currentDepth >= maxDepth) {
    return null;
  }

  // Check if current object has _meta
  if (obj._meta && typeof obj._meta === "object") {
    return obj._meta;
  }

  // Search in object properties (but skip arrays for now)
  if (!Array.isArray(obj)) {
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        const found = findMetaRecursive(obj[key], maxDepth, currentDepth + 1);
        if (found) return found;
      }
    }
  }

  return null;
}

export function extractOpenAIComponent(
  payload: any,
): OpenAIComponentMetadata | null {
  if (!payload) return null;

  // If payload is an array, try the first element
  const actualPayload = Array.isArray(payload) ? payload[0] : payload;
  if (!actualPayload) return null;

  // Use depth-first search to find _meta anywhere in the result structure
  const meta = findMetaRecursive(actualPayload);
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
