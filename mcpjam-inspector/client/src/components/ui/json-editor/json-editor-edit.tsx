import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import type { CursorPosition } from "./types";
import { highlightJson } from "./json-syntax-highlighter";
import { JsonHighlighter } from "./json-highlighter";

// Constants for virtualization and viewport highlighting
const LINE_HEIGHT = 20; // 20px per line (leading-5)
const VIEWPORT_BUFFER_LINES = 30; // Buffer lines above/below viewport for highlighting
const EDITOR_VERTICAL_PADDING = 12; // p-3 top/bottom padding
const DEFAULT_CHARS_PER_VISUAL_LINE = 80;
const TAB_SIZE = 2;

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
  wrapLongLinesInEdit?: boolean;
}

interface LineLayout {
  top: number;
  height: number;
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

function getCharsPerVisualLine(textarea: HTMLTextAreaElement): number {
  const styles = window.getComputedStyle(textarea);
  const probe = document.createElement("span");
  probe.textContent = "0";
  probe.style.font = styles.font;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  document.body.appendChild(probe);
  const charWidth = probe.getBoundingClientRect().width;
  probe.remove();

  if (!Number.isFinite(charWidth) || charWidth <= 0) {
    return DEFAULT_CHARS_PER_VISUAL_LINE;
  }

  const paddingLeft = Number.parseFloat(styles.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(styles.paddingRight) || 0;
  const availableWidth = textarea.clientWidth - paddingLeft - paddingRight;

  if (availableWidth <= 0) {
    return DEFAULT_CHARS_PER_VISUAL_LINE;
  }

  return Math.max(1, Math.floor(availableWidth / charWidth));
}

function countVisualRows(line: string, charsPerVisualLine: number): number {
  const expandedLine = line.replace(/\t/g, " ".repeat(TAB_SIZE));
  const displayLength = expandedLine.length;

  if (displayLength === 0) {
    return 1;
  }

  return Math.max(1, Math.ceil(displayLength / charsPerVisualLine));
}

function buildLineLayouts(
  lines: string[],
  lineWrapEnabled: boolean,
  charsPerVisualLine: number,
): LineLayout[] {
  let currentTop = 0;

  return lines.map((line, index) => {
    const height = lineWrapEnabled
      ? countVisualRows(line, charsPerVisualLine) * LINE_HEIGHT
      : LINE_HEIGHT;
    const top = lineWrapEnabled ? currentTop : index * LINE_HEIGHT;
    currentTop += height;
    return { top, height };
  });
}

/**
 * Hook for viewport-based highlighting.
 * Keeps syntax highlighting stable while typing by rendering highlighted HTML immediately.
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

  useEffect(() => {
    if (!enabled) {
      setHighlightedHtml("");
      setPaddingTop(0);
      setPaddingBottom(0);
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

    setHighlightedHtml(highlightJson(visibleContent));
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
  wrapLongLinesInEdit = false,
}: JsonEditorEditProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [isFocused, setIsFocused] = useState(false);
  const [activeLine, setActiveLine] = useState(1);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const [charsPerVisualLine, setCharsPerVisualLine] = useState(
    DEFAULT_CHARS_PER_VISUAL_LINE,
  );
  const lineWrapEnabled = wrapLongLinesInEdit && !readOnly;
  const lines = useMemo(() => content.split("\n"), [content]);
  const lineLayouts = useMemo(
    () => buildLineLayouts(lines, lineWrapEnabled, charsPerVisualLine),
    [charsPerVisualLine, lineWrapEnabled, lines],
  );
  const lineCount = lines.length;
  const activeLineIndex = Math.min(Math.max(activeLine - 1, 0), lineCount - 1);
  const activeLineLayout = lineLayouts[activeLineIndex];
  const activeLineTop = activeLineLayout?.top ?? 0;
  const activeLineHeight = activeLineLayout?.height ?? LINE_HEIGHT;
  const useViewportBasedHighlighting = !readOnly && !lineWrapEnabled;
  const activeHighlightOffset =
    activeLineTop - scrollTop + EDITOR_VERTICAL_PADDING;

  const refreshCharsPerVisualLine = useCallback(() => {
    if (!lineWrapEnabled || !textareaRef.current) {
      return;
    }

    const nextCharsPerLine = getCharsPerVisualLine(textareaRef.current);
    setCharsPerVisualLine((current) =>
      current === nextCharsPerLine ? current : nextCharsPerLine,
    );
  }, [lineWrapEnabled]);

  // Phase 2: Virtualized line numbers
  const lineNumberVirtualizer = useVirtualizer({
    count: lineCount,
    getScrollElement: () => lineNumbersRef.current,
    estimateSize: (index) => lineLayouts[index]?.height ?? LINE_HEIGHT,
    overscan: 20,
  });

  // Phase 3: Viewport-based highlighting
  const {
    highlightedHtml: viewportHighlightedHtml,
    paddingTop: viewportPaddingTop,
    paddingBottom: viewportPaddingBottom,
  } = useViewportHighlight(
    content,
    scrollTop,
    viewportHeight,
    useViewportBasedHighlighting,
  );
  const highlightedHtml = useMemo(() => {
    if (readOnly) {
      return "";
    }

    return useViewportBasedHighlighting
      ? viewportHighlightedHtml
      : highlightJson(content);
  }, [
    content,
    readOnly,
    useViewportBasedHighlighting,
    viewportHighlightedHtml,
  ]);
  const paddingTop = useViewportBasedHighlighting ? viewportPaddingTop : 0;
  const paddingBottom = useViewportBasedHighlighting
    ? viewportPaddingBottom
    : 0;

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

  useEffect(() => {
    if (activeLine > lineCount) {
      setActiveLine(lineCount);
    }
  }, [activeLine, lineCount]);

  useEffect(() => {
    lineNumberVirtualizer.measure();
  }, [lineLayouts, lineNumberVirtualizer]);

  useEffect(() => {
    if (!lineWrapEnabled) {
      return;
    }

    refreshCharsPerVisualLine();
    window.addEventListener("resize", refreshCharsPerVisualLine);

    let resizeObserver: ResizeObserver | undefined;
    if (window.ResizeObserver && textareaRef.current) {
      resizeObserver = new ResizeObserver(() => refreshCharsPerVisualLine());
      resizeObserver.observe(textareaRef.current);
    }

    return () => {
      window.removeEventListener("resize", refreshCharsPerVisualLine);
      resizeObserver?.disconnect();
    };
  }, [lineWrapEnabled, refreshCharsPerVisualLine]);

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
            const lineHeight =
              lineLayouts[virtualRow.index]?.height ?? LINE_HEIGHT;
            return (
              <div
                key={virtualRow.index}
                className={cn(
                  "leading-5 transition-colors duration-150 absolute left-0 right-0 pr-2",
                  !readOnly &&
                    lineNum === activeLine &&
                    isFocused &&
                    "text-foreground font-medium",
                )}
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                  height: `${lineHeight}px`,
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
              "p-3 text-xs leading-5 whitespace-pre overflow-auto m-0 min-h-full",
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
                "absolute inset-0 p-3 text-xs leading-5 overflow-hidden",
                lineWrapEnabled
                  ? "whitespace-pre-wrap break-words"
                  : "whitespace-pre",
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
                className="absolute left-0 right-0 bg-foreground/[0.03] pointer-events-none transition-transform duration-75"
                style={{
                  height: `${activeLineHeight}px`,
                  transform: `translateY(${activeHighlightOffset}px)`,
                }}
              />
            )}

            {/* Transparent textarea (on top for editing) */}
            <textarea
              ref={textareaRef}
              value={content}
              wrap={lineWrapEnabled ? "soft" : "off"}
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
                lineWrapEnabled
                  ? "overflow-auto whitespace-pre-wrap break-words"
                  : "overflow-auto whitespace-pre",
              )}
              style={{ ...fontStyle, tabSize: 2 }}
            />
          </>
        )}
      </div>
    </div>
  );
}
