import { useState, useCallback, useMemo, Fragment } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { tokenizeJson } from "./json-syntax-highlighter";
import { TruncatableString } from "./truncatable-string";

interface JsonHighlighterProps {
  content: string;
  onCopy?: (value: string) => void;
  collapseStringsAfterLength?: number;
}

interface CopyableValueProps {
  children: React.ReactNode;
  value: string;
  onCopy?: (value: string) => void;
}

function CopyableValue({ children, value, onCopy }: CopyableValueProps) {
  const [copied, setCopied] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const handleCopy = useCallback(
    async (text: string) => {
      const success = await copyToClipboard(text);
      if (success) {
        setCopied(true);
        onCopy?.(text);
        setTimeout(() => setCopied(false), 1500);
      }
    },
    [onCopy],
  );

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
          handleCopy(value);
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

// Helper to extract the full object/array content from a position
function extractObjectOrArray(content: string, startPos: number): string {
  const openChar = content[startPos];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 1;
  let i = startPos + 1;
  let inString = false;
  let escape = false;

  while (i < content.length && depth > 0) {
    const char = content[i];

    if (escape) {
      escape = false;
    } else if (char === "\\") {
      escape = true;
    } else if (char === '"') {
      inString = !inString;
    } else if (!inString) {
      if (char === openChar) {
        depth++;
      } else if (char === closeChar) {
        depth--;
      }
    }
    i++;
  }

  return content.slice(startPos, i);
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
    // Track when a key's value is an object/array
    let pendingObjectCopy: { start: number } | null = null;

    // Helper to find the next value token (skip colon punctuation)
    const findNextValueToken = (startIndex: number) => {
      for (let j = startIndex + 1; j < tokens.length; j++) {
        const nextToken = tokens[j];
        if (nextToken.type === "punctuation" && nextToken.value === ":")
          continue;
        return nextToken;
      }
      return null;
    };

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      // Add any whitespace between tokens
      if (token.start > lastIndex) {
        result.push(
          <Fragment key={`ws-${lastIndex}`}>
            {content.slice(lastIndex, token.start)}
          </Fragment>,
        );
      }

      const className = `json-${token.type}`;

      // Check if this key's value is an object or array
      if (token.type === "key") {
        const nextValueToken = findNextValueToken(i);
        if (
          nextValueToken &&
          nextValueToken.type === "punctuation" &&
          (nextValueToken.value === "{" || nextValueToken.value === "[")
        ) {
          // Mark that we need to add copy to the opening brace
          pendingObjectCopy = { start: nextValueToken.start };
        }
        // Render key without copy button
        result.push(
          <span key={`token-${i}`} className={className}>
            {token.value}
          </span>,
        );
        lastIndex = token.end;
        continue;
      }

      // Handle opening brace/bracket with pending object copy
      if (
        pendingObjectCopy &&
        token.type === "punctuation" &&
        (token.value === "{" || token.value === "[") &&
        token.start === pendingObjectCopy.start
      ) {
        const objectContent = extractObjectOrArray(content, token.start);
        pendingObjectCopy = null;
        result.push(
          <CopyableValue
            key={`token-${i}`}
            value={objectContent}
            onCopy={onCopy}
          >
            <span className={className}>{token.value}</span>
          </CopyableValue>,
        );
        lastIndex = token.end;
        continue;
      }

      // Determine if this token should be copyable (values only, not keys)
      const isCopyable =
        token.type === "string" ||
        token.type === "number" ||
        token.type === "boolean" ||
        token.type === "boolean-false" ||
        token.type === "null";

      // Get the raw value to copy (without quotes for strings)
      const getCopyValue = () => {
        if (token.type === "string") {
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
          />,
        );
      } else if (isCopyable) {
        result.push(
          <CopyableValue
            key={`token-${i}`}
            value={getCopyValue()}
            onCopy={onCopy}
          >
            <span className={className}>{token.value}</span>
          </CopyableValue>,
        );
      } else {
        result.push(
          <span key={`token-${i}`} className={className}>
            {token.value}
          </span>,
        );
      }

      lastIndex = token.end;
    }

    // Add any remaining content
    if (lastIndex < content.length) {
      result.push(
        <Fragment key={`ws-end`}>{content.slice(lastIndex)}</Fragment>,
      );
    }

    // Add trailing newline like the HTML version
    result.push(<Fragment key="trailing-newline">{"\n"}</Fragment>);

    return result;
  }, [content, onCopy, collapseStringsAfterLength]);

  return <>{elements}</>;
}
