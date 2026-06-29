import { useEffect, useState } from "react";
import type { CallToolResult } from "@modelcontextprotocol/client";
import {
  mcpCallToolResultToModelOutput,
  mcpCallToolResultToModelOutputWithLinkedResources,
  type McpModelOutputContent,
  type McpModelOutputContentPart,
} from "@mcpjam/sdk/browser";
import { readResource as readResourceApi } from "@/lib/apis/mcp-resources-api";

export interface McpToolResultImagePreview {
  src: string;
  mediaType: string;
  alt: string;
}

export interface ResolveMcpToolResultImagePreviewsOptions {
  readResource?: (uri: string) => Promise<unknown>;
}

export type McpToolResultImagePreviewState =
  | { status: "idle"; previews: McpToolResultImagePreview[] }
  | { status: "loading"; previews: McpToolResultImagePreview[] }
  | { status: "ready"; previews: McpToolResultImagePreview[] }
  | { status: "empty"; previews: McpToolResultImagePreview[] };

export interface UseMcpToolResultImagePreviewsOptions {
  serverId?: string;
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

function hasImageResourceLinkCandidate(result: unknown): boolean {
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

export function hasMcpToolResultImageCandidate(result: unknown): boolean {
  if (hasModelOutputImageCandidate(result)) return true;
  if (!isRecord(result) || !Array.isArray(result.content)) return false;
  return result.content.some((block) => {
    if (!isRecord(block)) return false;
    if (block.type === "image" && isImageMimeType(block.mimeType)) return true;
    const resource = getEmbeddedResource(block);
    if (
      block.type === "resource" &&
      resource &&
      isImageMimeType(resource.mimeType)
    ) {
      return true;
    }
    return block.type === "resource_link" && isImageMimeType(block.mimeType);
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
  if (!hasMcpToolResultImageCandidate(result)) return [];

  if (isModelOutputContent(result)) {
    return mediaPartsToPreviews(result);
  }

  try {
    const mcpResult = result as CallToolResult;
    const modelOutput =
      options.readResource && hasImageResourceLinkCandidate(mcpResult)
        ? await mcpCallToolResultToModelOutputWithLinkedResources(mcpResult, {
            readResource: async ({ uri }) => options.readResource!(uri),
          })
        : mcpCallToolResultToModelOutput(mcpResult);

    return mediaPartsToPreviews(modelOutput);
  } catch {
    return [];
  }
}

export function useMcpToolResultImagePreviews(
  result: unknown,
  options: UseMcpToolResultImagePreviewsOptions = {}
): McpToolResultImagePreviewState & { hasCandidate: boolean } {
  const hasCandidate = hasMcpToolResultImageCandidate(result);
  const [state, setState] = useState<McpToolResultImagePreviewState>({
    status: "idle",
    previews: [],
  });

  useEffect(() => {
    let cancelled = false;

    if (!hasMcpToolResultImageCandidate(result)) {
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
  }, [result, options.serverId]);

  return { ...state, hasCandidate };
}
