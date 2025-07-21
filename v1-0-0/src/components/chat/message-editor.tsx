"use client";

import { useState, useRef, useEffect } from "react";
import { ChatMessage } from "@/lib/chat-types";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

interface MessageEditorProps {
  message: ChatMessage;
  onSave: (newContent: string) => void;
  onCancel: () => void;
}

export function MessageEditor({
  message,
  onSave,
  onCancel,
}: MessageEditorProps) {
  const [content, setContent] = useState(message.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
      adjustHeight();
    }
  }, []);

  const adjustHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  };

  const handleSave = () => {
    if (content.trim() !== message.content.trim()) {
      onSave(content.trim());
    } else {
      onCancel();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="w-full space-y-3">
      <Textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          adjustHeight();
        }}
        onKeyDown={handleKeyDown}
        className="min-h-[100px] resize-none"
        placeholder="Edit your message..."
      />
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!content.trim()}>
          Save
        </Button>
      </div>
    </div>
  );
}
