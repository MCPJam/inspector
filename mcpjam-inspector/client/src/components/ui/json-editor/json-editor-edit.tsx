import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import type { CursorPosition } from "./types";
import { highlightJson } from "./json-syntax-highlighter";
import { JsonHighlighter } from "./json-highlighter";

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

function getLineNumbers(content: string): number[] {
  const lines = content.split("\n");
  return Array.from({ length: lines.length }, (_, i) => i + 1);
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

  const lineNumbers = getLineNumbers(content);

  // Memoize highlighted content (only for edit mode)
  const highlightedContent = useMemo(
    () => (readOnly ? "" : highlightJson(content)),
    [content, readOnly],
  );

  // Sync scroll between textarea, line numbers, and highlight overlay
  const handleScroll = useCallback(() => {
    if (textareaRef.current) {
      const scrollTop = textareaRef.current.scrollTop;
      const scrollLeft = textareaRef.current.scrollLeft;

      if (lineNumbersRef.current) {
        lineNumbersRef.current.scrollTop = scrollTop;
      }
      if (highlightRef.current) {
        highlightRef.current.scrollTop = scrollTop;
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
        "transition-all duration-200",
        !readOnly && isFocused && "ring-2 ring-ring/50",
        !isValid && "border-destructive",
        !isValid && !readOnly && isFocused && "ring-destructive/30",
        className,
      )}
      style={containerStyle}
    >
      {/* Line numbers */}
      <div
        ref={lineNumbersRef}
        className="flex-shrink-0 overflow-hidden bg-muted/50 text-right select-none border-r border-border/50"
        style={{ width: "3rem" }}
      >
        <div
          className="py-3 pr-2 text-xs text-muted-foreground leading-5"
          style={fontStyle}
        >
          {lineNumbers.map((num) => (
            <div
              key={num}
              className={cn(
                "leading-5 h-5 transition-colors duration-150",
                !readOnly &&
                  num === activeLine &&
                  isFocused &&
                  "text-foreground font-medium",
              )}
            >
              {num}
            </div>
          ))}
        </div>
      </div>

      {/* Editor area with overlay */}
      <div className="relative flex-1 min-w-0 overflow-auto">
        {readOnly ? (
          /* Read-only mode: Use JsonHighlighter with per-value copy */
          <pre
            ref={highlightRef}
            className={cn(
              "p-3 text-xs leading-5 whitespace-pre-wrap break-all overflow-auto m-0",
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
            {/* Syntax highlighted overlay (behind textarea) */}
            <pre
              ref={highlightRef}
              className={cn(
                "absolute inset-0 p-3 text-xs leading-5 whitespace-pre-wrap break-all overflow-auto",
                "pointer-events-none m-0",
              )}
              style={fontStyle}
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: highlightedContent + "\n" }}
            />

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
