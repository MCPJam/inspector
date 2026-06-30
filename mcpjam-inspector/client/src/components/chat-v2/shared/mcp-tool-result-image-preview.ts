import { useEffect, useRef, useState } from "react";
import type { CallToolResult } from "@modelcontextprotocol/client";
import {
  mcpCallToolResultToModelOutput,
  mcpCallToolResultToModelOutputWithLinkedResources,
  type McpToolResultImageRenderingPolicy,
  type McpModelOutputContent,
  type McpModelOutputContentPart,
  type ModelVisibleMcpToolResults,
} from "@mcpjam/sdk/browser";
import { readResource as readResourceApi } from "@/lib/apis/mcp-resources-api";

export interface McpToolResultImagePreview {
  src: string;
  mediaType: string;
  alt: string;
}

export interface ResolveMcpToolResultImagePreviewsOptions {
  readResource?: (uri: string) => Promise<unknown>;
  renderingPolicy?: McpToolResultImageRenderingPolicy;
}

export type McpToolResultImagePreviewState =
  | { status: "idle"; previews: McpToolResultImagePreview[] }
  | { status: "loading"; previews: McpToolResultImagePreview[] }
  | { status: "ready"; previews: McpToolResultImagePreview[] }
  | { status: "empty"; previews: McpToolResultImagePreview[] };

export interface UseMcpToolResultImagePreviewsOptions {
  serverId?: string;
  renderingPolicy?: McpToolResultImageRenderingPolicy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isImageMimeType(mimeType: unknown): mimeType is string {
  return typeof mimeType === "string" && mimeType.startsWith("image/");
}

function getEmbeddedResource(block: Record<string, unknown>) {
  return isRecord(block.resource) ? block.resource : undefined;
}

// Tool outputs may be wrapped as `{ type: "json", value: ... }` one or more
// times before the model-facing content shape. Mirrors the transcript
// reader's unwrap; kept local so this shared renderer doesn't pull in the
// heavy transcript-conversion module.
function unwrapJsonEnvelope(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord(current)) return current;
    if (current.type !== "json" || !("value" in current)) return current;
    current = current.value;
  }
  return current;
}

// A persisted tool result that has been round-tripped through the AI SDK
// loses its raw MCP `result` and keeps only the model-facing output shape
// (`{ type: "content", value: [{ type: "media", ... }] }`). When the model
// was allowed to see the image, that surviving copy still carries the base64,
// so we can render straight from it. Returns the unwrapped content when it
// holds at least one image media part, otherwise undefined.
function asModelOutputImageContent(
  value: unknown
): McpModelOutputContent | undefined {
  const unwrapped = unwrapJsonEnvelope(value);
  if (
    !isRecord(unwrapped) ||
    unwrapped.type !== "content" ||
    !Array.isArray(unwrapped.value)
  ) {
    return undefined;
  }
  const hasImageMedia = unwrapped.value.some(
    (part) =>
      isRecord(part) &&
      part.type === "media" &&
      isImageMimeType(part.mediaType)
  );
  return hasImageMedia
    ? (unwrapped as unknown as McpModelOutputContent)
    : undefined;
}

function rendersDirectImages(
  policy: McpToolResultImageRenderingPolicy | undefined
): boolean {
  return policy?.directContent?.image ?? true;
}

function rendersEmbeddedImages(
  policy: McpToolResultImageRenderingPolicy | undefined
): boolean {
  return policy?.embeddedResources?.blob?.image ?? true;
}

function rendersLinkedImages(
  policy: McpToolResultImageRenderingPolicy | undefined
): boolean {
  return policy?.linkedResources?.blob?.image ?? true;
}

function renderPolicyToModelVisibilityPolicy(
  policy: McpToolResultImageRenderingPolicy | undefined
): ModelVisibleMcpToolResults {
  return {
    directContent: { image: rendersDirectImages(policy) },
    embeddedResources: { blob: { image: rendersEmbeddedImages(policy) } },
    linkedResources: { blob: { image: rendersLinkedImages(policy) } },
  };
}

