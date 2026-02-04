import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateFile,
  generateFileId,
  createFileAttachment,
  revokeFileAttachmentUrls,
  attachmentsToFiles,
  attachmentsToFileUIParts,
  getFileInputAccept,
  MAX_FILE_SIZE,
} from "../file-utils";
import type { FileAttachment } from "../file-utils";

// Mock @/lib/chat-utils
vi.mock("@/lib/chat-utils", () => ({
  isValidFileType: vi.fn(),
  isImageFile: vi.fn(),
  formatFileSize: vi.fn((bytes: number) => `${bytes} bytes`),
}));

import { isValidFileType, isImageFile, formatFileSize } from "@/lib/chat-utils";

const mockIsValidFileType = vi.mocked(isValidFileType);
const mockIsImageFile = vi.mocked(isImageFile);
const mockFormatFileSize = vi.mocked(formatFileSize);

// Helper to create a mock File
function createMockFile(name: string, size: number, type: string): File {
  const content = new Uint8Array(size);
  return new File([content], name, { type });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFormatFileSize.mockImplementation((bytes: number) => `${bytes} bytes`);
});

describe("validateFile", () => {
  it("returns valid for an allowed image file", () => {
    mockIsValidFileType.mockReturnValue(true);
    const file = createMockFile("photo.png", 1024, "image/png");

    const result = validateFile(file);

    expect(result).toEqual({ valid: true });
  });

  it("returns valid for allowed document types", () => {
    mockIsValidFileType.mockReturnValue(true);

    for (const [name, type] of [
      ["doc.pdf", "application/pdf"],
      ["data.json", "application/json"],
      ["notes.txt", "text/plain"],
      ["sheet.csv", "text/csv"],
      [
        "workbook.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
    ]) {
      const file = createMockFile(name, 500, type);
      expect(validateFile(file)).toEqual({ valid: true });
    }
  });

  it("returns error for unsupported MIME type", () => {
    mockIsValidFileType.mockReturnValue(false);
    const file = createMockFile("video.mp4", 1024, "video/mp4");

    const result = validateFile(file);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unsupported file type: video/mp4");
  });

  it("returns error for file exceeding 10MB limit", () => {
    mockIsValidFileType.mockReturnValue(true);
    const file = createMockFile("huge.png", MAX_FILE_SIZE + 1, "image/png");

    const result = validateFile(file);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("File too large");
    expect(mockFormatFileSize).toHaveBeenCalledWith(MAX_FILE_SIZE + 1);
    expect(mockFormatFileSize).toHaveBeenCalledWith(MAX_FILE_SIZE);
  });

  it("returns error for file with empty type", () => {
    mockIsValidFileType.mockReturnValue(false);
    const file = createMockFile("mystery", 100, "");

    const result = validateFile(file);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("unknown");
  });
});

describe("generateFileId", () => {
  it("returns a string matching the expected pattern", () => {
    const id = generateFileId();
    expect(id).toMatch(/^file-\d+-[a-z0-9]+$/);
  });

  it("returns unique IDs on successive calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateFileId()));
    expect(ids.size).toBe(20);
  });
});

describe("createFileAttachment", () => {
  it("sets id and file on the returned object", () => {
    mockIsImageFile.mockReturnValue(false);
    const file = createMockFile("doc.pdf", 500, "application/pdf");

    const attachment = createFileAttachment(file);

    expect(attachment.id).toMatch(/^file-/);
    expect(attachment.file).toBe(file);
  });

  it("sets previewUrl for image files", () => {
    mockIsImageFile.mockReturnValue(true);
    const mockUrl = "blob:http://localhost/fake-url";
    vi.stubGlobal("URL", {
      ...globalThis.URL,
      createObjectURL: vi.fn(() => mockUrl),
      revokeObjectURL: vi.fn(),
    });

    const file = createMockFile("photo.png", 1024, "image/png");
    const attachment = createFileAttachment(file);

    expect(attachment.previewUrl).toBe(mockUrl);
    expect(URL.createObjectURL).toHaveBeenCalledWith(file);

    vi.unstubAllGlobals();
  });

  it("does not set previewUrl for non-image files", () => {
    mockIsImageFile.mockReturnValue(false);
    const file = createMockFile("doc.pdf", 500, "application/pdf");

    const attachment = createFileAttachment(file);

    expect(attachment.previewUrl).toBeUndefined();
  });
});

describe("revokeFileAttachmentUrls", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", {
      ...globalThis.URL,
      createObjectURL: vi.fn(),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls revokeObjectURL for each attachment with a previewUrl", () => {
    const attachments: FileAttachment[] = [
      {
        id: "1",
        file: createMockFile("a.png", 10, "image/png"),
        previewUrl: "blob:a",
      },
      {
        id: "2",
        file: createMockFile("b.png", 10, "image/png"),
        previewUrl: "blob:b",
      },
    ];

    revokeFileAttachmentUrls(attachments);

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:a");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:b");
  });

  it("skips attachments without previewUrl", () => {
    const attachments: FileAttachment[] = [
      { id: "1", file: createMockFile("doc.pdf", 10, "application/pdf") },
      {
        id: "2",
        file: createMockFile("a.png", 10, "image/png"),
        previewUrl: "blob:a",
      },
    ];

    revokeFileAttachmentUrls(attachments);

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:a");
  });

  it("handles empty array", () => {
    revokeFileAttachmentUrls([]);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
});

describe("attachmentsToFiles", () => {
  it("maps attachments to their file properties", () => {
    const fileA = createMockFile("a.txt", 10, "text/plain");
    const fileB = createMockFile("b.pdf", 20, "application/pdf");
    const attachments: FileAttachment[] = [
      { id: "1", file: fileA },
      { id: "2", file: fileB },
    ];

    const result = attachmentsToFiles(attachments);

    expect(result).toEqual([fileA, fileB]);
  });
});

describe("attachmentsToFileUIParts", () => {
  beforeEach(() => {
    // Mock FileReader
    const mockFileReader = {
      readAsDataURL: vi.fn(function (this: any) {
        // Simulate async onload
        setTimeout(() => {
          this.result = "data:application/pdf;base64,abc123";
          this.onload?.();
        }, 0);
      }),
      result: null as string | null,
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };
    vi.stubGlobal(
      "FileReader",
      vi.fn(() => mockFileReader),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("converts attachments to FileUIPart[] with correct fields", async () => {
    const file = createMockFile("doc.pdf", 100, "application/pdf");
    const attachments: FileAttachment[] = [{ id: "1", file }];

    const parts = await attachmentsToFileUIParts(attachments);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      type: "file",
      mediaType: "application/pdf",
      filename: "doc.pdf",
      url: "data:application/pdf;base64,abc123",
    });
  });

  it("falls back to application/octet-stream when file type is empty", async () => {
    const file = createMockFile("mystery", 50, "");
    const attachments: FileAttachment[] = [{ id: "1", file }];

    const parts = await attachmentsToFileUIParts(attachments);

    expect(parts[0].mediaType).toBe("application/octet-stream");
  });
});

describe("getFileInputAccept", () => {
  it("returns comma-separated string with expected MIME types", () => {
    const accept = getFileInputAccept();

    const expected = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "application/pdf",
      "text/plain",
      "application/json",
      "text/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ];

    for (const mime of expected) {
      expect(accept).toContain(mime);
    }

    // Verify it's comma-separated
    expect(accept.split(",")).toHaveLength(expected.length);
  });
});
