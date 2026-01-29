import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FileAttachmentCard } from "../file-attachment-card";
import type { FileAttachment } from "../file-utils";

// Mock @/lib/chat-utils
vi.mock("@/lib/chat-utils", () => ({
  isImageFile: vi.fn(),
  formatFileSize: vi.fn((bytes: number) => `${bytes} B`),
}));

import { isImageFile, formatFileSize } from "@/lib/chat-utils";

const mockIsImageFile = vi.mocked(isImageFile);
const mockFormatFileSize = vi.mocked(formatFileSize);

// Mock lucide-react icons as simple elements
vi.mock("lucide-react", () => ({
  X: (props: any) => <div data-testid="x-icon" {...props} />,
  FileText: (props: any) => <div data-testid="file-text-icon" {...props} />,
  Image: (props: any) => <div data-testid="image-icon" {...props} />,
  FileSpreadsheet: (props: any) => (
    <div data-testid="file-spreadsheet-icon" {...props} />
  ),
  File: (props: any) => <div data-testid="file-icon" {...props} />,
}));

function createMockFile(name: string, size: number, type: string): File {
  return new File([new Uint8Array(size)], name, { type });
}

function createAttachment(
  overrides: Partial<FileAttachment> & {
    fileName?: string;
    fileSize?: number;
    fileType?: string;
  } = {},
): FileAttachment {
  const {
    fileName = "test.txt",
    fileSize = 1024,
    fileType = "text/plain",
    ...rest
  } = overrides;
  return {
    id: "test-id",
    file: createMockFile(fileName, fileSize, fileType),
    ...rest,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFormatFileSize.mockImplementation((bytes: number) => `${bytes} B`);
});

describe("FileAttachmentCard", () => {
  it("renders image thumbnail when attachment is an image with previewUrl", () => {
    mockIsImageFile.mockReturnValue(true);
    const attachment = createAttachment({
      fileName: "photo.png",
      fileType: "image/png",
      previewUrl: "blob:http://localhost/fake",
    });

    render(<FileAttachmentCard attachment={attachment} onRemove={vi.fn()} />);

    const img = screen.getByRole("img");
    expect(img).toBeDefined();
    expect(img.getAttribute("src")).toBe("blob:http://localhost/fake");
    expect(img.getAttribute("alt")).toBe("photo.png");
  });

  it("renders file icon for non-image attachments", () => {
    mockIsImageFile.mockReturnValue(false);
    const attachment = createAttachment({
      fileName: "doc.pdf",
      fileType: "application/pdf",
    });

    render(<FileAttachmentCard attachment={attachment} onRemove={vi.fn()} />);

    expect(screen.queryByRole("img")).toBeNull();
    // Should render a file icon (FileText for PDF)
    expect(screen.getByTestId("file-text-icon")).toBeDefined();
  });

  it("displays truncated filename with full name in title attribute", () => {
    mockIsImageFile.mockReturnValue(false);
    const longName = "this-is-a-very-long-filename-for-testing.pdf";
    const attachment = createAttachment({ fileName: longName });

    render(<FileAttachmentCard attachment={attachment} onRemove={vi.fn()} />);

    const nameEl = screen.getByTitle(longName);
    expect(nameEl).toBeDefined();
    // The displayed text should be truncated (shorter than original)
    expect(nameEl.textContent!.length).toBeLessThan(longName.length);
  });

  it("displays formatted file size", () => {
    mockIsImageFile.mockReturnValue(false);
    mockFormatFileSize.mockReturnValue("2.5 KB");
    const attachment = createAttachment({ fileSize: 2560 });

    render(<FileAttachmentCard attachment={attachment} onRemove={vi.fn()} />);

    expect(screen.getByText("2.5 KB")).toBeDefined();
    expect(mockFormatFileSize).toHaveBeenCalledWith(2560);
  });

  it("calls onRemove when remove button is clicked", () => {
    mockIsImageFile.mockReturnValue(false);
    const onRemove = vi.fn();
    const attachment = createAttachment();

    render(<FileAttachmentCard attachment={attachment} onRemove={onRemove} />);

    const removeBtn = screen.getByRole("button", { name: /remove/i });
    fireEvent.click(removeBtn);

    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("remove button has correct aria-label", () => {
    mockIsImageFile.mockReturnValue(false);
    const attachment = createAttachment({ fileName: "report.pdf" });

    render(<FileAttachmentCard attachment={attachment} onRemove={vi.fn()} />);

    const removeBtn = screen.getByRole("button", { name: "Remove report.pdf" });
    expect(removeBtn).toBeDefined();
  });
});
