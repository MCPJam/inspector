import { useState } from "react";
import { X, FileText, Image, FileSpreadsheet, File } from "lucide-react";
import { formatFileSize, isImageFile } from "@/lib/chat-utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
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
 * Compact card component for displaying a file attachment.
 *
 * Images render as a thumbnail only — the filename appears on hover and
 * clicking the thumbnail opens the image full screen. Other file types keep
 * the icon + filename + size card.
 */
export function FileAttachmentCard({
  attachment,
  onRemove,
}: FileAttachmentCardProps) {
  const { file, previewUrl } = attachment;
  const FileIcon = getFileIcon(file);
  const isImage = isImageFile(file);
  const [viewerOpen, setViewerOpen] = useState(false);

  if (isImage && previewUrl) {
    return (
      <div className="relative inline-block">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setViewerOpen(true)}
              className="block size-14 cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted/50 transition-colors hover:border-border/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Open ${file.name} full screen`}
            >
              <img
                src={previewUrl}
                alt={file.name}
                className="size-full object-cover"
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6} variant="muted">
            {file.name}
          </TooltipContent>
        </Tooltip>

        {/* Remove button */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="absolute -right-1.5 -top-1.5 z-10 flex size-5 items-center justify-center rounded-full border border-background bg-foreground text-background opacity-90 transition-opacity hover:opacity-100 cursor-pointer"
          aria-label={`Remove ${file.name}`}
        >
          <X size={12} />
        </button>

        {/* Full-screen viewer */}
        <Dialog open={viewerOpen} onOpenChange={setViewerOpen}>
          <DialogContent
            aria-describedby={undefined}
            showCloseButton={false}
            className="w-auto max-w-[95vw] overflow-visible border-0 bg-transparent p-0 shadow-none sm:max-w-[95vw]"
          >
            <DialogTitle className="sr-only">{file.name}</DialogTitle>
            <DialogClose
              type="button"
              className="absolute right-3 top-3 z-10 flex size-8 items-center justify-center rounded-full border border-white/15 bg-black/70 text-white/80 shadow-lg shadow-black/30 backdrop-blur-md transition-colors hover:bg-black/85 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              aria-label={`Close preview of ${file.name}`}
            >
              <X size={16} strokeWidth={2.25} />
            </DialogClose>
            <img
              src={previewUrl}
              alt={file.name}
              className="mx-auto max-h-[90vh] w-auto max-w-full rounded-lg object-contain"
            />
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2 py-1.5 text-xs hover:bg-muted/70 transition-colors">
      {/* Icon */}
      <FileIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />

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
