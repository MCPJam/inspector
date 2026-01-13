import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";

interface EditableTextProps {
  value: string;
  onSave: (value: string) => void | Promise<void>;
  className?: string;
  inputClassName?: string;
  placeholder?: string;
  disabled?: boolean;
}

export function EditableText({
  value,
  onSave,
  className,
  inputClassName,
  placeholder = "Enter text...",
  disabled = false,
}: EditableTextProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedValue, setEditedValue] = useState(value);
  const [isSaving, setIsSaving] = useState(false);

  // Sync with external value changes
  useEffect(() => {
    if (!isEditing) {
      setEditedValue(value);
    }
  }, [value, isEditing]);

  const handleClick = () => {
    if (disabled) return;
    setEditedValue(value);
    setIsEditing(true);
  };

  const handleBlur = async () => {
    const trimmedValue = editedValue.trim();

    if (trimmedValue && trimmedValue !== value) {
      setIsSaving(true);
      try {
        await onSave(trimmedValue);
      } catch (error) {
        console.error("Failed to save:", error);
        setEditedValue(value);
      } finally {
        setIsSaving(false);
      }
    } else {
      setEditedValue(value);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleBlur();
    } else if (e.key === "Escape") {
      setEditedValue(value);
      setIsEditing(false);
    }
  };

  const baseStyles = "px-2 py-1 rounded-md transition-colors";

  if (isEditing) {
    return (
      <input
        type="text"
        value={editedValue}
        onChange={(e) => setEditedValue(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        autoFocus
        disabled={isSaving}
        placeholder={placeholder}
        className={cn(
          baseStyles,
          "border border-input focus:outline-none focus:ring-2 focus:ring-ring bg-background",
          inputClassName,
          className,
        )}
      />
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      className={cn(
        baseStyles,
        "hover:bg-accent text-left",
        disabled && "cursor-default hover:bg-transparent",
        className,
      )}
    >
      {value || placeholder}
    </button>
  );
}
