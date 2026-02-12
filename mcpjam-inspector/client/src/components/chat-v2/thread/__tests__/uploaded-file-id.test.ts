import { describe, expect, it } from "vitest";
import { isValidUploadedFileId } from "../uploaded-file-id";

describe("isValidUploadedFileId", () => {
  it("accepts server-generated file id format", () => {
    expect(
      isValidUploadedFileId("file_550e8400-e29b-41d4-a716-446655440000"),
    ).toBe(true);
  });

  it("rejects traversal payloads and unexpected path-like values", () => {
    expect(isValidUploadedFileId("../../other-endpoint")).toBe(false);
    expect(isValidUploadedFileId("file_../../other-endpoint")).toBe(false);
    expect(isValidUploadedFileId("file_/etc/passwd")).toBe(false);
    expect(isValidUploadedFileId("file_550e8400/e29b-41d4")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isValidUploadedFileId(null)).toBe(false);
    expect(isValidUploadedFileId(undefined)).toBe(false);
    expect(isValidUploadedFileId(123)).toBe(false);
    expect(isValidUploadedFileId({ fileId: "file_abc" })).toBe(false);
  });
});
