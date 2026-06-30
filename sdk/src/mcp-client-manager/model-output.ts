import type { CallToolResult } from "@modelcontextprotocol/client";
import {
  resolveModelVisibleMcpToolResults,
  type ResolvedModelVisibleMcpToolResults,
} from "../host-config/host-policy.js";
import type { ModelVisibleMcpToolResults } from "../host-config/types.js";

export const MCP_DIRECT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const MCP_IMAGE_MAX_MEDIA_PARTS = 16;
export const MCP_IMAGE_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const MCP_LINKED_RESOURCE_MAX_READS = 16;
export const MCP_PRESERVE_RAW_RESULT_FOR_UI = "_mcpjamPreserveRawResultForUi";

export type McpModelOutputContentPart =
  | { type: "text"; text: string }
  | { type: "media"; data: string; mediaType: string };

export type McpModelOutputContent = {
  type: "content";
  value: McpModelOutputContentPart[];
};

export type McpModelVisibleToolResultPolicy = {
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
};

export type McpModelOutputOptions = McpModelVisibleToolResultPolicy & {
  maxImageBytes?: number;
  maxImageCount?: number;
  maxTotalImageBytes?: number;
  maxLinkedResourceReads?: number;
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
const BYTE_STRING_CHUNK_SIZE = 0x8000;
const BASE64_WHITESPACE_OVERHEAD_RATIO = 0.05;

type ImageBudget = {
  maxImageBytes: number;
  maxImageCount: number;
  maxTotalImageBytes: number;
  maxLinkedResourceReads: number;
  imageCount: number;
  totalImageBytes: number;
  linkedResourceReads: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function base64FromBytes(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (let i = 0; i < bytes.length; i += BYTE_STRING_CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + BYTE_STRING_CHUNK_SIZE)
    );
  }
  return btoa(binary);
}

function maxBase64EncodedLength(decodedBytes: number): number {
  return Math.ceil(decodedBytes / 3) * 4;
}

function maxBase64InputLength(decodedBytes: number): number {
  const encoded = maxBase64EncodedLength(decodedBytes);
  return encoded + Math.ceil(encoded * BASE64_WHITESPACE_OVERHEAD_RATIO);
}

function validateBase64ImageData(
  data: string,
  maxImageBytes: number
):
  | { kind: "ok"; bytes: number; normalized: string }
  | { kind: "invalid" }
  | { kind: "too_large" } {
  if (data.length > maxBase64InputLength(maxImageBytes)) {
    return { kind: "too_large" };
  }

  const normalized = data.replace(/\s/g, "");
  if (!normalized) return { kind: "invalid" };
  if (normalized.length > maxBase64EncodedLength(maxImageBytes)) {
    return { kind: "too_large" };
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    return { kind: "invalid" };
  }
  if (normalized.length % 4 === 1) return { kind: "invalid" };
  if (normalized.includes("=") && !/^[A-Za-z0-9+/]+={1,2}$/.test(normalized)) {
    return { kind: "invalid" };
  }

  const padding = normalized.endsWith("==")
    ? 2
    : normalized.endsWith("=")
      ? 1
      : 0;
  const bytes = Math.floor((normalized.length * 3) / 4) - padding;
  if (bytes > maxImageBytes) return { kind: "too_large" };

  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let decoded: Uint8Array;
  try {
    decoded =
      typeof Buffer !== "undefined"
        ? Buffer.from(padded, "base64")
        : Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return { kind: "invalid" };
  }

  let recoded: string;
  try {
    recoded = base64FromBytes(decoded);
  } catch {
    return { kind: "invalid" };
  }
  if (recoded.replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    return { kind: "invalid" };
  }

  return { kind: "ok", bytes, normalized };
}

