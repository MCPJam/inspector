"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/chat-utils";
import { Attachment } from "@/lib/chat-types";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ArrowUpIcon, PaperclipIcon, StopIcon } from "../icons";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowDown } from "lucide-react";

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (message: string, attachments?: Attachment[]) => void;
  onStop?: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  placeholder?: string;
  className?: string;
  showScrollToBottom?: boolean;
  onScrollToBottom?: () => void;
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  onStop,
  disabled = false,
  isLoading = false,
  placeholder = "Type your message...",
  className,
  showScrollToBottom = false,
  onScrollToBottom,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadQueue, setUploadQueue] = useState<string[]>([]);

  useEffect(() => {
    adjustHeight();
  }, [value]);

  const adjustHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  };

  const resetHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleSubmit = useCallback(() => {
    if (!value.trim() || disabled || isLoading || uploadQueue.length > 0)
      return;

    onSubmit(value.trim(), attachments.length > 0 ? attachments : undefined);
    onChange("");
    setAttachments([]);
    resetHeight();

    // Focus back to textarea
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
  }, [
    value,
    disabled,
    isLoading,
    uploadQueue.length,
    onSubmit,
    attachments,
    onChange,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;

      setUploadQueue(files.map((f) => f.name));

      try {
        // Mock file upload - in real implementation, upload to your backend
        const uploadedFiles: Attachment[] = await Promise.all(
          files.map(async (file) => {
            // Simulate upload delay
            await new Promise((resolve) => setTimeout(resolve, 1000));

            return {
              id: Math.random().toString(36).substr(2, 9),
              name: file.name,
              url: URL.createObjectURL(file), // Temporary URL for demo
              contentType: file.type,
              size: file.size,
            };
          }),
        );

        setAttachments((prev) => [...prev, ...uploadedFiles]);
      } catch (error) {
        console.error("Error uploading files:", error);
      } finally {
        setUploadQueue([]);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    },
    [],
  );

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <div className="relative w-full">
      {/* Scroll to bottom button */}
      <AnimatePresence>
        {showScrollToBottom && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="absolute left-1/2 bottom-full mb-4 -translate-x-1/2 z-50"
          >
            <Button
              size="sm"
              variant="outline"
              className="rounded-full shadow-lg"
              onClick={onScrollToBottom}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* File input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileChange}
        accept="image/*,.pdf,.txt,.json,.csv"
      />

      {/* Attachments preview */}
      {(attachments.length > 0 || uploadQueue.length > 0) && (
        <div className="mb-3 flex flex-wrap gap-2">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className="flex items-center gap-2 bg-muted px-3 py-2 rounded-lg text-sm"
            >
              <span className="truncate max-w-[200px]">{attachment.name}</span>
              <button
                onClick={() => removeAttachment(attachment.id)}
                className="text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </div>
          ))}
          {uploadQueue.map((filename) => (
            <div
              key={filename}
              className="flex items-center gap-2 bg-muted/50 px-3 py-2 rounded-lg text-sm animate-pulse"
            >
              <span className="truncate max-w-[200px]">{filename}</span>
              <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
            </div>
          ))}
        </div>
      )}

      {/* Input container */}
      <div className="relative">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            "min-h-[80px] max-h-[200px] resize-none pr-20 pb-12",
            "focus-visible:ring-1",
            className,
          )}
          rows={2}
          autoFocus
        />

        {/* Attachment button */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="absolute bottom-2 left-2 h-8 w-8 p-0"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || isLoading}
        >
          <PaperclipIcon size={16} />
        </Button>

        {/* Submit/Stop button */}
        <div className="absolute bottom-2 right-2">
          {isLoading ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 w-8 p-0 rounded-full"
              onClick={onStop}
            >
              <StopIcon size={16} />
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              className="h-8 w-8 p-0 rounded-full"
              onClick={handleSubmit}
              disabled={!value.trim() || disabled || uploadQueue.length > 0}
            >
              <ArrowUpIcon size={16} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
