import { useState, useCallback, useMemo, Fragment } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { tokenizeJson } from "./json-syntax-highlighter";

interface JsonHighlighterProps {
  content: string;
  onCopy?: (value: string) => void;
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
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        onCopy?.(value);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        // Fallback for older browsers
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

  return (
    <span
      className="relative inline-flex items-center group/copy"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {children}
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

export function JsonHighlighter({ content, onCopy }: JsonHighlighterProps) {
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

      if (isCopyable) {
        result.push(
          <CopyableValue key={`token-${i}`} value={getCopyValue()} onCopy={onCopy}>
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
  }, [content, onCopy]);

  return <>{elements}</>;
}
