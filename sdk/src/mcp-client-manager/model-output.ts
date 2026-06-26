import type { CallToolResult } from "@modelcontextprotocol/client";

export const MCP_DIRECT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const MCP_PRESERVE_RAW_RESULT_FOR_UI = "_mcpjamPreserveRawResultForUi";

export type McpModelOutputContentPart =
  | { type: "text"; text: string }
  | { type: "media"; data: string; mediaType: string };

export type McpModelOutputContent = {
  type: "content";
  value: McpModelOutputContentPart[];
};

export type McpModelOutputOptions = {
  maxImageBytes?: number;
};

export type McpLinkedResourceReader = (params: {
  uri: string;
  options?: { abortSignal?: AbortSignal };
}) => Promise<unknown>;

export type McpModelOutputWithLinkedResourcesOptions = McpModelOutputOptions & {
  readResource?: McpLinkedResourceReader;
  abortSignal?: AbortSignal;
};

type ContentBlock = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function estimateBase64DecodedBytes(data: string): {
  bytes: number;
  normalized: string;
} | null {
  const normalized = data.replace(/\s/g, "");
  if (!normalized) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  if (normalized.length % 4 === 1) return null;

  const padding = normalized.endsWith("==")
    ? 2
    : normalized.endsWith("=")
    ? 1
    : 0;

  return {
    bytes: Math.floor((normalized.length * 3) / 4) - padding,
    normalized,
  };
}

function omissionMarker(reason: string): McpModelOutputContentPart {
  return { type: "text", text: `[${reason}]` };
}

function compactMediaLabel(mimeType: unknown): string {
  return typeof mimeType === "string" && mimeType ? mimeType : "unknown MIME";
}

function isImageMimeType(mimeType: unknown): mimeType is string {
  return typeof mimeType === "string" && mimeType.startsWith("image/");
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("Aborted"), { name: "AbortError" });
}

function isTimeoutError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "TimeoutError"
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted && !isTimeoutError(signal.reason)) {
    throw abortError(signal);
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  return name === "AbortError" || code === "ABORT_ERR";
}

function mapImageData(
  data: unknown,
  mimeType: unknown,
  maxImageBytes: number
): McpModelOutputContentPart {
  if (!isImageMimeType(mimeType)) {
    return omissionMarker(
      `image omitted: unsupported MIME ${compactMediaLabel(mimeType)}`
    );
  }

  if (typeof data !== "string") {
    return omissionMarker(`image omitted: missing base64 data (${mimeType})`);
  }

  const estimated = estimateBase64DecodedBytes(data);
  if (!estimated) {
    return omissionMarker(`image omitted: invalid base64 data (${mimeType})`);
  }

  if (estimated.bytes > maxImageBytes) {
    return omissionMarker(`image omitted: ${mimeType} exceeds 10 MB limit`);
  }

  return {
    type: "media",
    data: estimated.normalized,
    mediaType: mimeType,
  };
}

function mapImageBlock(
  block: ContentBlock,
  maxImageBytes: number
): McpModelOutputContentPart {
  return mapImageData(block.data, block.mimeType, maxImageBytes);
}

function getEmbeddedResource(block: ContentBlock): ContentBlock | undefined {
  return isRecord(block.resource) ? block.resource : undefined;
}

function isEmbeddedImageResourceBlock(block: ContentBlock): boolean {
  return (
    block.type === "resource" &&
    isImageMimeType(getEmbeddedResource(block)?.mimeType)
  );
}

function mapEmbeddedResourceBlock(
  block: ContentBlock,
  maxImageBytes: number
): McpModelOutputContentPart {
  const resource = getEmbeddedResource(block);
  return mapImageData(resource?.blob, resource?.mimeType, maxImageBytes);
}

function isImageResourceLinkBlock(block: ContentBlock): boolean {
  return block.type === "resource_link" && isImageMimeType(block.mimeType);
}

function hasSyncImageCandidate(block: unknown): boolean {
  return (
    isRecord(block) &&
    (block.type === "image" || isEmbeddedImageResourceBlock(block))
  );
}

function hasLinkedImageCandidate(block: unknown): boolean {
  return isRecord(block) && isImageResourceLinkBlock(block);
}

function mapReadResourceImageContents(
  readResult: unknown,
  maxImageBytes: number
): McpModelOutputContentPart[] {
  if (!isRecord(readResult) || !Array.isArray(readResult.contents)) {
    return [omissionMarker("resource link omitted: no image content returned")];
  }

  const parts: McpModelOutputContentPart[] = [];
  let sawImageContent = false;

  for (const content of readResult.contents) {
    if (!isRecord(content) || !isImageMimeType(content.mimeType)) {
      continue;
    }
    sawImageContent = true;
    parts.push(mapImageData(content.blob, content.mimeType, maxImageBytes));
  }

  return sawImageContent
    ? parts
    : [omissionMarker("resource link omitted: no image content returned")];
}

