import { FileText, Image, FileSpreadsheet, File } from "lucide-react";
import type { AnyPart } from "../thread-helpers";

type FilePart = Extract<AnyPart, { type: "file" }>;

/**
 * Checks if a MIME type represents an image
 */
function isImageMediaType(mediaType?: string): boolean {
  return mediaType?.startsWith("image/") ?? false;
}

/**
 * Gets the appropriate icon component for a file based on its MIME type
 */
function getFileIcon(mediaType?: string) {
  if (!mediaType) return File;

  if (mediaType.startsWith("image/")) {
    return Image;
  }
  if (mediaType === "application/pdf" || mediaType === "text/plain") {
    return FileText;
  }
  if (
    mediaType === "text/csv" ||
    mediaType === "application/vnd.ms-excel" ||
    mediaType.includes("spreadsheet")
  ) {
    return FileSpreadsheet;
  }
  return File;
}

/**
 * Truncates a filename while preserving the extension
 */
function truncateFilename(name: string, maxLength: number = 24): string {
  if (name.length <= maxLength) return name;

  const extIndex = name.lastIndexOf(".");
  if (extIndex === -1) {
    return name.slice(0, maxLength - 3) + "...";
  }

  const ext = name.slice(extIndex);
  const baseName = name.slice(0, extIndex);
  const maxBaseLength = maxLength - ext.length - 3;

  if (maxBaseLength <= 0) {
    return "..." + ext;
  }

  return baseName.slice(0, maxBaseLength) + "..." + ext;
}

export function FilePart({ part }: { part: FilePart }) {
  const filename = part.filename ?? "Attachment";
  const isImage = isImageMediaType(part.mediaType);

  // Render images as thumbnails
  if (isImage && part.url) {
    return (
      <div className="inline-block">
        <img
          src={part.url}
          alt={filename}
          className="max-w-xs max-h-48 rounded-md object-contain border border-border"
        />
        {part.filename && (
          <div
            className="text-xs text-muted-foreground mt-1 truncate max-w-xs text-right"
            title={part.filename}
          >
            {truncateFilename(part.filename)}
          </div>
        )}
      </div>
    );
  }

  // Render non-images as file cards
  const FileIcon = getFileIcon(part.mediaType);

  return (
    <div className="inline-flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
      <FileIcon className="h-5 w-5 text-muted-foreground flex-shrink-0" />
      <span
        className="font-medium text-foreground truncate max-w-[200px]"
        title={filename}
      >
        {truncateFilename(filename)}
      </span>
    </div>
  );
}
