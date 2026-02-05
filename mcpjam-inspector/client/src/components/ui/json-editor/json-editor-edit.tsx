import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import { debounce } from "@/lib/chat-utils";
import type { CursorPosition } from "./types";
import { highlightJson } from "./json-syntax-highlighter";
import { JsonHighlighter } from "./json-highlighter";

// Constants for virtualization and viewport highlighting
const LINE_HEIGHT = 20; // 20px per line (leading-5)
const VIEWPORT_BUFFER_LINES = 30; // Buffer lines above/below viewport for highlighting
const HIGHLIGHT_DEBOUNCE_MS = 150; // Debounce delay for syntax highlighting

interface JsonEditorEditProps {
  content: string;
  onChange?: (content: string) => void;
  onCursorChange?: (position: CursorPosition) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onEscape?: () => void;
  isValid?: boolean;
  readOnly?: boolean;
  className?: string;
  height?: string | number;
  maxHeight?: string | number;
  collapseStringsAfterLength?: number;
}

function getCursorPosition(textarea: HTMLTextAreaElement): CursorPosition {
  const text = textarea.value;
  const selectionStart = textarea.selectionStart;
  const textBeforeCursor = text.substring(0, selectionStart);
  const lines = textBeforeCursor.split("\n");
  const line = lines.length;
  const column = lines[lines.length - 1].length + 1;
  return { line, column };
}

/**
 * Escape HTML special characters for safe display
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Hook for viewport-based highlighting.
 * Shows text immediately (using themed base color), then applies syntax highlighting after debounce.
 */
function useViewportHighlight(
  content: string,
  scrollTop: number,
  viewportHeight: number,
  enabled: boolean,
): { highlightedHtml: string; paddingTop: number; paddingBottom: number } {
  const [highlightedHtml, setHighlightedHtml] = useState("");
  const [paddingTop, setPaddingTop] = useState(0);
  const [paddingBottom, setPaddingBottom] = useState(0);

  const debouncedHighlightRef = useRef<ReturnType<typeof debounce> | null>(
    null,
  );
  const isFirstRender = useRef(true);

  // Create debounced highlight function once
  useEffect(() => {
    debouncedHighlightRef.current = debounce((visibleContent: string) => {
      setHighlightedHtml(highlightJson(visibleContent));
    }, HIGHLIGHT_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setHighlightedHtml("");
      setPaddingTop(0);
      setPaddingBottom(0);
      isFirstRender.current = true;
      return;
    }

    const lines = content.split("\n");
    const totalLines = lines.length;

    // Calculate visible line range
    const firstVisibleLine = Math.floor(scrollTop / LINE_HEIGHT);
    const visibleLineCount = Math.ceil(viewportHeight / LINE_HEIGHT);
    const lastVisibleLine = firstVisibleLine + visibleLineCount;

    // Add buffer
    const startLine = Math.max(0, firstVisibleLine - VIEWPORT_BUFFER_LINES);
    const endLine = Math.min(
      totalLines - 1,
      lastVisibleLine + VIEWPORT_BUFFER_LINES,
    );

    const visibleContent = lines.slice(startLine, endLine + 1).join("\n");

    // Always update padding immediately for smooth scrolling
    setPaddingTop(startLine * LINE_HEIGHT);
    setPaddingBottom(Math.max(0, totalLines - endLine - 1) * LINE_HEIGHT);

    if (isFirstRender.current) {
      // Synchronous highlight on first render
      setHighlightedHtml(highlightJson(visibleContent));
      isFirstRender.current = false;
    } else {
      // Show escaped text immediately (inherits muted color from parent pre)
      // Then apply full syntax highlighting after debounce
      setHighlightedHtml(escapeHtml(visibleContent));
      debouncedHighlightRef.current?.(visibleContent);
    }
  }, [content, scrollTop, viewportHeight, enabled]);

  return { highlightedHtml, paddingTop, paddingBottom };
}

