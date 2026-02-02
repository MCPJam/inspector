import { useState, useCallback, useMemo, Fragment } from "react";
import { Copy, Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { tokenizeJson, formatPath } from "./json-syntax-highlighter";
import { TruncatableString } from "./truncatable-string";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface JsonHighlighterProps {
  content: string;
  onCopy?: (value: string) => void;
  collapseStringsAfterLength?: number;
}

interface CopyableValueProps {
  children: React.ReactNode;
  value: string;
  keyName?: string;
  path?: (string | number)[];
  isKey?: boolean;
  onCopy?: (value: string) => void;
}

function CopyableValue({
  children,
  value,
  keyName,
  path,
  isKey,
  onCopy,
}: CopyableValueProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const [isHovered, setIsHovered] = useState(false);

  const copyToClipboard = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(label);
        onCopy?.(text);
        setTimeout(() => setCopied(null), 1500);
      } catch {
        // Fallback for older browsers
        const textarea = document.createElement("textarea");
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        setCopied(label);
        onCopy?.(text);
        setTimeout(() => setCopied(null), 1500);
      }
    },
    [onCopy]
  );

  const formattedPath = path && path.length > 0 ? formatPath(path) : null;

  // Build menu items based on what's available
  const menuItems: { label: string; value: string; key: string }[] = [];

  if (isKey) {
    // For keys: Copy key, Copy path
    menuItems.push({ label: "Copy key", value: value, key: "key" });
    if (formattedPath) {
      menuItems.push({ label: "Copy path", value: formattedPath, key: "path" });
    }
  } else {
    // For values: Copy value, Copy key (if available), Copy path (if available)
    menuItems.push({ label: "Copy value", value: value, key: "value" });
    if (keyName) {
      menuItems.push({ label: "Copy key", value: keyName, key: "key" });
    }
    if (formattedPath) {
      menuItems.push({ label: "Copy path", value: formattedPath, key: "path" });
    }
  }

  // If only one option, show simple button
  if (menuItems.length === 1) {
    return (
      <span
        className="relative inline-flex items-center group/copy"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {children}
        <button
          onClick={(e) => {
            e.stopPropagation();
            copyToClipboard(menuItems[0].value, menuItems[0].key);
          }}
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

  // Multiple options: show dropdown
  return (
    <span
      className="relative inline-flex items-center group/copy"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {children}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "inline-flex items-center justify-center ml-1 p-0.5 rounded",
              "transition-all duration-150",
              "hover:bg-muted",
              isHovered || copied ? "opacity-100" : "opacity-0"
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
              onClick={() => copyToClipboard(item.value, item.key)}
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

export function JsonHighlighter({
  content,
  onCopy,
  collapseStringsAfterLength,
}: JsonHighlighterProps) {
  const elements = useMemo(() => {
    const tokens = tokenizeJson(content);
    const result: React.ReactNode[] = [];
    let lastIndex = 0;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      // Add any whitespace between tokens
      if (token.start > lastIndex) {
        result.push(
          <Fragment key={`ws-${lastIndex}`}>
            {content.slice(lastIndex, token.start)}
          </Fragment>
        );
      }

      const className = `json-${token.type}`;

      // Determine if this token should be copyable
      const isCopyable =
        token.type === "key" ||
        token.type === "string" ||
        token.type === "number" ||
        token.type === "boolean" ||
        token.type === "boolean-false" ||
        token.type === "null";

      // Get the raw value to copy (without quotes for strings/keys)
      const getCopyValue = () => {
        if (token.type === "string" || token.type === "key") {
          // Remove surrounding quotes and unescape
          try {
            return JSON.parse(token.value);
          } catch {
            // If parsing fails, just remove quotes
            return token.value.slice(1, -1);
          }
        }
        return token.value;
      };

      // Use TruncatableString for strings when truncation is enabled
      if (token.type === "string" && collapseStringsAfterLength !== undefined) {
        const rawValue = getCopyValue();
        result.push(
          <TruncatableString
            key={`token-${i}`}
            value={rawValue}
            displayValue={token.value}
            maxLength={collapseStringsAfterLength}
            onCopy={onCopy}
            keyName={token.keyName}
            path={token.path}
          />
        );
      } else if (isCopyable) {
        result.push(
          <CopyableValue
            key={`token-${i}`}
            value={getCopyValue()}
            keyName={token.keyName}
            path={token.path}
            isKey={token.type === "key"}
            onCopy={onCopy}
          >
            <span className={className}>{token.value}</span>
          </CopyableValue>
        );
      } else {
        result.push(
          <span key={`token-${i}`} className={className}>
            {token.value}
          </span>
        );
      }

      lastIndex = token.end;
    }

    // Add any remaining content
    if (lastIndex < content.length) {
      result.push(
        <Fragment key={`ws-end`}>{content.slice(lastIndex)}</Fragment>
      );
    }

    // Add trailing newline like the HTML version
    result.push(<Fragment key="trailing-newline">{"\n"}</Fragment>);

    return result;
  }, [content, onCopy, collapseStringsAfterLength]);

  return <>{elements}</>;
}