function hasImageResourceLinkCandidate(
  result: unknown,
  policy: McpToolResultImageRenderingPolicy | undefined
): boolean {
  if (!rendersLinkedImages(policy)) return false;
  if (!isRecord(result) || !Array.isArray(result.content)) return false;
  return result.content.some(
    (block) =>
      isRecord(block) &&
      block.type === "resource_link" &&
      isImageMimeType(block.mimeType)
  );
}

function imageDataSignature(data: unknown): string {
  if (typeof data !== "string") return "missing";
  return `${data.length}:${data.slice(0, 32)}:${data.slice(-32)}`;
}

function renderingPolicySignature(
  policy: McpToolResultImageRenderingPolicy | undefined
): string {
  return [
    rendersDirectImages(policy) ? "direct:1" : "direct:0",
    rendersEmbeddedImages(policy) ? "embedded:1" : "embedded:0",
    rendersLinkedImages(policy) ? "linked:1" : "linked:0",
  ].join("|");
}

export function hasMcpToolResultImageCandidate(
  result: unknown,
  policy?: McpToolResultImageRenderingPolicy
): boolean {
  // Reloaded transcripts carry only the model-facing output shape (the raw
  // MCP `result` was dropped on re-persist); render straight from it.
  if (asModelOutputImageContent(result)) return true;
  if (!isRecord(result) || !Array.isArray(result.content)) return false;
  return result.content.some((block) => {
    if (!isRecord(block)) return false;
    if (
      rendersDirectImages(policy) &&
      block.type === "image" &&
      isImageMimeType(block.mimeType)
    ) {
      return true;
    }
    const resource = getEmbeddedResource(block);
    if (
      rendersEmbeddedImages(policy) &&
      block.type === "resource" &&
      resource &&
      isImageMimeType(resource.mimeType)
    ) {
      return true;
    }
    return (
      rendersLinkedImages(policy) &&
      block.type === "resource_link" &&
      isImageMimeType(block.mimeType)
    );
  });
}

export function getMcpToolResultImagePreviewKey(
  result: unknown,
  options: UseMcpToolResultImagePreviewsOptions = {}
): string | undefined {
  if (!hasMcpToolResultImageCandidate(result, options.renderingPolicy)) {
    return undefined;
  }

  const keyParts = [
    `server:${options.serverId ?? ""}`,
    `policy:${renderingPolicySignature(options.renderingPolicy)}`,
  ];

  const modelOutputContent = asModelOutputImageContent(result);
  if (modelOutputContent) {
    modelOutputContent.value.forEach((part) => {
      if (part.type === "media" && isImageMimeType(part.mediaType)) {
        keyParts.push(`media:${part.mediaType}:${imageDataSignature(part.data)}`);
      }
    });
    return keyParts.join("|");
  }

  if (!isRecord(result) || !Array.isArray(result.content)) {
    return keyParts.join("|");
  }

  result.content.forEach((block) => {
    if (!isRecord(block)) return;

    if (
      rendersDirectImages(options.renderingPolicy) &&
      block.type === "image" &&
      isImageMimeType(block.mimeType)
    ) {
      keyParts.push(
        `direct:${block.mimeType}:${imageDataSignature(block.data)}`
      );
      return;
    }

    const resource = getEmbeddedResource(block);
    if (
      rendersEmbeddedImages(options.renderingPolicy) &&
      block.type === "resource" &&
      resource &&
      isImageMimeType(resource.mimeType)
    ) {
      keyParts.push(
        `embedded:${String(resource.uri ?? "")}:${
          resource.mimeType
        }:${imageDataSignature(resource.blob)}`
      );
      return;
    }

    if (
      rendersLinkedImages(options.renderingPolicy) &&
      block.type === "resource_link" &&
      isImageMimeType(block.mimeType)
    ) {
      keyParts.push(`linked:${String(block.uri ?? "")}:${block.mimeType}`);
    }
  });

  return keyParts.join("|");
}

