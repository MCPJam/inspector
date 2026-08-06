import { useState, useEffect } from "react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";

interface EditableTitleProps {
  value: string;
  onSave: (newValue: string) => Promise<void> | void;
  className?: string;
  inputClassName?: string;
  placeholder?: string;
  variant?: "h1" | "h2" | "h3" | "text";
  /** Begin in edit mode on mount (e.g. after inline create). */
  startInEditMode?: boolean;
  /** Stretch the trigger/input to the container width. */
  fullWidth?: boolean;
  /** Truncate the read-only label. */
  truncate?: boolean;
}

const variantStyles = {
  h1: "text-2xl font-bold",
  h2: "text-lg font-semibold",
  h3: "text-base font-semibold",
  text: "text-sm font-medium",
} as const;

export function EditableTitle({
  value,
  onSave,
  className,
  inputClassName,
  placeholder = "Untitled",
  variant = "h2",
  startInEditMode = false,
  fullWidth = false,
  truncate = true,
}: EditableTitleProps) {
  const [isEditing, setIsEditing] = useState(startInEditMode);
  const [editedValue, setEditedValue] = useState(value);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setEditedValue(value);
  }, [value]);

  const handleSave = async () => {
    if (editedValue.trim() === value) {
      setIsEditing(false);
      return;
    }

    if (!editedValue.trim()) {
      setEditedValue(value);
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    try {
      await onSave(editedValue.trim());
      setIsEditing(false);
    } catch (error) {
      console.error("Failed to save title:", error);
      setEditedValue(value);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setEditedValue(value);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      void handleSave();
    } else if (e.key === "Escape") {
      handleCancel();
    }
  };

  if (isEditing) {
    return (
      <input
        type="text"
        value={editedValue}
        onChange={(e) => setEditedValue(e.target.value)}
        onBlur={() => void handleSave()}
        onKeyDown={handleKeyDown}
        autoFocus
        disabled={isSaving}
        placeholder={placeholder}
        title={value}
        className={cn(
          "rounded-md border border-input bg-background px-3 py-2",
          "focus:outline-none focus:ring-2 focus:ring-ring",
          variantStyles[variant],
          fullWidth && "w-full min-w-0",
          isSaving && "cursor-wait opacity-50",
          inputClassName,
        )}
      />
    );
  }

  const display = value || placeholder;
  const showingPlaceholder = !value;

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => setIsEditing(true)}
      title={value || undefined}
      className={cn(
        "h-auto gap-0 px-3 py-2 hover:bg-accent",
        fullWidth && "w-full min-w-0 max-w-full justify-start text-left",
        variantStyles[variant],
        className,
      )}
    >
      <span
        className={cn(
          truncate && "truncate",
          showingPlaceholder && "text-muted-foreground",
        )}
      >
        {display}
      </span>
    </Button>
  );
}
