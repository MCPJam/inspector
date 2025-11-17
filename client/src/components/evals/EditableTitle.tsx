import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EditableTitleProps {
  value: string;
  onSave: (newValue: string) => Promise<void> | void;
  className?: string;
  inputClassName?: string;
  placeholder?: string;
  variant?: "h1" | "h2" | "h3" | "text";
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
}: EditableTitleProps) {
  const [isEditing, setIsEditing] = useState(false);
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
      handleSave();
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
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        autoFocus
        disabled={isSaving}
        placeholder={placeholder}
        className={cn(
          "px-3 py-2 border border-input rounded-md",
          "focus:outline-none focus:ring-2 focus:ring-ring",
          "bg-background",
          variantStyles[variant],
          isSaving && "opacity-50 cursor-wait",
          inputClassName,
        )}
      />
    );
  }

  return (
    <Button
      variant="ghost"
      onClick={() => setIsEditing(true)}
      className={cn(
        "px-3 py-2 h-auto hover:bg-accent",
        variantStyles[variant],
        className,
      )}
    >
      {value || <span className="text-muted-foreground">{placeholder}</span>}
    </Button>
  );
}
