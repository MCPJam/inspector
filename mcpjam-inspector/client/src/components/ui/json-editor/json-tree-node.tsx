import { useState, useCallback, useEffect, Fragment, memo } from "react";
import { ChevronRight, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { TruncatableString } from "./truncatable-string";

// Progressive rendering constants
const INITIAL_CHUNK_SIZE = 50;
const CHUNK_SIZE = 100;

// Fallback for Safari (no requestIdleCallback)
const scheduleChunk =
  typeof requestIdleCallback !== "undefined"
    ? requestIdleCallback
    : (cb: IdleRequestCallback, options?: IdleRequestOptions) => {
        const start = Date.now();
        return setTimeout(() => {
          cb({
            didTimeout: options?.timeout
              ? Date.now() - start >= options.timeout
              : false,
            timeRemaining: () => Math.max(0, 50 - (Date.now() - start)),
          });
        }, 1) as unknown as number;
      };

const cancelChunk =
  typeof cancelIdleCallback !== "undefined" ? cancelIdleCallback : clearTimeout;

/**
 * Hook for progressive/chunked rendering of large collections.
 * Renders items in chunks across frames for instant perceived performance.
 */
function useProgressiveChildren<T>(items: T[], isExpanded: boolean): T[] {
  const [renderedCount, setRenderedCount] = useState(
    items.length <= INITIAL_CHUNK_SIZE ? items.length : INITIAL_CHUNK_SIZE,
  );

  useEffect(() => {
    // Reset when items change or collapse
    if (!isExpanded) {
      setRenderedCount(Math.min(items.length, INITIAL_CHUNK_SIZE));
      return;
    }

    // If items array changed, reset to initial chunk
    setRenderedCount((prev) => {
      if (prev > items.length) {
        return Math.min(items.length, INITIAL_CHUNK_SIZE);
      }
      return prev;
    });
  }, [items.length, isExpanded]);

  useEffect(() => {
    // Don't schedule if collapsed or already showing all
    if (!isExpanded || renderedCount >= items.length) return;

    // Schedule next chunk
    const id = scheduleChunk(
      () => {
        setRenderedCount((prev) => Math.min(prev + CHUNK_SIZE, items.length));
      },
      { timeout: 100 }, // Fallback: render within 100ms even if not idle
    );

    return () => cancelChunk(id as number);
  }, [items.length, renderedCount, isExpanded]);

  return items.slice(0, renderedCount);
}

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
      const success = await copyToClipboard(value);
      if (success) {
        setCopied(true);
        onCopy?.(value);
        setTimeout(() => setCopied(false), 1500);
      }
    },
    [value, onCopy],
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

interface JsonArrayNodeProps extends Omit<JsonTreeNodeProps, "value"> {
  value: unknown[];
}

interface JsonObjectNodeProps extends Omit<JsonTreeNodeProps, "value"> {
  value: Record<string, unknown>;
}

/**
 * Array node component with progressive rendering
 */
function JsonArrayNode({
  value,
  path,
  keyName,
  isLast = true,
  depth = 0,
  isCollapsed: isCollapsedFn,
  toggleCollapse,
  collapseStringsAfterLength,
  onCopy,
}: JsonArrayNodeProps) {
  const indent = depth * 16;
  const collapsed = isCollapsedFn(path);

  // Use progressive rendering for large arrays
  const visibleItems = useProgressiveChildren(value, !collapsed);

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
      {visibleItems.map((item, index) => (
        <JsonTreeNode
          key={`${path}.${index}`}
          value={item}
          path={`${path}.${index}`}
          isLast={
            index === value.length - 1 && visibleItems.length === value.length
          }
          depth={depth + 1}
          isCollapsed={isCollapsedFn}
          toggleCollapse={toggleCollapse}
          collapseStringsAfterLength={collapseStringsAfterLength}
          onCopy={onCopy}
        />
      ))}
      {visibleItems.length < value.length && (
        <div
          className="leading-5 text-muted-foreground text-xs"
          style={{ paddingLeft: (depth + 1) * 16 }}
        >
          Loading {value.length - visibleItems.length} more items...
        </div>
      )}
      <div className="leading-5" style={{ paddingLeft: indent }}>
        <span className="json-punctuation">]</span>
        {renderComma()}
      </div>
    </Fragment>
  );
}

/**
 * Object node component with progressive rendering
 */
function JsonObjectNode({
  value,
  path,
  keyName,
  isLast = true,
  depth = 0,
  isCollapsed: isCollapsedFn,
  toggleCollapse,
  collapseStringsAfterLength,
  onCopy,
}: JsonObjectNodeProps) {
  const indent = depth * 16;
  const collapsed = isCollapsedFn(path);
  const entries = Object.entries(value);

  // Use progressive rendering for large objects
  const visibleEntries = useProgressiveChildren(entries, !collapsed);

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
      {visibleEntries.map(([key, val], index) => (
        <JsonTreeNode
          key={`${path}.${key}`}
          value={val}
          path={`${path}.${key}`}
          keyName={key}
          isLast={
            index === entries.length - 1 &&
            visibleEntries.length === entries.length
          }
          depth={depth + 1}
          isCollapsed={isCollapsedFn}
          toggleCollapse={toggleCollapse}
          collapseStringsAfterLength={collapseStringsAfterLength}
          onCopy={onCopy}
        />
      ))}
      {visibleEntries.length < entries.length && (
        <div
          className="leading-5 text-muted-foreground text-xs"
          style={{ paddingLeft: (depth + 1) * 16 }}
        >
          Loading {entries.length - visibleEntries.length} more keys...
        </div>
      )}
      <div className="leading-5" style={{ paddingLeft: indent }}>
        <span className="json-punctuation">{"}"}</span>
        {renderComma()}
      </div>
    </Fragment>
  );
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
    return (
      <JsonArrayNode
        value={value}
        path={path}
        keyName={keyName}
        isLast={isLast}
        depth={depth}
        isCollapsed={isCollapsed}
        toggleCollapse={toggleCollapse}
        collapseStringsAfterLength={collapseStringsAfterLength}
        onCopy={onCopy}
      />
    );
  }

  // Objects
  if (typeof value === "object") {
    return (
      <JsonObjectNode
        value={value as Record<string, unknown>}
        path={path}
        keyName={keyName}
        isLast={isLast}
        depth={depth}
        isCollapsed={isCollapsed}
        toggleCollapse={toggleCollapse}
        collapseStringsAfterLength={collapseStringsAfterLength}
        onCopy={onCopy}
      />
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
  nextProps: JsonTreeNodeProps,
): boolean {
  // Always re-render if value changes
  if (prevProps.value !== nextProps.value) return false;

  // Re-render if structural props change
  if (prevProps.path !== nextProps.path) return false;
  if (prevProps.keyName !== nextProps.keyName) return false;
  if (prevProps.isLast !== nextProps.isLast) return false;
  if (prevProps.depth !== nextProps.depth) return false;
  if (
    prevProps.collapseStringsAfterLength !==
    nextProps.collapseStringsAfterLength
  )
    return false;

  // Re-render when isCollapsed function changes (happens when collapsedPaths changes)
  if (prevProps.isCollapsed !== nextProps.isCollapsed) return false;

  return true;
}

// Create memoized component and export
// Note: JsonArrayNode and JsonObjectNode reference this, creating a circular dependency
// which is fine because they're only called at runtime after this is defined
export const JsonTreeNode = memo(JsonTreeNodeInner, arePropsEqual);
