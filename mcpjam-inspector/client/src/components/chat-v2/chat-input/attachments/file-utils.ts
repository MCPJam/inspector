import { isValidFileType, isImageFile, formatFileSize } from "@/lib/chat-utils";

/**
 * Maximum file size in bytes (10MB)
 * Data URLs can become large; this matches common LLM provider constraints
 */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Represents a file attachment in the chat input
 */
export interface FileAttachment {
  /** Unique ID for React keys and tracking */
  id: string;
  /** The actual File object */
  file: File;
  /** Optional preview URL for image thumbnails (created via URL.createObjectURL) */
  previewUrl?: string;
}

/**
 * Validation result for file upload
 */
export interface FileValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates a file for upload
 * Checks both file type (using existing isValidFileType) and file size
 */
export function validateFile(file: File): FileValidationResult {
  // Check file type
  if (!isValidFileType(file)) {
    const allowedTypes = [
      "Images (JPEG, PNG, GIF, WebP)",
      "Documents (PDF, TXT, JSON)",
      "Spreadsheets (CSV, Excel)",
    ].join(", ");
    return {
      valid: false,
      error: `Unsupported file type: ${file.type || "unknown"}. Allowed: ${allowedTypes}`,
    };
  }

  // Check file size
  if (file.size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `File too large: ${formatFileSize(file.size)}. Maximum size: ${formatFileSize(MAX_FILE_SIZE)}`,
    };
  }

  return { valid: true };
}

/**
 * Generates a unique ID for file attachments
 */
export function generateFileId(): string {
  return `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Creates a FileAttachment from a File, including preview URL for images
 */
export function createFileAttachment(file: File): FileAttachment {
  const attachment: FileAttachment = {
    id: generateFileId(),
    file,
  };

  // Create preview URL for images
  if (isImageFile(file)) {
    attachment.previewUrl = URL.createObjectURL(file);
  }

  return attachment;
}

/**
 * Revokes object URLs for file attachments to prevent memory leaks
 * Should be called when attachments are removed or cleared
 */
export function revokeFileAttachmentUrls(attachments: FileAttachment[]): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }
}

/**
 * Converts FileAttachments to File[] (used internally)
 */
export function attachmentsToFiles(attachments: FileAttachment[]): File[] {
  return attachments.map((a) => a.file);
}

/**
 * FileUIPart format expected by AI SDK
 */
export interface FileUIPart {
  type: "file";
  mediaType: string;
  filename?: string;
  url: string;
}

/**
 * Converts a File to a data URL
 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to read file as data URL"));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Converts FileAttachments to FileUIPart[] format for the AI SDK
 * The AI SDK expects { type: 'file', mediaType, filename, url } objects
 */
export async function attachmentsToFileUIParts(
  attachments: FileAttachment[],
): Promise<FileUIPart[]> {
  const parts: FileUIPart[] = [];

  for (const attachment of attachments) {
    const dataUrl = await fileToDataUrl(attachment.file);
    parts.push({
      type: "file",
      mediaType: attachment.file.type || "application/octet-stream",
      filename: attachment.file.name,
      url: dataUrl,
    });
  }

  return parts;
}

/**
 * Gets accept string for file input based on allowed types
 */
export function getFileInputAccept(): string {
  return [
    // Images
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    // Documents
    "application/pdf",
    "text/plain",
    "application/json",
    // Spreadsheets
    "text/csv",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ].join(",");
}
