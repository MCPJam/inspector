import { useState, useCallback } from "react";
import { Copy, Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { formatPath } from "./json-syntax-highlighter";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface TruncatableStringProps {
  value: string;
  displayValue: string;
  maxLength: number;
  onCopy?: (value: string) => void;
  keyName?: string;
  path?: (string | number)[];
}

export function TruncatableString({
  value,
  displayValue,
  maxLength,
  onCopy,
  keyName,
  path,
}: TruncatableStringProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const shouldTruncate = value.length > maxLength;
  const truncatedDisplay =
    shouldTruncate && !isExpanded
      ? `"${value.slice(0, maxLength)}..."`
      : displayValue;

  const handleCopy = useCallback(
    async (text: string, label: string) => {
      const success = await copyToClipboard(text);
      if (success) {
        setCopied(label);
        onCopy?.(text);
        setTimeout(() => setCopied(null), 1500);
      }
    },
    [onCopy],
  );

  const handleToggleExpand = useCallback(
    (e: React.MouseEvent) => {
      if (shouldTruncate) {
        e.stopPropagation();
        setIsExpanded((prev) => !prev);
      }
    },
    [shouldTruncate],
  );

  const formattedPath = path && path.length > 0 ? formatPath(path) : null;

  // Build menu items
  const menuItems: { label: string; value: string; key: string }[] = [];
  menuItems.push({ label: "Copy value", value: value, key: "value" });
  if (keyName) {
    menuItems.push({ label: "Copy key", value: keyName, key: "key" });
  }
  if (formattedPath) {
    menuItems.push({ label: "Copy path", value: formattedPath, key: "path" });
  }

  // If only one option, show simple button
  if (menuItems.length === 1) {
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
            shouldTruncate && !isExpanded && "json-string-truncated",
          )}
        >
          {truncatedDisplay}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleCopy(menuItems[0].value, menuItems[0].key);
          }}
          className={cn(
            "inline-flex items-center justify-center ml-1 p-0.5 rounded",
            "transition-all duration-150",
            "hover:bg-muted",
            isHovered || copied ? "opacity-100" : "opacity-0",
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

  // Multiple options: show dropdown
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
          shouldTruncate && !isExpanded && "json-string-truncated",
        )}
      >
        {truncatedDisplay}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "inline-flex items-center justify-center ml-1 p-0.5 rounded",
              "transition-all duration-150",
              "hover:bg-muted",
              isHovered || copied ? "opacity-100" : "opacity-0",
            )}
            style={{ verticalAlign: "middle" }}
            onClick={(e) => e.stopPropagation()}
          >
            {copied ? (
              <Check className="h-3 w-3 text-green-500" />
            ) : (
              <>
                <Copy className="h-3 w-3 text-muted-foreground/60" />
                <ChevronDown className="h-2 w-2 text-muted-foreground/60 -ml-0.5" />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[140px]">
          {menuItems.map((item) => (
            <DropdownMenuItem
              key={item.key}
              onClick={() => handleCopy(item.value, item.key)}
              className="text-xs"
            >
              <Copy className="h-3 w-3 mr-2" />
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
