import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleGetFileDownloadUrlMessage,
  handleUploadFileMessage,
} from "../widget-file-messages";

// Post-3d-ii-c the handlers receive `authFetch` + `hostedMode` via a context
// argument (sourced from the WidgetHost) instead of importing `@/lib/*`, so the
// tests inject a mock `authFetch` directly.
const authFetch = vi.fn();

describe("widget-file-messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards upload success responses", async () => {
    const sendResponse = vi.fn();
    authFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        fileId: "file_550e8400-e29b-41d4-a716-446655440000",
      }),
    } as Response);

    await handleUploadFileMessage(
      {
        type: "openai:uploadFile",
        callId: 1,
        data: "base64data",
        mimeType: "image/png",
        fileName: "image.png",
      },
      sendResponse,
      { authFetch, hostedMode: false },
    );

    expect(sendResponse).toHaveBeenCalledWith({
      type: "openai:uploadFile:response",
      callId: 1,
      result: { fileId: "file_550e8400-e29b-41d4-a716-446655440000" },
    });
  });

  it("maps upload http errors to widget error responses", async () => {
    const sendResponse = vi.fn();
    authFetch.mockResolvedValue({
      ok: false,
      statusText: "Bad Request",
      json: async () => ({ error: "Upload failed from server" }),
    } as Response);

    await handleUploadFileMessage(
      {
        type: "openai:uploadFile",
        callId: 2,
      },
      sendResponse,
      { authFetch, hostedMode: false },
    );

    expect(sendResponse).toHaveBeenCalledWith({
      type: "openai:uploadFile:response",
      callId: 2,
      error: "Upload failed from server",
    });
  });

  it("maps thrown upload errors to widget error responses", async () => {
    const sendResponse = vi.fn();
    authFetch.mockRejectedValue(new Error("Network down"));

    await handleUploadFileMessage(
      {
        type: "openai:uploadFile",
        callId: 3,
      },
      sendResponse,
      { authFetch, hostedMode: false },
    );

    expect(sendResponse).toHaveBeenCalledWith({
      type: "openai:uploadFile:response",
      callId: 3,
      error: "Network down",
    });
  });

  it("blocks uploads in hosted mode without calling authFetch", async () => {
    const sendResponse = vi.fn();

    await handleUploadFileMessage(
      {
        type: "openai:uploadFile",
        callId: 6,
      },
      sendResponse,
      { authFetch, hostedMode: true },
    );

    expect(authFetch).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({
      type: "openai:uploadFile:response",
      callId: 6,
      error: "File upload is not supported in hosted mode",
    });
  });

  it("rejects invalid file ids for download url", () => {
    const sendResponse = vi.fn();

    handleGetFileDownloadUrlMessage(
      {
        type: "openai:getFileDownloadUrl",
        callId: 4,
        fileId: "../../other-endpoint",
      },
      sendResponse,
      { hostedMode: false },
    );

    expect(sendResponse).toHaveBeenCalledWith({
      type: "openai:getFileDownloadUrl:response",
      callId: 4,
      error: "Invalid fileId",
    });
  });

  it("builds host-swapped download urls for valid file ids", () => {
    const sendResponse = vi.fn();
    const loc = window.location;
    const widgetHost = loc.hostname === "localhost" ? "127.0.0.1" : "localhost";
    const expectedDownloadUrl = `${loc.protocol}//${widgetHost}:${loc.port}/api/apps/files/file/file_550e8400-e29b-41d4-a716-446655440000`;

    handleGetFileDownloadUrlMessage(
      {
        type: "openai:getFileDownloadUrl",
        callId: 5,
        fileId: "file_550e8400-e29b-41d4-a716-446655440000",
      },
      sendResponse,
      { hostedMode: false },
    );

    expect(sendResponse).toHaveBeenCalledWith({
      type: "openai:getFileDownloadUrl:response",
      callId: 5,
      result: {
        downloadUrl: expectedDownloadUrl,
      },
    });
  });
});
