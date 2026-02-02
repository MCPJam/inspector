import { useState, useCallback, Fragment, memo } from "react";
import { ChevronRight, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { TruncatableString } from "./truncatable-string";

interface CopyableValueProps {
  children: React.ReactNode;
  value: string;
  onCopy?: (value: string) => void;
}

const CopyableValue = memo(function CopyableValue({
  children,
  value,
  onCopy,
}: CopyableValueProps) {
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
});

interface JsonTreeNodeProps {
  value: unknown;
  path: string;
  keyName?: string;
  isLast?: boolean;
  depth?: number;
  isCollapsed: (path: string) => boolean;
  toggleCollapse: (path: string) => void;
  collapseStringsAfterLength?: number;
  onCopy?: (value: string) => void;
}

function JsonTreeNodeInner({
  value,
  path,
  keyName,
  isLast = true,
  depth = 0,
  isCollapsed,
  toggleCollapse,
  collapseStringsAfterLength,
  onCopy,
}: JsonTreeNodeProps) {
  const indent = depth * 16;
  const collapsed = isCollapsed(path);

  const renderValue = () => {
    if (value === null) {
      return (
        <CopyableValue value="null" onCopy={onCopy}>
          <span className="json-null">null</span>
        </CopyableValue>
      );
    }

    if (typeof value === "boolean") {
      return (
        <CopyableValue value={String(value)} onCopy={onCopy}>
          <span className={value ? "json-boolean" : "json-boolean-false"}>
            {String(value)}
          </span>
        </CopyableValue>
      );
    }

    if (typeof value === "number") {
      return (
        <CopyableValue value={String(value)} onCopy={onCopy}>
          <span className="json-number">{String(value)}</span>
        </CopyableValue>
      );
    }

    if (typeof value === "string") {
      const displayValue = JSON.stringify(value);
      if (collapseStringsAfterLength !== undefined) {
        return (
          <TruncatableString
            value={value}
            displayValue={displayValue}
            maxLength={collapseStringsAfterLength}
            onCopy={onCopy}
          />
        );
      }
      return (
        <CopyableValue value={value} onCopy={onCopy}>
          <span className="json-string">{displayValue}</span>
        </CopyableValue>
      );
    }

    return null;
  };

  const renderKeyPrefix = () => {
    if (keyName === undefined) return null;
    return (
      <>
        <span className="json-key">"{keyName}"</span>
        <span className="json-punctuation">: </span>
      </>
    );
  };

  const renderComma = () => {
    if (isLast) return null;
    return <span className="json-punctuation">,</span>;
  };

  // Primitive values
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return (
      <div className="leading-5" style={{ paddingLeft: indent }}>
        {renderKeyPrefix()}
        {renderValue()}
        {renderComma()}
      </div>
    );
  }

  // Arrays
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <div className="leading-5" style={{ paddingLeft: indent }}>
          {renderKeyPrefix()}
          <CopyableValue value="[]" onCopy={onCopy}>
            <span className="json-punctuation">[]</span>
          </CopyableValue>
          {renderComma()}
        </div>
      );
    }

    const handleToggle = (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleCollapse(path);
    };

    if (collapsed) {
      return (
        <div className="leading-5" style={{ paddingLeft: indent }}>
          <button
            onClick={handleToggle}
            className="json-collapse-toggle inline-flex items-center justify-center w-4 h-4 -ml-4 hover:bg-muted rounded"
            data-state="closed"
          >
            <ChevronRight className="h-3 w-3" />
          </button>
          {renderKeyPrefix()}
          <CopyableValue value={JSON.stringify(value, null, 2)} onCopy={onCopy}>
            <span className="json-punctuation">[</span>
            <span className="text-muted-foreground text-xs px-1">
              {value.length} {value.length === 1 ? "item" : "items"}
            </span>
            <span className="json-punctuation">]</span>
          </CopyableValue>
          {renderComma()}
        </div>
      );
    }

    return (
      <Fragment>
        <div className="leading-5" style={{ paddingLeft: indent }}>
          <button
            onClick={handleToggle}
            className="json-collapse-toggle inline-flex items-center justify-center w-4 h-4 -ml-4 hover:bg-muted rounded"
            data-state="open"
          >
            <ChevronRight className="h-3 w-3" />
          </button>
          {renderKeyPrefix()}
          <CopyableValue value={JSON.stringify(value, null, 2)} onCopy={onCopy}>
            <span className="json-punctuation">[</span>
          </CopyableValue>
        </div>
        {value.map((item, index) => (
          <JsonTreeNode
            key={`${path}.${index}`}
            value={item}
            path={`${path}.${index}`}
            isLast={index === value.length - 1}
            depth={depth + 1}
            isCollapsed={isCollapsed}
            toggleCollapse={toggleCollapse}
            collapseStringsAfterLength={collapseStringsAfterLength}
            onCopy={onCopy}
          />
        ))}
        <div className="leading-5" style={{ paddingLeft: indent }}>
          <span className="json-punctuation">]</span>
          {renderComma()}
        </div>
      </Fragment>
    );
  }

  // Objects
  if (typeof value === "object") {
    const entries = Object.entries(value);

    if (entries.length === 0) {
      return (
        <div className="leading-5" style={{ paddingLeft: indent }}>
          {renderKeyPrefix()}
          <CopyableValue value="{}" onCopy={onCopy}>
            <span className="json-punctuation">{"{}"}</span>
          </CopyableValue>
          {renderComma()}
        </div>
      );
    }

    const handleToggle = (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleCollapse(path);
    };

    if (collapsed) {
      return (
        <div className="leading-5" style={{ paddingLeft: indent }}>
          <button
            onClick={handleToggle}
            className="json-collapse-toggle inline-flex items-center justify-center w-4 h-4 -ml-4 hover:bg-muted rounded"
            data-state="closed"
          >
            <ChevronRight className="h-3 w-3" />
          </button>
          {renderKeyPrefix()}
          <CopyableValue value={JSON.stringify(value, null, 2)} onCopy={onCopy}>
            <span className="json-punctuation">{"{"}</span>
            <span className="text-muted-foreground text-xs px-1">
              {entries.length} {entries.length === 1 ? "key" : "keys"}
            </span>
            <span className="json-punctuation">{"}"}</span>
          </CopyableValue>
          {renderComma()}
        </div>
      );
    }

    return (
      <Fragment>
        <div className="leading-5" style={{ paddingLeft: indent }}>
          <button
            onClick={handleToggle}
            className="json-collapse-toggle inline-flex items-center justify-center w-4 h-4 -ml-4 hover:bg-muted rounded"
            data-state="open"
          >
            <ChevronRight className="h-3 w-3" />
          </button>
          {renderKeyPrefix()}
          <CopyableValue value={JSON.stringify(value, null, 2)} onCopy={onCopy}>
            <span className="json-punctuation">{"{"}</span>
          </CopyableValue>
        </div>
        {entries.map(([key, val], index) => (
          <JsonTreeNode
            key={`${path}.${key}`}
            value={val}
            path={`${path}.${key}`}
            keyName={key}
            isLast={index === entries.length - 1}
            depth={depth + 1}
            isCollapsed={isCollapsed}
            toggleCollapse={toggleCollapse}
            collapseStringsAfterLength={collapseStringsAfterLength}
            onCopy={onCopy}
          />
        ))}
        <div className="leading-5" style={{ paddingLeft: indent }}>
          <span className="json-punctuation">{"}"}</span>
          {renderComma()}
        </div>
      </Fragment>
    );
  }

  // Fallback for undefined or other types
  return (
    <div className="leading-5" style={{ paddingLeft: indent }}>
      {renderKeyPrefix()}
      <span className="text-muted-foreground">undefined</span>
      {renderComma()}
    </div>
  );
}

// Custom comparator - only re-render if relevant props change
function arePropsEqual(
  prevProps: JsonTreeNodeProps,
  nextProps: JsonTreeNodeProps
): boolean {
  // Always re-render if value changes
  if (prevProps.value !== nextProps.value) return false;

  // Re-render if structural props change
  if (prevProps.path !== nextProps.path) return false;
  if (prevProps.keyName !== nextProps.keyName) return false;
  if (prevProps.isLast !== nextProps.isLast) return false;
  if (prevProps.depth !== nextProps.depth) return false;
  if (
    prevProps.collapseStringsAfterLength !== nextProps.collapseStringsAfterLength
  )
    return false;

  // Key optimization: compare the RESULT of isCollapsed for this node's path
  // This way, changing a sibling's collapse state won't trigger re-render
  const prevCollapsed = prevProps.isCollapsed(prevProps.path);
  const nextCollapsed = nextProps.isCollapsed(nextProps.path);
  if (prevCollapsed !== nextCollapsed) return false;

  // Function references can change - we don't care as long as collapse state is same
  // toggleCollapse and onCopy don't affect render output

  return true;
}

export const JsonTreeNode = memo(JsonTreeNodeInner, arePropsEqual);
