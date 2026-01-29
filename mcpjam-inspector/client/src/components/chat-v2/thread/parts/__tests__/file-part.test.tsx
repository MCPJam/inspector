import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { FilePart } from "../file-part";

// Mock lucide-react icons as simple elements
vi.mock("lucide-react", () => ({
  FileText: (props: any) => <div data-testid="file-text-icon" {...props} />,
  Image: (props: any) => <div data-testid="image-icon" {...props} />,
  FileSpreadsheet: (props: any) => (
    <div data-testid="file-spreadsheet-icon" {...props} />
  ),
  File: (props: any) => <div data-testid="file-icon" {...props} />,
}));

// Helper to create a file part
function createFilePart(overrides: Record<string, unknown> = {}) {
  return {
    type: "file" as const,
    mediaType: "application/pdf",
    url: "data:application/pdf;base64,abc",
    filename: "document.pdf",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("FilePart", () => {
  it("renders <img> tag for image parts with a URL", () => {
    const part = createFilePart({
      mediaType: "image/png",
      url: "data:image/png;base64,abc",
      filename: "photo.png",
    });

    render(<FilePart part={part as any} />);

    const img = screen.getByRole("img");
    expect(img).toBeDefined();
    expect(img.getAttribute("src")).toBe("data:image/png;base64,abc");
    expect(img.getAttribute("alt")).toBe("photo.png");
  });

  it("shows filename caption below image when filename is provided", () => {
    const part = createFilePart({
      mediaType: "image/jpeg",
      url: "data:image/jpeg;base64,abc",
      filename: "vacation.jpg",
    });

    render(<FilePart part={part as any} />);

    expect(screen.getByText("vacation.jpg")).toBeDefined();
  });

  it("does not show caption when filename is absent", () => {
    const part = createFilePart({
      mediaType: "image/png",
      url: "data:image/png;base64,abc",
      filename: undefined,
    });

    render(<FilePart part={part as any} />);

    // Image should render but no caption text
    expect(screen.getByRole("img")).toBeDefined();
    // "Attachment" is only used in the file card fallback, not the image path
    expect(screen.queryByText("Attachment")).toBeNull();
  });

  it("renders file card for non-image media types", () => {
    const part = createFilePart({
      mediaType: "application/pdf",
      url: "data:application/pdf;base64,abc",
      filename: "report.pdf",
    });

    render(<FilePart part={part as any} />);

    // Should not render an img tag
    expect(screen.queryByRole("img")).toBeNull();
    // Should show the filename
    expect(screen.getByText("report.pdf")).toBeDefined();
    // Should show a file icon
    expect(screen.getByTestId("file-text-icon")).toBeDefined();
  });

  it("renders file card when URL is missing even for image types", () => {
    const part = createFilePart({
      mediaType: "image/png",
      url: undefined,
      filename: "photo.png",
    });

    render(<FilePart part={part as any} />);

    // Should not render an img tag (no URL)
    expect(screen.queryByRole("img")).toBeNull();
    // Should fall back to file card with image icon
    expect(screen.getByTestId("image-icon")).toBeDefined();
  });

  it('displays "Attachment" as fallback when filename is missing', () => {
    const part = createFilePart({
      mediaType: "application/pdf",
      filename: undefined,
    });

    render(<FilePart part={part as any} />);

    expect(screen.getByText("Attachment")).toBeDefined();
  });

  it("truncates long filenames", () => {
    const longName =
      "this-is-an-extremely-long-filename-for-testing-purposes.pdf";
    const part = createFilePart({
      mediaType: "application/pdf",
      filename: longName,
    });

    render(<FilePart part={part as any} />);

    // The title attribute should have the full name
    const el = screen.getByTitle(longName);
    expect(el).toBeDefined();
    // The visible text should be truncated
    expect(el.textContent!.length).toBeLessThan(longName.length);
  });
});
