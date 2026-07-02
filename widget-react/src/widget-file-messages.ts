// Tier-B (Phase 3d-ii-c): the file-message bridge moved into @mcpjam/widget-react
// alongside the renderer. The inspector-supplied `authFetch` (session-token auth)
// and `hostedMode` flag are passed in as a `WidgetFileMessageContext` rather than
// imported from `@/lib/*`, so this module carries no inspector internals.

/** Validates the inspector's uploaded-file id format (`file_<hex/uuid>`). */
const UPLOADED_FILE_ID_PATTERN = /^file_[0-9a-f-]+$/;
function isValidUploadedFileId(fileId: unknown): fileId is string {
  return typeof fileId === "string" && UPLOADED_FILE_ID_PATTERN.test(fileId);
}

/** Host-supplied capabilities the file-message handlers need. */
export interface WidgetFileMessageContext {
  /** Session-authenticated fetch (`host.services.authFetch`). */
  authFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Whether the app runs against the hosted backend (`host.surface.hostedMode`). */
  hostedMode: boolean;
}

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

function buildWidgetDownloadUrl(fileId: string, hostedMode: boolean): string {
  const loc = window.location;
  const widgetHost = loc.hostname === "localhost" ? "127.0.0.1" : "localhost";
  const basePath = hostedMode
    ? "/api/web/apps/files/file"
    : "/api/apps/files/file";
  return `${loc.protocol}//${widgetHost}:${loc.port}${basePath}/${fileId}`;
}

export async function handleUploadFileMessage(
  data: UploadFileMessage,
  sendResponse: SendWidgetFileResponse,
  { authFetch, hostedMode }: WidgetFileMessageContext,
): Promise<void> {
  const uploadCallId = data.callId;
  if (hostedMode) {
    sendResponse({
      type: "openai:uploadFile:response",
      callId: uploadCallId,
      error: "File upload is not supported in hosted mode",
    });
    return;
  }

  try {
    const resp = await authFetch("/api/apps/files/upload-file", {
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
  { hostedMode }: Pick<WidgetFileMessageContext, "hostedMode">,
): void {
  const dlCallId = data.callId;
  if (hostedMode) {
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
    result: { downloadUrl: buildWidgetDownloadUrl(fileId, hostedMode) },
  });
}
