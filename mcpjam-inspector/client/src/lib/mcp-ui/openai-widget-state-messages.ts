import type { UIMessage } from "ai";
import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isValidUploadedFileId(value: unknown): value is string {
  return typeof value === "string" && /^file_[0-9a-f-]+$/.test(value);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return value.startsWith("http://") || value.startsWith("https://");
}

export function extractImageUrls(state: unknown): string[] {
  if (!isRecord(state)) return [];
  const urls = new Set<string>();

  const addFromSelectedImages = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (!isRecord(item)) continue;
      if (isHttpUrl(item.imageUrl)) {
        urls.add(item.imageUrl);
      }
    }
  };

  addFromSelectedImages(state.selectedImages);

  const modelContent = isRecord(state.modelContent) ? state.modelContent : null;
  if (modelContent) {
    addFromSelectedImages(modelContent.selectedImages);
  }

  // Search-result widgets store selected image metadata under privateContent
  const privateContent = isRecord(state.privateContent)
    ? state.privateContent
    : null;
  if (privateContent) {
    addFromSelectedImages(privateContent.selectedImages);
  }

  return [...urls];
}

export function guessImageMediaType(url: string): string {
  // Extract file extension from the end of the URL pathname to avoid false
  // matches from extensions that appear mid-path (e.g. /icons.png-archive/cat.webp).
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Not a valid URL — fall through and match against the raw string.
  }

  const extMatch = pathname.match(/\.([a-z0-9]+)$/i);
  if (extMatch) {
    const ext = extMatch[1].toLowerCase();
    const mimeMap: Record<string, string> = {
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
      avif: "image/avif",
      bmp: "image/bmp",
      tiff: "image/tiff",
      tif: "image/tiff",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
    };
    if (mimeMap[ext]) return mimeMap[ext];
  }

  return "image/*";
}

export function extractUploadedFileIds(state: unknown): string[] {
  if (!isRecord(state)) return [];

  const ids = new Set<string>();
  const addId = (candidate: unknown) => {
    if (isValidUploadedFileId(candidate)) ids.add(candidate);
  };

  // state.imageIds is the canonical source for uploaded file IDs per the Apps SDK spec.
  // privateContent is UI-only state the model must not see, so we never read from it.
  // See: https://developers.openai.com/apps-sdk/build/state-management#image-ids-in-widget-state-model-visible-images-chatgpt-extension
  for (const item of toStringArray(state.imageIds)) addId(item);

  return [...ids];
}

function getFileEndpoints(fileId: string): string[] {
  const encoded = encodeURIComponent(fileId);

  // ChatGPT widget uploads are handled by the local app runtime endpoint
  // even when running in hosted mode. Keep web endpoint as a fallback.
  const endpoints = [`/api/apps/chatgpt-apps/file/${encoded}`];
  if (HOSTED_MODE) {
    endpoints.push(`/api/web/apps/chatgpt-apps/file/${encoded}`);
  }
  return endpoints;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to convert blob to data URL"));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function resolveFilePart(
  fileId: string,
): Promise<Extract<UIMessage["parts"][number], { type: "file" }> | null> {
  for (const endpoint of getFileEndpoints(fileId)) {
    try {
      const response = await authFetch(endpoint);
      if (!response.ok) continue;

      const blob = await response.blob();
      const dataUrl = await blobToDataUrl(blob);

      return {
        type: "file",
        mediaType: blob.type || "application/octet-stream",
        url: dataUrl,
      };
    } catch {
      continue;
    }
  }

  return null;
}

export function buildWidgetStateText(
  toolCallId: string,
  state: unknown,
): string {
  // Per the Apps SDK structured widget state shape, modelContent is the
  // model-visible portion; privateContent is UI-only and must not be exposed.
  // See: https://developers.openai.com/apps-sdk/build/state-management#image-ids-in-widget-state-model-visible-images-chatgpt-extension
  if (isRecord(state) && "modelContent" in state) {
    const { modelContent } = state;
    if (
      typeof modelContent === "string" &&
      modelContent !== "undefined" &&
      modelContent !== "null"
    ) {
      return modelContent;
    }
  }

  if (isRecord(state)) {
    // Even without modelContent, privateContent remains UI-only and must not
    // be serialized into model-visible text.
    const { privateContent: _, ...modelVisible } = state;
    const payload = Object.keys(modelVisible).length > 0 ? modelVisible : {};
    return `The state of widget ${toolCallId} is: ${safeStringify(payload)}`;
  }

  return `The state of widget ${toolCallId} is: ${safeStringify(state)}`;
}

export async function buildWidgetStateParts(
  toolCallId: string,
  state: unknown,
): Promise<UIMessage["parts"]> {
  const parts: UIMessage["parts"] = [
    { type: "text", text: buildWidgetStateText(toolCallId, state) },
  ];

  const fileParts = await Promise.all(
    extractUploadedFileIds(state).map((fileId) => resolveFilePart(fileId)),
  );

  for (const filePart of fileParts) {
    if (filePart) parts.push(filePart);
  }

  return parts;
}
