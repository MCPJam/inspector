import { useEffect, useState } from "react";
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

function hasAnyEnabledImageSource(
  policy: McpToolResultImageRenderingPolicy | undefined
): boolean {
  return (
    rendersDirectImages(policy) ||
    rendersEmbeddedImages(policy) ||
    rendersLinkedImages(policy)
  );
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

function isModelOutputContent(value: unknown): value is McpModelOutputContent {
  return (
    isRecord(value) && value.type === "content" && Array.isArray(value.value)
  );
}

function hasModelOutputImageCandidate(value: unknown): boolean {
  if (!isModelOutputContent(value)) return false;
  return value.value.some(
    (part) =>
      isRecord(part) &&
      part.type === "media" &&
      isImageMimeType(part.mediaType) &&
      typeof part.data === "string"
  );
}

export function hasMcpToolResultImageCandidate(
  result: unknown,
  policy?: McpToolResultImageRenderingPolicy
): boolean {
  if (hasModelOutputImageCandidate(result)) {
    return hasAnyEnabledImageSource(policy);
  }
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

  if (isModelOutputContent(result)) {
    return mediaPartsToPreviews(result);
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
  const hasCandidate = hasMcpToolResultImageCandidate(
    result,
    options.renderingPolicy
  );
  const [state, setState] = useState<McpToolResultImagePreviewState>({
    status: "idle",
    previews: [],
  });

  useEffect(() => {
    let cancelled = false;

    if (!hasMcpToolResultImageCandidate(result, options.renderingPolicy)) {
      setState({ status: "idle", previews: [] });
      return () => {
        cancelled = true;
      };
    }

    setState({ status: "loading", previews: [] });
    resolveMcpToolResultImagePreviews(result, {
      readResource: options.serverId
        ? (uri) => readResourceApi(options.serverId!, uri)
        : undefined,
      renderingPolicy: options.renderingPolicy,
    })
      .then((previews) => {
        if (cancelled) return;
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
  }, [result, options.serverId, options.renderingPolicy]);

  return { ...state, hasCandidate };
}
