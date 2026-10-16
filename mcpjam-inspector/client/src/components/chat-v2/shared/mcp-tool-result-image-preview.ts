import { useEffect, useRef, useState } from "react";
import type { CallToolResult } from "@modelcontextprotocol/client";
import {
  mcpCallToolResultToModelOutput,
  mcpCallToolResultToModelOutputWithLinkedResources,
  readModelOutputImage,
  type McpToolResultImageRenderingPolicy,
  type McpModelOutputContent,
  type McpModelOutputImagePart,
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
  | {
      status: "idle";
      previews: McpToolResultImagePreview[];
      omittedImageCount: number;
    }
  | {
      status: "loading";
      previews: McpToolResultImagePreview[];
      omittedImageCount: number;
    }
  | {
      status: "ready";
      previews: McpToolResultImagePreview[];
      omittedImageCount: number;
    }
  | {
      status: "empty";
      previews: McpToolResultImagePreview[];
      omittedImageCount: number;
    };

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

function countImagesOmittedForLimits(value: unknown): number {
  const content = unwrapJsonEnvelope(value);
  if (
    !isRecord(content) ||
    content.type !== "content" ||
    !Array.isArray(content.value)
  ) {
    return 0;
  }
  return content.value.filter(
    (part) =>
      isRecord(part) &&
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.startsWith("[image omitted:") &&
      (part.text.includes(" exceeds ") || part.text.includes(" exceed "))
  ).length;
}

// A persisted tool result that has been round-tripped through the AI SDK
// loses its raw MCP `result` and keeps only the model-facing output shape
// (`{ type: "content", value: [{ type: "file", ... }] }`, or `media` /
// `image-data` in traces written before AI SDK 7). When the model was allowed
// to see the image, that surviving copy still carries the base64, so we can
// render straight from it. Returns a content object narrowed to the
// well-formed image parts, as `file` parts (dropping omission markers,
// non-image media, and malformed entries), or undefined when there are none.
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
  // Never trust the whole persisted array off a single match — filter to the
  // parts we can actually render so a malformed sibling can't crash the map or
  // emit a broken `data:` src.
  const imageParts = unwrapped.value.flatMap(
    (part): McpModelOutputImagePart[] => {
      const image = readModelOutputImage(part);
      return image
        ? [
            {
              type: "file",
              mediaType: image.mediaType,
              data: { type: "data", data: image.data },
            },
          ]
        : [];
    },
  );
  if (imageParts.length === 0) return undefined;
  return { type: "content", value: imageParts };
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

function rendersAnyToolImages(
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
  // MCP `result` was dropped on re-persist). That shape no longer carries
  // direct/embedded/linked origin, so honor the policy at the coarsest safe
  // granularity — render only when tool-image rendering is enabled at all,
  // otherwise a disabled policy would still leak images.
  if (
    asModelOutputImageContent(result) ||
    countImagesOmittedForLimits(result) > 0
  ) {
    return rendersAnyToolImages(policy);
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
  const omittedImageCount = countImagesOmittedForLimits(result);
  if (modelOutputContent) {
    modelOutputContent.value.forEach((part) => {
      const image = readModelOutputImage(part);
      if (image) {
        keyParts.push(
          `media:${image.mediaType}:${imageDataSignature(image.data)}`,
        );
      }
    });
    keyParts.push(`omitted:${omittedImageCount}`);
    return keyParts.join("|");
  }

  if (omittedImageCount > 0) {
    keyParts.push(`omitted:${omittedImageCount}`);
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
    .flatMap((part) => {
      const image = readModelOutputImage(part);
      return image ? [image] : [];
    })
    .map((image, index) => ({
      src: `data:${image.mediaType};base64,${image.data}`,
      mediaType: image.mediaType,
      alt: `Tool result image ${index + 1}`,
    }));
}

export async function resolveMcpToolResultImagePreviews(
  result: unknown,
  options: ResolveMcpToolResultImagePreviewsOptions = {}
): Promise<McpToolResultImagePreview[]> {
  const resolved = await resolveMcpToolResultImagePreviewDetails(
    result,
    options
  );
  return resolved.previews;
}

async function resolveMcpToolResultImagePreviewDetails(
  result: unknown,
  options: ResolveMcpToolResultImagePreviewsOptions = {}
): Promise<{
  previews: McpToolResultImagePreview[];
  omittedImageCount: number;
}> {
  if (!hasMcpToolResultImageCandidate(result, options.renderingPolicy)) {
    return { previews: [], omittedImageCount: 0 };
  }

  // Reloaded transcripts arrive already in the model-facing output shape —
  // render directly from the surviving media parts (no SDK round-trip).
  const modelOutputContent = asModelOutputImageContent(result);
  const persistedOmissionCount = countImagesOmittedForLimits(result);
  if (modelOutputContent || persistedOmissionCount > 0) {
    return {
      previews: mediaPartsToPreviews(modelOutputContent),
      omittedImageCount: persistedOmissionCount,
    };
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

    return {
      previews: mediaPartsToPreviews(modelOutput),
      omittedImageCount: countImagesOmittedForLimits(modelOutput),
    };
  } catch {
    return { previews: [], omittedImageCount: 0 };
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
    new Map<
      string,
      { previews: McpToolResultImagePreview[]; omittedImageCount: number }
    >()
  );
  const [state, setState] = useState<McpToolResultImagePreviewState>({
    status: "idle",
    previews: [],
    omittedImageCount: 0,
  });

  latestResolveArgsRef.current = {
    result,
    serverId: options.serverId,
    renderingPolicy: options.renderingPolicy,
  };

  useEffect(() => {
    let cancelled = false;

    if (!previewKey) {
      setState({ status: "idle", previews: [], omittedImageCount: 0 });
      return () => {
        cancelled = true;
      };
    }

    const cachedResult = previewCacheRef.current.get(previewKey);
    if (cachedResult) {
      setState({ status: "ready", ...cachedResult });
      return () => {
        cancelled = true;
      };
    }

    setState({ status: "loading", previews: [], omittedImageCount: 0 });

    const {
      result: resultToResolve,
      serverId,
      renderingPolicy,
    } = latestResolveArgsRef.current;

    resolveMcpToolResultImagePreviewDetails(resultToResolve, {
      readResource: serverId
        ? (uri) => readResourceApi(serverId, uri)
        : undefined,
      renderingPolicy,
    })
      .then((resolved) => {
        if (cancelled) return;
        if (resolved.previews.length > 0 || resolved.omittedImageCount > 0) {
          previewCacheRef.current.set(previewKey, resolved);
        }
        setState(
          resolved.previews.length > 0 || resolved.omittedImageCount > 0
            ? { status: "ready", ...resolved }
            : { status: "empty", previews: [], omittedImageCount: 0 }
        );
      })
      .catch(() => {
        if (cancelled) return;
        setState({ status: "empty", previews: [], omittedImageCount: 0 });
      });

    return () => {
      cancelled = true;
    };
  }, [previewKey]);

  return { ...state, hasCandidate };
}
