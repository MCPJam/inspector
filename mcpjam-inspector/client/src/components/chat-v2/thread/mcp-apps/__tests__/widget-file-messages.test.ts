import { beforeEach, describe, expect, it, vi } from "vitest";
import { authFetch } from "@/lib/session-token";
import {
  handleGetFileDownloadUrlMessage,
  handleUploadFileMessage,
} from "../widget-file-messages";

vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(),
}));

describe("widget-file-messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards upload success responses", async () => {
    const sendResponse = vi.fn();
    vi.mocked(authFetch).mockResolvedValue({
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
    );

    expect(sendResponse).toHaveBeenCalledWith({
      type: "openai:uploadFile:response",
      callId: 1,
      result: { fileId: "file_550e8400-e29b-41d4-a716-446655440000" },
    });
  });

  it("maps upload http errors to widget error responses", async () => {
    const sendResponse = vi.fn();
    vi.mocked(authFetch).mockResolvedValue({
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
    );

    expect(sendResponse).toHaveBeenCalledWith({
      type: "openai:uploadFile:response",
      callId: 2,
      error: "Upload failed from server",
    });
  });

  it("maps thrown upload errors to widget error responses", async () => {
    const sendResponse = vi.fn();
    vi.mocked(authFetch).mockRejectedValue(new Error("Network down"));

    await handleUploadFileMessage(
      {
        type: "openai:uploadFile",
        callId: 3,
      },
      sendResponse,
    );

    expect(sendResponse).toHaveBeenCalledWith({
      type: "openai:uploadFile:response",
      callId: 3,
      error: "Network down",
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
    const expectedDownloadUrl = `${loc.protocol}//${widgetHost}:${loc.port}/api/apps/chatgpt-apps/file/file_550e8400-e29b-41d4-a716-446655440000`;

    handleGetFileDownloadUrlMessage(
      {
        type: "openai:getFileDownloadUrl",
        callId: 5,
        fileId: "file_550e8400-e29b-41d4-a716-446655440000",
      },
      sendResponse,
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