export function JsonEditorEdit({
  content,
  onChange,
  onCursorChange,
  onUndo,
  onRedo,
  onEscape,
  isValid = true,
  readOnly = false,
  className,
  height,
  maxHeight,
  collapseStringsAfterLength,
}: JsonEditorEditProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [isFocused, setIsFocused] = useState(false);
  const [activeLine, setActiveLine] = useState(1);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);

  const lineCount = useMemo(() => content.split("\n").length, [content]);

  // Phase 2: Virtualized line numbers
  const lineNumberVirtualizer = useVirtualizer({
    count: lineCount,
    getScrollElement: () => lineNumbersRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 20,
  });

  // Phase 3: Viewport-based highlighting
  const { highlightedHtml, paddingTop, paddingBottom } = useViewportHighlight(
    content,
    scrollTop,
    viewportHeight,
    !readOnly,
  );

  // Sync scroll between textarea, line numbers, and highlight overlay
  const handleScroll = useCallback(() => {
    if (textareaRef.current) {
      const currentScrollTop = textareaRef.current.scrollTop;
      const scrollLeft = textareaRef.current.scrollLeft;

      // Update scroll state for viewport highlighting
      setScrollTop(currentScrollTop);

      if (lineNumbersRef.current) {
        lineNumbersRef.current.scrollTop = currentScrollTop;
      }
      if (highlightRef.current) {
        highlightRef.current.scrollTop = currentScrollTop;
        highlightRef.current.scrollLeft = scrollLeft;
      }
    }
  }, []);

  // Update cursor position on selection change
  const handleSelectionChange = useCallback(() => {
    if (textareaRef.current && onCursorChange) {
      const position = getCursorPosition(textareaRef.current);
      onCursorChange(position);
      setActiveLine(position.line);
    }
  }, [onCursorChange]);

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const textarea = e.currentTarget;
      const { selectionStart, selectionEnd, value } = textarea;

      // Undo: Ctrl/Cmd + Z
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        onUndo?.();
        return;
      }

      // Redo: Ctrl/Cmd + Shift + Z or Ctrl + Y
      if (
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "z") ||
        (e.ctrlKey && e.key === "y")
      ) {
        e.preventDefault();
        onRedo?.();
        return;
      }

      // Escape: Cancel edit
      if (e.key === "Escape" && onEscape) {
        e.preventDefault();
        onEscape();
        return;
      }

      // Tab: Insert/remove indentation
      if (e.key === "Tab") {
        e.preventDefault();
        const indent = "  ";

        if (e.shiftKey) {
          // Unindent
          const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
          const lineContent = value.substring(lineStart, selectionStart);

          if (lineContent.startsWith(indent)) {
            const newValue =
              value.substring(0, lineStart) +
              value.substring(lineStart + indent.length);
            onChange?.(newValue);

            // Restore cursor position
            requestAnimationFrame(() => {
              textarea.selectionStart = textarea.selectionEnd =
                selectionStart - indent.length;
            });
          }
        } else {
          // Indent
          const newValue =
            value.substring(0, selectionStart) +
            indent +
            value.substring(selectionEnd);
          onChange?.(newValue);

          // Move cursor after indent
          requestAnimationFrame(() => {
            textarea.selectionStart = textarea.selectionEnd =
              selectionStart + indent.length;
          });
        }
        return;
      }

      // Enter: Auto-indent
      if (e.key === "Enter") {
        e.preventDefault();
        const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
        const currentLine = value.substring(lineStart, selectionStart);
        const leadingWhitespace = currentLine.match(/^(\s*)/)?.[1] || "";

        // Check if we're after an opening brace/bracket
        const charBefore = value[selectionStart - 1];
        const charAfter = value[selectionStart];
        const isAfterOpening = charBefore === "{" || charBefore === "[";
        const isBeforeClosing = charAfter === "}" || charAfter === "]";

        let insertion = "\n" + leadingWhitespace;
        let cursorOffset = insertion.length;

        if (isAfterOpening) {
          insertion = "\n" + leadingWhitespace + "  ";
          cursorOffset = insertion.length;

          if (isBeforeClosing) {
            insertion += "\n" + leadingWhitespace;
          }
        }

        const newValue =
          value.substring(0, selectionStart) +
          insertion +
          value.substring(selectionEnd);
        onChange?.(newValue);

        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd =
            selectionStart + cursorOffset;
        });
      }
    },
    [onChange, onUndo, onRedo, onEscape],
  );

  // Focus textarea on mount (only in edit mode)
  useEffect(() => {
    if (!readOnly) {
      textareaRef.current?.focus();
    }
  }, [readOnly]);

  // Track viewport height for viewport-based highlighting
  useEffect(() => {
    const updateViewportHeight = () => {
      if (containerRef.current) {
        setViewportHeight(containerRef.current.clientHeight);
      }
    };

    updateViewportHeight();
    window.addEventListener("resize", updateViewportHeight);
    return () => window.removeEventListener("resize", updateViewportHeight);
  }, []);

  const containerStyle: React.CSSProperties = {
    height: height ?? "auto",
    maxHeight: maxHeight ?? "none",
  };

  const fontStyle: React.CSSProperties = {
    fontFamily: "var(--font-code)",
  };

  // Sync scroll for read-only mode (sync line numbers with content)
  const handleReadOnlyScroll = useCallback(
    (e: React.UIEvent<HTMLPreElement>) => {
      const scrollTop = e.currentTarget.scrollTop;
      if (lineNumbersRef.current) {
        lineNumbersRef.current.scrollTop = scrollTop;
      }
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      className={cn(
        "group relative flex w-full overflow-hidden bg-muted/30",
        !isValid && "border-destructive",
        className,
      )}
      style={containerStyle}
    >
      {/* Line numbers - virtualized for performance */}
      <div
        ref={lineNumbersRef}
        className="flex-shrink-0 h-full overflow-hidden bg-muted/50 text-right select-none border-r border-border/50"
        style={{ width: "3rem" }}
      >
        <div
          className="py-3 pr-2 text-xs text-muted-foreground leading-5 relative"
          style={{
            ...fontStyle,
            height: `${lineNumberVirtualizer.getTotalSize()}px`,
          }}
        >
          {lineNumberVirtualizer.getVirtualItems().map((virtualRow) => {
            const lineNum = virtualRow.index + 1;
            return (
              <div
                key={virtualRow.index}
                className={cn(
                  "leading-5 h-5 transition-colors duration-150 absolute left-0 right-0 pr-2",
                  !readOnly &&
                    lineNum === activeLine &&
                    isFocused &&
                    "text-foreground font-medium",
                )}
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {lineNum}
              </div>
            );
          })}
        </div>
      </div>

      {/* Editor area with overlay */}
      <div className="relative flex-1 min-w-0 h-full overflow-hidden">
        {readOnly ? (
          /* Read-only mode: Use JsonHighlighter with per-value copy */
          <pre
            ref={highlightRef}
            className={cn(
              "p-3 text-xs leading-5 whitespace-pre-wrap break-all overflow-auto m-0 min-h-full",
              "select-text cursor-text",
            )}
            style={fontStyle}
            onScroll={handleReadOnlyScroll}
          >
            <JsonHighlighter
              content={content}
              collapseStringsAfterLength={collapseStringsAfterLength}
            />
          </pre>
        ) : (
          <>
            {/* Syntax highlighted overlay (behind textarea) - viewport-based for performance */}
            <pre
              ref={highlightRef}
              className={cn(
                "absolute inset-0 p-3 text-xs leading-5 whitespace-pre-wrap break-all overflow-hidden",
                "pointer-events-none m-0",
                "text-muted-foreground", // Base color for unhighlighted text during typing
              )}
              style={fontStyle}
              aria-hidden="true"
            >
              {/* Padding to maintain scroll position */}
              <div style={{ height: paddingTop }} aria-hidden="true" />
              <div
                dangerouslySetInnerHTML={{ __html: highlightedHtml + "\n" }}
              />
              <div style={{ height: paddingBottom }} aria-hidden="true" />
            </pre>

            {/* Active line highlight (only in edit mode) */}
            {isFocused && (
              <div
                className="absolute left-0 right-0 h-5 bg-foreground/[0.03] pointer-events-none transition-transform duration-75"
                style={{
                  transform: `translateY(${(activeLine - 1) * 20 + 12}px)`,
                }}
              />
            )}

            {/* Transparent textarea (on top for editing) */}
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => onChange?.(e.target.value)}
              onScroll={handleScroll}
              onSelect={handleSelectionChange}
              onClick={handleSelectionChange}
              onKeyDown={handleKeyDown}
              onKeyUp={handleSelectionChange}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              spellCheck={false}
              className={cn(
                "absolute inset-0 z-10 w-full h-full resize-none bg-transparent p-3 text-xs leading-5",
                "focus:outline-none",
                "text-transparent caret-foreground",
                "selection:bg-primary/20",
                "overflow-auto whitespace-pre-wrap break-all",
              )}
              style={{ ...fontStyle, tabSize: 2 }}
            />
          </>
        )}
      </div>
    </div>
  );
}
