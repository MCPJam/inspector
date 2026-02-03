import { useState, useCallback, useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ErrorBoundary } from "@/components/evals/ErrorBoundary";
import { useJsonEditor } from "./use-json-editor";
import { JsonEditorView } from "./json-editor-view";
import { JsonEditorEdit } from "./json-editor-edit";
import { JsonEditorToolbar } from "./json-editor-toolbar";
import { JsonEditorStatusBar } from "./json-editor-status-bar";
import type { JsonEditorProps, JsonEditorMode } from "./types";

function JsonEditorErrorFallback() {
  return (
    <div className="flex items-center justify-center p-4 text-sm text-muted-foreground">
      <AlertTriangle className="h-4 w-4 mr-2 text-destructive" />
      Failed to render JSON content
    </div>
  );
}

export function JsonEditor({
  value,
  onChange,
  rawContent,
  onRawChange,
  mode: controlledMode,
  onModeChange,
  readOnly = false,
  showModeToggle = true,
  showToolbar = true,
  allowMaximize = false,
  height,
  maxHeight,
  className,
  onValidationError,
  collapsible = false,
  defaultExpandDepth,
  collapsedPaths,
  onCollapseChange,
  collapseStringsAfterLength,
  viewOnly = false,
}: JsonEditorProps) {
  // Determine if we're in raw mode (string content) vs parsed mode
  const isRawMode = rawContent !== undefined;

  // Mode state (controlled or uncontrolled)
  // Always call hooks to preserve hook order even in viewOnly mode
  const [internalMode, setInternalMode] = useState<JsonEditorMode>("view");
  const mode = controlledMode ?? internalMode;
  const [isMaximized, setIsMaximized] = useState(false);

  // Track if there are unsaved changes
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Editor hook for edit mode
  const editor = useJsonEditor({
    initialValue: isRawMode ? undefined : value,
    initialContent: isRawMode ? rawContent : undefined,
    onChange: (newValue) => {
      setHasUnsavedChanges(true);
      onChange?.(newValue);
    },
    onRawChange: isRawMode
      ? (content) => {
          setHasUnsavedChanges(true);
          onRawChange?.(content);
        }
      : undefined,
    onValidationError,
  });

  // Sync editor content when value/rawContent changes externally
  useEffect(() => {
    if (mode === "view") {
      setHasUnsavedChanges(false);
    }
  }, [value, rawContent, mode]);

  const handleModeChange = useCallback(
    (newMode: JsonEditorMode) => {
      // Warn before switching from edit to view if there are unsaved changes
      if (mode === "edit" && newMode === "view" && hasUnsavedChanges) {
        if (!editor.isValid) {
          const confirmed = window.confirm(
            "The JSON is invalid. Switching to view mode will lose your changes. Continue?",
          );
          if (!confirmed) return;
          editor.reset();
        }
      }

      setHasUnsavedChanges(false);
      setInternalMode(newMode);
      onModeChange?.(newMode);
    },
    [mode, hasUnsavedChanges, editor, onModeChange],
  );

  const handleCopy = useCallback(() => {
    let textToCopy: string;
    if (mode === "edit") {
      textToCopy = editor.content;
    } else if (isRawMode) {
      textToCopy = rawContent ?? "";
    } else {
      textToCopy = JSON.stringify(value, null, 2);
    }
    navigator.clipboard.writeText(textToCopy);
  }, [mode, editor.content, value, isRawMode, rawContent]);

  const handleEscape = useCallback(() => {
    if (hasUnsavedChanges) {
      const confirmed = window.confirm(
        "You have unsaved changes. Discard them?",
      );
      if (!confirmed) return;
    }
    editor.reset();
    handleModeChange("view");
  }, [hasUnsavedChanges, editor, handleModeChange]);

  const toggleMaximize = useCallback(() => {
    setIsMaximized((prev) => !prev);
  }, []);

  // Lightweight render path for view-only mode (after all hooks to preserve hook order)
  if (viewOnly) {
    return (
      <ErrorBoundary fallback={<JsonEditorErrorFallback />}>
        <JsonEditorView
          value={value}
          className={className}
          height={height}
          maxHeight={maxHeight}
          collapsible={collapsible}
          defaultExpandDepth={defaultExpandDepth}
          collapsedPaths={collapsedPaths}
          onCollapseChange={onCollapseChange}
          collapseStringsAfterLength={collapseStringsAfterLength}
        />
      </ErrorBoundary>
    );
  }

  // Calculate container styles
  const containerStyle: React.CSSProperties = isMaximized
    ? {
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 50,
      }
    : {
        height: height ?? "auto",
        maxHeight: maxHeight ?? "none",
      };

  return (
    <ErrorBoundary fallback={<JsonEditorErrorFallback />}>
      <div
        className={cn(
          "flex flex-col rounded-lg border border-border bg-background overflow-hidden",
          isMaximized && "rounded-none",
          className,
        )}
        style={containerStyle}
      >
        {/* Toolbar */}
        {showToolbar && (
          <JsonEditorToolbar
            mode={mode}
            onModeChange={handleModeChange}
            showModeToggle={showModeToggle && !readOnly}
            readOnly={readOnly}
            onFormat={editor.format}
            onCopy={handleCopy}
            onUndo={editor.undo}
            onRedo={editor.redo}
            canUndo={editor.canUndo}
            canRedo={editor.canRedo}
            isMaximized={isMaximized}
            onToggleMaximize={toggleMaximize}
            allowMaximize={allowMaximize}
            isValid={editor.isValid}
          />
        )}

        {/* Content area */}
        <div className="flex-1 min-h-0">
          {mode === "view" ? (
            <ScrollArea className="h-full">
              <JsonEditorView
                value={isRawMode ? editor.getParsedValue() : value}
                collapsible={collapsible}
                defaultExpandDepth={defaultExpandDepth}
                collapsedPaths={collapsedPaths}
                onCollapseChange={onCollapseChange}
                collapseStringsAfterLength={collapseStringsAfterLength}
              />
            </ScrollArea>
          ) : (
            <JsonEditorEdit
              content={editor.content}
              onChange={editor.setContent}
              onCursorChange={editor.setCursorPosition}
              onUndo={editor.undo}
              onRedo={editor.redo}
              onEscape={handleEscape}
              isValid={editor.isValid}
              height="100%"
              maxHeight={isMaximized ? undefined : maxHeight}
            />
          )}
        </div>

        {/* Status bar (only in edit mode) */}
        {mode === "edit" && (
          <JsonEditorStatusBar
            cursorPosition={editor.cursorPosition}
            isValid={editor.isValid}
            validationError={editor.validationError}
            characterCount={editor.content.length}
          />
        )}
      </div>
    </ErrorBoundary>
  );
}
