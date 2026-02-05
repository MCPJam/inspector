import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";

interface InlineEditableTextProps {
  value: string;
  onSave?: (newValue: string) => Promise<void>;
  className?: string;
  inputClassName?: string;
  disabled?: boolean;
  truncate?: boolean;
  /** Called on click events (useful for stopPropagation in lists) */
  onClick?: (e: React.MouseEvent) => void;
}

/**
 * A seamless inline editable text component.
 * Click to edit, Enter to save, Escape to cancel.
 * Uses transparent input styling for a seamless editing experience.
 */
export function InlineEditableText({
  value,
  onSave,
  className,
  inputClassName,
  disabled = false,
  truncate = true,
  onClick,
}: InlineEditableTextProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedValue, setEditedValue] = useState(value);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync edited value when external value changes
  useEffect(() => {
    setEditedValue(value);
  }, [value]);

  // Focus and select input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleStartEditing = useCallback(() => {
    if (!disabled && onSave) {
      setEditedValue(value);
      setIsEditing(true);
    }
  }, [disabled, onSave, value]);

  const handleCancel = useCallback(() => {
    setEditedValue(value);
    setIsEditing(false);
  }, [value]);

  const handleSave = useCallback(async () => {
    const trimmedValue = editedValue.trim();

    // Cancel if empty or unchanged
    if (!trimmedValue || trimmedValue === value) {
      handleCancel();
      return;
    }

    if (!onSave) {
      handleCancel();
      return;
    }

    setIsSaving(true);
    try {
      await onSave(trimmedValue);
      setIsEditing(false);
    } catch {
      // Keep editing mode on error so user can retry
    } finally {
      setIsSaving(false);
    }
  }, [editedValue, value, onSave, handleCancel]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSave();
      } else if (e.key === "Escape") {
        handleCancel();
      }
    },
    [handleSave, handleCancel],
  );

  const handleInputClick = useCallback(
    (e: React.MouseEvent) => {
      onClick?.(e);
    },
    [onClick],
  );

  const handleSpanClick = useCallback(
    (e: React.MouseEvent) => {
      onClick?.(e);
      handleStartEditing();
    },
    [onClick, handleStartEditing],
  );

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={editedValue}
        onChange={(e) => setEditedValue(e.target.value)}
        onClick={handleInputClick}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        disabled={isSaving}
        className={cn(
          "px-0 py-0 bg-transparent border-none focus:outline-none focus:ring-0",
          isSaving && "opacity-50",
          className,
          inputClassName,
        )}
      />
    );
  }

  return (
    <span
      onClick={handleSpanClick}
      className={cn(
        truncate && "truncate",
        !disabled &&
          onSave &&
          "cursor-pointer hover:opacity-60 transition-opacity",
        className,
      )}
    >
      {value}
    </span>
  );
}
