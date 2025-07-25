import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { ChatMessage } from "./chat-types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function generateId(): string {
  return Math.random().toString(36).substr(2, 9);
}

export function sanitizeText(text: string): string {
  // Basic sanitization - in production you might want more robust sanitization
  return text.trim();
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
