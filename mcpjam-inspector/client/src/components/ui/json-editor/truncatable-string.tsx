import { useState, useCallback } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface TruncatableStringProps {
  value: string;
  displayValue: string;
  maxLength: number;
  onCopy?: (value: string) => void;
}

export function TruncatableString({
  value,
  displayValue,
  maxLength,
  onCopy,
}: TruncatableStringProps) {
  const [copied, setCopied] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const shouldTruncate = value.length > maxLength;
  const truncatedDisplay = shouldTruncate && !isExpanded
    ? `"${value.slice(0, maxLength)}..."`
    : displayValue;

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        onCopy?.(value);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        setCopied(true);
        onCopy?.(value);
        setTimeout(() => setCopied(false), 1500);
      }
    },
    [value, onCopy]
  );

  const handleToggleExpand = useCallback((e: React.MouseEvent) => {
    if (shouldTruncate) {
      e.stopPropagation();
      setIsExpanded((prev) => !prev);
    }
  }, [shouldTruncate]);

  return (
    <span
      className="relative inline-flex items-center group/copy"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <span
        onClick={handleToggleExpand}
        className={cn(
          "json-string",
          shouldTruncate && !isExpanded && "json-string-truncated"
        )}
      >
        {truncatedDisplay}
      </span>
      <button
        onClick={handleCopy}
        className={cn(
          "inline-flex items-center justify-center ml-1 p-0.5 rounded",
          "transition-all duration-150",
          "hover:bg-muted",
          isHovered || copied ? "opacity-100" : "opacity-0"
        )}
        style={{ verticalAlign: "middle" }}
      >
        {copied ? (
          <Check className="h-3 w-3 text-green-500" />
        ) : (
          <Copy className="h-3 w-3 text-muted-foreground/60 hover:text-muted-foreground" />
        )}
      </button>
    </span>
  );
}
