import { authFetch } from "@/lib/session-token";
import { isValidUploadedFileId } from "../uploaded-file-id";
import { HOSTED_MODE } from "@/lib/config";

type UploadFileMessage = {
  type: "openai:uploadFile";
  callId: unknown;
  data?: unknown;
  mimeType?: unknown;
  fileName?: unknown;
};

type GetFileDownloadUrlMessage = {
  type: "openai:getFileDownloadUrl";
  callId: unknown;
  fileId: unknown;
};

type UploadFileResponseMessage = {
  type: "openai:uploadFile:response";
  callId: unknown;
  result?: { fileId: string };
  error?: string;
};

type GetFileDownloadUrlResponseMessage = {
  type: "openai:getFileDownloadUrl:response";
  callId: unknown;
  result?: { downloadUrl: string };
  error?: string;
};

export type WidgetFileResponseMessage =
  | UploadFileResponseMessage
  | GetFileDownloadUrlResponseMessage;

export type SendWidgetFileResponse = (
  message: WidgetFileResponseMessage,
) => void;

function buildWidgetDownloadUrl(fileId: string): string {
  const loc = window.location;
  const widgetHost = loc.hostname === "localhost" ? "127.0.0.1" : "localhost";
  const basePath = HOSTED_MODE
    ? "/api/web/apps/chatgpt-apps/file"
    : "/api/apps/chatgpt-apps/file";
  return `${loc.protocol}//${widgetHost}:${loc.port}${basePath}/${fileId}`;
}

export async function handleUploadFileMessage(
  data: UploadFileMessage,
  sendResponse: SendWidgetFileResponse,
): Promise<void> {
  const uploadCallId = data.callId;
  if (HOSTED_MODE) {
    sendResponse({
      type: "openai:uploadFile:response",
      callId: uploadCallId,
      error: "File upload is not supported in hosted mode",
    });
    return;
  }

  try {
    const resp = await authFetch("/api/apps/chatgpt-apps/upload-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: data.data,
        mimeType: data.mimeType,
        fileName: data.fileName,
      }),
    });
    if (!resp.ok) {
      const body = (await resp
        .json()
        .catch(() => ({ error: resp.statusText }))) as {
        error?: string;
      };
      sendResponse({
        type: "openai:uploadFile:response",
        callId: uploadCallId,
        error: body.error || "Upload failed",
      });
      return;
    }

    const { fileId } = (await resp.json()) as { fileId: string };
    sendResponse({
      type: "openai:uploadFile:response",
      callId: uploadCallId,
      result: { fileId },
    });
  } catch (err) {
    sendResponse({
      type: "openai:uploadFile:response",
      callId: uploadCallId,
      error: err instanceof Error ? err.message : "Upload failed",
    });
  }
}

export function handleGetFileDownloadUrlMessage(
  data: GetFileDownloadUrlMessage,
  sendResponse: SendWidgetFileResponse,
): void {
  const dlCallId = data.callId;
  if (HOSTED_MODE) {
    sendResponse({
      type: "openai:getFileDownloadUrl:response",
      callId: dlCallId,
      error: "File download is not supported in hosted mode",
    });
    return;
  }

  const fileId = data.fileId;
  if (!isValidUploadedFileId(fileId)) {
    sendResponse({
      type: "openai:getFileDownloadUrl:response",
      callId: dlCallId,
      error: "Invalid fileId",
    });
    return;
  }

  sendResponse({
    type: "openai:getFileDownloadUrl:response",
    callId: dlCallId,
    result: { downloadUrl: buildWidgetDownloadUrl(fileId) },
  });
}