async function mapResourceLinkBlock(
  block: ContentBlock,
  options: Required<
    Pick<McpModelOutputWithLinkedResourcesOptions, "maxImageBytes">
  > &
    Pick<
      McpModelOutputWithLinkedResourcesOptions,
      "readResource" | "abortSignal"
    >
): Promise<McpModelOutputContentPart[]> {
  if (typeof block.uri !== "string" || block.uri.length === 0) {
    return [omissionMarker("resource link omitted: missing URI")];
  }
  if (!options.readResource) {
    return [
      omissionMarker("resource link omitted: resource reader unavailable"),
    ];
  }

  try {
    throwIfAborted(options.abortSignal);
    const result = await options.readResource({
      uri: block.uri,
      options: options.abortSignal
        ? { abortSignal: options.abortSignal }
        : undefined,
    });
    throwIfAborted(options.abortSignal);
    return mapReadResourceImageContents(result, options.maxImageBytes);
  } catch (error) {
    if (isAbortError(error) && !isTimeoutError(options.abortSignal?.reason)) {
      throw error;
    }
    if (
      options.abortSignal?.aborted &&
      !isTimeoutError(options.abortSignal.reason)
    ) {
      throw abortError(options.abortSignal);
    }
    return [omissionMarker("resource link omitted: failed to read resource")];
  }
}

function mapUnsupportedBlock(block: ContentBlock): McpModelOutputContentPart {
  switch (block.type) {
    case "audio":
      return omissionMarker(
        `audio omitted: ${compactMediaLabel(block.mimeType)}`
      );
    case "resource":
      return omissionMarker("embedded resource omitted");
    case "resource_link":
      return omissionMarker("resource link omitted");
    default:
      return omissionMarker(
        `unsupported MCP content omitted: ${String(block.type ?? "unknown")}`
      );
  }
}

/**
 * Converts direct and embedded MCP image tool results into AI SDK content
 * output.
 *
 * Returns undefined when there are no direct `type: "image"` or embedded image
 * resource content blocks so existing JSON/text serialization paths stay
 * unchanged for ordinary results.
 */
export function mcpCallToolResultToModelOutput(
  result: CallToolResult,
  options: McpModelOutputOptions = {}
): McpModelOutputContent | undefined {
  if (!result || !Array.isArray(result.content)) return undefined;

  if (!result.content.some(hasSyncImageCandidate)) return undefined;

  const maxImageBytes = options.maxImageBytes ?? MCP_DIRECT_IMAGE_MAX_BYTES;
  const value: McpModelOutputContentPart[] = [];

  for (const block of result.content) {
    if (!isRecord(block)) {
      value.push(omissionMarker("unsupported MCP content omitted: unknown"));
      continue;
    }

    if (block.type === "text") {
      if (typeof block.text === "string") {
        value.push({ type: "text", text: block.text });
      }
      continue;
    }

    if (block.type === "image") {
      value.push(mapImageBlock(block, maxImageBytes));
      continue;
    }

    if (isEmbeddedImageResourceBlock(block)) {
      value.push(mapEmbeddedResourceBlock(block, maxImageBytes));
      continue;
    }

    value.push(mapUnsupportedBlock(block));
  }

  return { type: "content", value };
}

/**
 * Converts direct, embedded, and linked MCP image tool results into AI SDK
 * content output. Linked resources are resolved only through the supplied
 * MCP `resources/read` callback; this helper never fetches a URI directly.
 */
export async function mcpCallToolResultToModelOutputWithLinkedResources(
  result: CallToolResult,
  options: McpModelOutputWithLinkedResourcesOptions = {}
): Promise<McpModelOutputContent | undefined> {
  if (!result || !Array.isArray(result.content)) return undefined;

  const hasImageCandidate = result.content.some(
    (block) => hasSyncImageCandidate(block) || hasLinkedImageCandidate(block)
  );
  if (!hasImageCandidate) return undefined;

  const maxImageBytes = options.maxImageBytes ?? MCP_DIRECT_IMAGE_MAX_BYTES;
  const value: McpModelOutputContentPart[] = [];

  for (const block of result.content) {
    throwIfAborted(options.abortSignal);

    if (!isRecord(block)) {
      value.push(omissionMarker("unsupported MCP content omitted: unknown"));
      continue;
    }

    if (block.type === "text") {
      if (typeof block.text === "string") {
        value.push({ type: "text", text: block.text });
      }
      continue;
    }

    if (block.type === "image") {
      value.push(mapImageBlock(block, maxImageBytes));
      continue;
    }

    if (isEmbeddedImageResourceBlock(block)) {
      value.push(mapEmbeddedResourceBlock(block, maxImageBytes));
      continue;
    }

    if (isImageResourceLinkBlock(block)) {
      value.push(
        ...(await mapResourceLinkBlock(block, {
          maxImageBytes,
          readResource: options.readResource,
          abortSignal: options.abortSignal,
        }))
      );
      continue;
    }

    value.push(mapUnsupportedBlock(block));
  }

  return { type: "content", value };
}