function formatByteLimit(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  if (Number.isInteger(mib)) return `${mib} MB`;
  return `${bytes} bytes`;
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

function makeImageBudget(options: McpModelOutputOptions): ImageBudget {
  return {
    maxImageBytes: options.maxImageBytes ?? MCP_DIRECT_IMAGE_MAX_BYTES,
    maxImageCount: options.maxImageCount ?? MCP_IMAGE_MAX_MEDIA_PARTS,
    maxTotalImageBytes: options.maxTotalImageBytes ?? MCP_IMAGE_MAX_TOTAL_BYTES,
    maxLinkedResourceReads:
      options.maxLinkedResourceReads ?? MCP_LINKED_RESOURCE_MAX_READS,
    imageCount: 0,
    totalImageBytes: 0,
    linkedResourceReads: 0,
  };
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
  budget: ImageBudget
): McpModelOutputContentPart {
  if (!isImageMimeType(mimeType)) {
    return omissionMarker(
      `image omitted: unsupported MIME ${compactMediaLabel(mimeType)}`
    );
  }

  if (typeof data !== "string") {
    return omissionMarker(`image omitted: missing base64 data (${mimeType})`);
  }

  if (budget.imageCount >= budget.maxImageCount) {
    return omissionMarker(
      `image omitted: image count exceeds ${budget.maxImageCount} limit`
    );
  }

  const validated = validateBase64ImageData(data, budget.maxImageBytes);
  if (validated.kind === "invalid") {
    return omissionMarker(`image omitted: invalid base64 data (${mimeType})`);
  }

  if (validated.kind === "too_large") {
    return omissionMarker(
      `image omitted: ${mimeType} exceeds ${formatByteLimit(
        budget.maxImageBytes
      )} limit`
    );
  }

  if (budget.totalImageBytes + validated.bytes > budget.maxTotalImageBytes) {
    return omissionMarker(
      `image omitted: total image bytes exceed ${formatByteLimit(
        budget.maxTotalImageBytes
      )} limit`
    );
  }
  // Commit both budgets only once the image is actually included — an
  // invalid, too-large, or byte-budget-exceeded blob above returns without
  // consuming a count slot, mirroring how `totalImageBytes` is handled.
  budget.totalImageBytes += validated.bytes;
  budget.imageCount += 1;

  return {
    type: "media",
    data: validated.normalized,
    mediaType: mimeType,
  };
}

function mapImageBlock(
  block: ContentBlock,
  budget: ImageBudget
): McpModelOutputContentPart {
  return mapImageData(block.data, block.mimeType, budget);
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
  budget: ImageBudget
): McpModelOutputContentPart {
  const resource = getEmbeddedResource(block);
  return mapImageData(resource?.blob, resource?.mimeType, budget);
}

function isImageResourceLinkBlock(block: ContentBlock): boolean {
  return block.type === "resource_link" && isImageMimeType(block.mimeType);
}

function hasSyncImageCandidate(
  block: unknown,
  _policy: ResolvedModelVisibleMcpToolResults
): boolean {
  return (
    isRecord(block) &&
    (block.type === "image" || isEmbeddedImageResourceBlock(block))
  );
}

function hasLinkedImageCandidate(
  block: unknown,
  _policy: ResolvedModelVisibleMcpToolResults
): boolean {
  return isRecord(block) && isImageResourceLinkBlock(block);
}

function mapReadResourceImageContents(
  readResult: unknown,
  budget: ImageBudget
): McpModelOutputContentPart[] {
  const contents = isRecord(readResult)
    ? Array.isArray(readResult.contents)
      ? readResult.contents
      : isRecord(readResult.content) &&
          Array.isArray(readResult.content.contents)
        ? readResult.content.contents
        : undefined
    : undefined;

  if (!contents) {
    return [omissionMarker("resource link omitted: no image content returned")];
  }

  const parts: McpModelOutputContentPart[] = [];
  let sawImageContent = false;

  for (const content of contents) {
    if (!isRecord(content) || !isImageMimeType(content.mimeType)) {
      continue;
    }
    sawImageContent = true;
    parts.push(mapImageData(content.blob, content.mimeType, budget));
  }

  return sawImageContent
    ? parts
    : [omissionMarker("resource link omitted: no image content returned")];
}

async function mapResourceLinkBlock(
  block: ContentBlock,
  options: Pick<
    McpModelOutputWithLinkedResourcesOptions,
    "readResource" | "abortSignal"
  > & { budget: ImageBudget }
): Promise<McpModelOutputContentPart[]> {
  if (typeof block.uri !== "string" || block.uri.length === 0) {
    return [omissionMarker("resource link omitted: missing URI")];
  }
  if (!options.readResource) {
    return [
      omissionMarker("resource link omitted: resource reader unavailable"),
    ];
  }
  if (
    options.budget.linkedResourceReads >= options.budget.maxLinkedResourceReads
  ) {
    return [
      omissionMarker(
        `resource link omitted: linked resource read count exceeds ${options.budget.maxLinkedResourceReads} limit`
      ),
    ];
  }
  options.budget.linkedResourceReads += 1;

  try {
    throwIfAborted(options.abortSignal);
    const result = await options.readResource({
      uri: block.uri,
      options: options.abortSignal
        ? { abortSignal: options.abortSignal }
        : undefined,
    });
    throwIfAborted(options.abortSignal);
    return mapReadResourceImageContents(result, options.budget);
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

  const policy = resolveModelVisibleMcpToolResults(
    options.modelVisibleMcpToolResults
  );
  if (!result.content.some((block) => hasSyncImageCandidate(block, policy))) {
    return undefined;
  }

  const budget = makeImageBudget(options);
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
      value.push(
        policy.directContent.image
          ? mapImageBlock(block, budget)
          : omissionMarker("image omitted: direct image policy disabled")
      );
      continue;
    }

    if (isEmbeddedImageResourceBlock(block)) {
      value.push(
        policy.embeddedResources.blob.image
          ? mapEmbeddedResourceBlock(block, budget)
          : omissionMarker("embedded image resource omitted: policy disabled")
      );
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

  const policy = resolveModelVisibleMcpToolResults(
    options.modelVisibleMcpToolResults
  );
  const hasImageCandidate = result.content.some(
    (block) =>
      hasSyncImageCandidate(block, policy) ||
      hasLinkedImageCandidate(block, policy)
  );
  if (!hasImageCandidate) return undefined;

  const budget = makeImageBudget(options);
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
      value.push(
        policy.directContent.image
          ? mapImageBlock(block, budget)
          : omissionMarker("image omitted: direct image policy disabled")
      );
      continue;
    }

    if (isEmbeddedImageResourceBlock(block)) {
      value.push(
        policy.embeddedResources.blob.image
          ? mapEmbeddedResourceBlock(block, budget)
          : omissionMarker("embedded image resource omitted: policy disabled")
      );
      continue;
    }

    if (isImageResourceLinkBlock(block)) {
      if (!policy.linkedResources.blob.image) {
        value.push(omissionMarker("resource link omitted: policy disabled"));
        continue;
      }
      value.push(
        ...(await mapResourceLinkBlock(block, {
          budget,
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
