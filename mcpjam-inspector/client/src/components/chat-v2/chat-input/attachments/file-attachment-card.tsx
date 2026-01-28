import { X, FileText, Image, FileSpreadsheet, File } from "lucide-react";
import { formatFileSize, isImageFile } from "@/lib/chat-utils";
import type { FileAttachment } from "./file-utils";

interface FileAttachmentCardProps {
  attachment: FileAttachment;
  onRemove: () => void;
}

/**
 * Gets the appropriate icon for a file based on its MIME type
 */
function getFileIcon(file: File) {
  const type = file.type;

  if (type.startsWith("image/")) {
    return Image;
  }
  if (type === "application/pdf" || type === "text/plain") {
    return FileText;
  }
  if (
    type === "text/csv" ||
    type === "application/vnd.ms-excel" ||
    type.includes("spreadsheet")
  ) {
    return FileSpreadsheet;
  }
  return File;
}

/**
 * Truncates a filename, preserving the extension
 */
function truncateFilename(name: string, maxLength: number = 20): string {
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

/**
 * Compact card component for displaying a file attachment
 * Shows file icon/thumbnail, truncated filename, file size, and remove button
 */
export function FileAttachmentCard({
  attachment,
  onRemove,
}: FileAttachmentCardProps) {
  const { file, previewUrl } = attachment;
  const FileIcon = getFileIcon(file);
  const isImage = isImageFile(file);

  return (
    <div className="inline-flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2 py-1.5 text-xs hover:bg-muted/70 transition-colors">
      {/* Icon or image preview */}
      {isImage && previewUrl ? (
        <img
          src={previewUrl}
          alt={file.name}
          className="h-6 w-6 rounded object-cover flex-shrink-0"
        />
      ) : (
        <FileIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      )}

      {/* File info */}
      <div className="flex flex-col min-w-0">
        <span
          className="font-medium text-foreground truncate max-w-[140px]"
          title={file.name}
        >
          {truncateFilename(file.name)}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {formatFileSize(file.size)}
        </span>
      </div>

      {/* Remove button */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="flex-shrink-0 rounded-sm opacity-60 hover:opacity-100 transition-opacity hover:bg-accent p-0.5 cursor-pointer"
        aria-label={`Remove ${file.name}`}
      >
        <X size={12} className="text-muted-foreground" />
      </button>
    </div>
  );
}
