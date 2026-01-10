import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { ChatMessage } from "./types/chat-types";
import { ModelDefinition } from "@/shared/types.js";
import { getDefaultTemperatureByProvider } from "@/shared/chat-utils.js";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function generateId(): string {
  return Math.random().toString(36).substr(2, 9);
}

export interface ParsedMessageContent {
  reasoning?: string;
  content: string;
}

/**
 * Parses LLM reasoning tags and extracts both reasoning and final content
 * Example: <|channel|>analysis<|message|>reasoning here<|end|><|start|>assistant<|channel|>final<|message|>response here
 */
export function parseReasoningTags(text: string): ParsedMessageContent {
  const reasoningMatch = text.match(
    /<\|channel\|>analysis<\|message\|>(.*?)(?:<\|end\|>|<\|start\|>)/s,
  );
  const finalMatch = text.match(/<\|channel\|>final<\|message\|>(.*?)$/s);

  // If we found structured content with tags
  if (reasoningMatch || finalMatch) {
    return {
      reasoning: reasoningMatch ? reasoningMatch[1].trim() : undefined,
      content: finalMatch
        ? finalMatch[1].trim()
        : text.replace(/<\|[^|]+\|>/g, "").trim(),
    };
  }

  // No tags found, return original content
  return {
    content: text,
  };
}

export function sanitizeText(text: string): string {
  // Basic trimming
  let value = text.trim();

  // Auto-close unbalanced fenced code blocks to avoid broken Markdown rendering
  // Count occurrences of triple backticks. If odd, append closing fence.
  // This is safe because it only affects display, not the raw content storage.
  try {
    const fenceRegex = /```/g;
    const matches = value.match(fenceRegex);
    const count = matches ? matches.length : 0;
    if (count % 2 === 1) {
      // Add a newline before closing to ensure proper block termination
      value = value.endsWith("\n") ? value + "```" : value + "\n```";
    }
  } catch {
    // If anything goes wrong, fall back to original trimmed text
  }

  return value;
}

export function formatTimestamp(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

export function formatMessageDate(date: Date): string {
  const now = new Date();
  const diffInMs = now.getTime() - date.getTime();
  const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

  if (diffInDays === 0) {
    return formatTimestamp(date);
  } else if (diffInDays === 1) {
    return `Yesterday ${formatTimestamp(date)}`;
  } else if (diffInDays < 7) {
    return `${diffInDays} days ago`;
  } else {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    }).format(date);
  }
}

export function createMessage(
  role: "user" | "assistant",
  content: string,
  attachments?: any[],
): ChatMessage {
  return {
    id: generateId(),
    role,
    content,
    timestamp: new Date(),
    attachments,
    metadata: {
      createdAt: new Date().toISOString(),
    },
  };
}

export function isValidFileType(file: File): boolean {
  const allowedTypes = [
    "text/plain",
    "application/pdf",
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/json",
    "text/csv",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ];

  return allowedTypes.includes(file.type);
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

export function isImageUrl(url: string): boolean {
  const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"];
  const lowerUrl = url.toLowerCase();
  return (
    imageExtensions.some((ext) => lowerUrl.includes(ext)) ||
    lowerUrl.includes("data:image/") ||
    lowerUrl.includes("blob:")
  );
}

export function getImageDimensions(
  url: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = reject;
    img.src = url;
  });
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + "...";
}

export function scrollToBottom(element?: Element | null) {
  if (element) {
    element.scrollTop = element.scrollHeight;
  } else {
    window.scrollTo(0, document.body.scrollHeight);
  }
}

export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

export function getDefaultTemperatureForModel(model: ModelDefinition): number {
  return getDefaultTemperatureByProvider(model.provider);
}
