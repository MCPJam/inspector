import { useState, useCallback, useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { ErrorBoundary } from "@/components/evals/ErrorBoundary";
import { useJsonEditor } from "./use-json-editor";
import { JsonEditorView } from "./json-editor-view";
import { JsonEditorEdit } from "./json-editor-edit";
import { JsonEditorToolbar } from "./json-editor-toolbar";
import { JsonEditorStatusBar } from "./json-editor-status-bar";
import type { JsonEditorProps, JsonEditorMode } from "./types";

function stringifyValue(value: unknown): string {
  if (value === undefined) {
    return "null";
  }

  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return "null";
  }
}

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
  autoFormatOnEdit = true,
  wrapLongLinesInEdit = false,
  toolbarLeftContent,
  toolbarRightContent,
}: JsonEditorProps) {
  // Determine if we're in raw mode (string content) vs parsed mode
  const isRawMode = rawContent !== undefined;

  // Mode state (controlled or uncontrolled)
  // Always call hooks to preserve hook order even in viewOnly mode
  const [internalMode, setInternalMode] = useState<JsonEditorMode>("view");
  const mode = readOnly ? "view" : (controlledMode ?? internalMode);
  const [isMaximized, setIsMaximized] = useState(false);

  const sourceContent = isRawMode ? (rawContent ?? "") : stringifyValue(value);

  // Editor hook for edit mode
  const editor = useJsonEditor({
    initialValue: isRawMode ? undefined : value,
    initialContent: isRawMode ? rawContent : undefined,
    onChange,
    onRawChange: isRawMode ? onRawChange : undefined,
    onValidationError,
  });

  const hasUnsavedChanges = editor.content !== sourceContent;
  const previousModeRef = useRef<JsonEditorMode>(mode);
  const hasMountedRef = useRef(false);

  useEffect(() => {
    const previousMode = previousModeRef.current;
    const isFirstRun = !hasMountedRef.current;

    hasMountedRef.current = true;
    previousModeRef.current = mode;

    if (viewOnly || readOnly || !autoFormatOnEdit) {
      return;
    }

    const enteredEditMode =
      mode === "edit" && (isFirstRun || previousMode !== "edit");
    if (!enteredEditMode || !editor.isValid) {
      return;
    }

    editor.format();
  }, [
    mode,
    editor.format,
    editor.isValid,
    autoFormatOnEdit,
    readOnly,
    viewOnly,
  ]);

  const handleModeChange = useCallback(
    (newMode: JsonEditorMode) => {
      if (readOnly) {
        return;
      }

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

      setInternalMode(newMode);
      onModeChange?.(newMode);
    },
    [mode, hasUnsavedChanges, editor, onModeChange, readOnly],
  );

  const handleCopy = useCallback(async () => {
    let textToCopy: string;
    if (mode === "edit") {
      textToCopy = editor.content;
    } else if (isRawMode) {
      textToCopy = rawContent ?? "";
    } else {
      textToCopy = stringifyValue(value);
    }

    return copyToClipboard(textToCopy);
  }, [mode, editor.content, value, isRawMode, rawContent]);

  const handleEscape = useCallback(() => {
    if (hasUnsavedChanges) {
      const confirmed = window.confirm(
        "You have unsaved changes. Discard them?",
      );
      if (!confirmed) return;
    }
    editor.reset();
    setInternalMode("view");
    onModeChange?.("view");
  }, [hasUnsavedChanges, editor, onModeChange]);

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
          "flex flex-col rounded-lg bg-background overflow-hidden",
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
            leftContent={toolbarLeftContent}
            rightContent={toolbarRightContent}
          />
        )}

        {/* Content area */}
        <div className="flex-1 min-h-0 h-full">
          {mode === "view" ? (
            <JsonEditorView
              value={isRawMode ? editor.getParsedValue() : value}
              height="100%"
              collapsible={collapsible}
              defaultExpandDepth={defaultExpandDepth}
              collapsedPaths={collapsedPaths}
              onCollapseChange={onCollapseChange}
              collapseStringsAfterLength={collapseStringsAfterLength}
            />
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
              wrapLongLinesInEdit={wrapLongLinesInEdit}
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