function mediaPartsToPreviews(
  content: McpModelOutputContent | undefined
): McpToolResultImagePreview[] {
  if (!content || content.type !== "content" || !Array.isArray(content.value)) {
    return [];
  }

  return content.value
    .filter(
      (part): part is Extract<McpModelOutputContentPart, { type: "media" }> =>
        part.type === "media" && part.mediaType.startsWith("image/")
    )
    .map((part, index) => ({
      src: `data:${part.mediaType};base64,${part.data}`,
      mediaType: part.mediaType,
      alt: `Tool result image ${index + 1}`,
    }));
}

export async function resolveMcpToolResultImagePreviews(
  result: unknown,
  options: ResolveMcpToolResultImagePreviewsOptions = {}
): Promise<McpToolResultImagePreview[]> {
  if (!hasMcpToolResultImageCandidate(result, options.renderingPolicy)) {
    return [];
  }

  // Reloaded transcripts arrive already in the model-facing output shape —
  // render directly from the surviving media parts (no SDK round-trip).
  const modelOutputContent = asModelOutputImageContent(result);
  if (modelOutputContent) {
    return mediaPartsToPreviews(modelOutputContent);
  }

  try {
    const mcpResult = result as CallToolResult;
    const modelVisibleMcpToolResults = renderPolicyToModelVisibilityPolicy(
      options.renderingPolicy
    );
    const modelOutput =
      options.readResource &&
      hasImageResourceLinkCandidate(mcpResult, options.renderingPolicy)
        ? await mcpCallToolResultToModelOutputWithLinkedResources(mcpResult, {
            modelVisibleMcpToolResults,
            readResource: async ({ uri }) => options.readResource!(uri),
          })
        : mcpCallToolResultToModelOutput(mcpResult, {
            modelVisibleMcpToolResults,
          });

    return mediaPartsToPreviews(modelOutput);
  } catch {
    return [];
  }
}

export function useMcpToolResultImagePreviews(
  result: unknown,
  options: UseMcpToolResultImagePreviewsOptions = {}
): McpToolResultImagePreviewState & { hasCandidate: boolean } {
  const previewKey = getMcpToolResultImagePreviewKey(result, options);
  const hasCandidate = hasMcpToolResultImageCandidate(
    result,
    options.renderingPolicy
  );
  const latestResolveArgsRef = useRef({
    result,
    serverId: options.serverId,
    renderingPolicy: options.renderingPolicy,
  });
  const previewCacheRef = useRef(
    new Map<string, McpToolResultImagePreview[]>()
  );
  const [state, setState] = useState<McpToolResultImagePreviewState>({
    status: "idle",
    previews: [],
  });

  latestResolveArgsRef.current = {
    result,
    serverId: options.serverId,
    renderingPolicy: options.renderingPolicy,
  };

  useEffect(() => {
    let cancelled = false;

    if (!previewKey) {
      setState({ status: "idle", previews: [] });
      return () => {
        cancelled = true;
      };
    }

    const cachedPreviews = previewCacheRef.current.get(previewKey);
    if (cachedPreviews) {
      setState({ status: "ready", previews: cachedPreviews });
      return () => {
        cancelled = true;
      };
    }

    setState({ status: "loading", previews: [] });

    const {
      result: resultToResolve,
      serverId,
      renderingPolicy,
    } = latestResolveArgsRef.current;

    resolveMcpToolResultImagePreviews(resultToResolve, {
      readResource: serverId
        ? (uri) => readResourceApi(serverId, uri)
        : undefined,
      renderingPolicy,
    })
      .then((previews) => {
        if (cancelled) return;
        if (previews.length > 0) {
          previewCacheRef.current.set(previewKey, previews);
        }
        setState(
          previews.length > 0
            ? { status: "ready", previews }
            : { status: "empty", previews: [] }
        );
      })
      .catch(() => {
        if (cancelled) return;
        setState({ status: "empty", previews: [] });
      });

    return () => {
      cancelled = true;
    };
  }, [previewKey]);

  return { ...state, hasCandidate };
}
