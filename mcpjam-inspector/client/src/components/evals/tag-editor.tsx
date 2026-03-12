import { useState, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { X, Plus, Tag } from "lucide-react";

interface TagBadgesProps {
  tags: string[];
  className?: string;
}

export function TagBadges({ tags, className }: TagBadgesProps) {
  if (tags.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1 ${className ?? ""}`}>
      {tags.map((tag) => (
        <Badge
          key={tag}
          variant="secondary"
          className="text-[10px] px-1.5 py-0 font-normal"
        >
          {tag}
        </Badge>
      ))}
    </div>
  );
}

interface TagEditorProps {
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  className?: string;
}

export function TagEditor({ tags, onTagsChange, className }: TagEditorProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [inputValue, setInputValue] = useState("");

  const handleAdd = useCallback(() => {
    const normalized = inputValue.trim().toLowerCase();
    if (normalized && !tags.includes(normalized)) {
      onTagsChange([...tags, normalized]);
    }
    setInputValue("");
    setIsAdding(false);
  }, [inputValue, tags, onTagsChange]);

  const handleRemove = useCallback(
    (tagToRemove: string) => {
      onTagsChange(tags.filter((t) => t !== tagToRemove));
    },
    [tags, onTagsChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAdd();
      } else if (e.key === "Escape") {
        setInputValue("");
        setIsAdding(false);
      }
    },
    [handleAdd],
  );

  return (
    <div className={`flex items-center gap-1.5 flex-wrap ${className ?? ""}`}>
      <Tag className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      {tags.map((tag) => (
        <Badge
          key={tag}
          variant="secondary"
          className="text-[10px] px-1.5 py-0 font-normal gap-1"
        >
          {tag}
          <button
            onClick={() => handleRemove(tag)}
            className="ml-0.5 hover:text-destructive"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </Badge>
      ))}
      {isAdding ? (
        <Input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onBlur={handleAdd}
          onKeyDown={handleKeyDown}
          autoFocus
          placeholder="tag name"
          className="h-5 w-20 text-[10px] px-1.5 py-0"
        />
      ) : (
        <button
          onClick={() => setIsAdding(true)}
          className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          {tags.length === 0 ? "Add tag" : ""}
        </button>
      )}
    </div>
  );
}
