import type { ReactNode } from "react";

export type JsonEditorMode = "view" | "edit";

export interface JsonEditorProps {
  // Parsed value mode (default)
  value?: unknown;
  onChange?: (value: unknown) => void;

  // Raw string mode (for edit-only use cases like import)
  rawContent?: string;
  onRawChange?: (content: string) => void;

  mode?: JsonEditorMode;
  onModeChange?: (mode: JsonEditorMode) => void;
  readOnly?: boolean;
  showModeToggle?: boolean;
  showToolbar?: boolean;
  allowMaximize?: boolean;
  height?: string | number;
  maxHeight?: string | number;
  className?: string;
  onValidationError?: (error: string | null) => void;

  // Collapsible tree view options (view mode only)
  collapsible?: boolean;
  defaultExpandDepth?: number;
  collapsedPaths?: Set<string>;
  onCollapseChange?: (paths: Set<string>) => void;

  // String truncation (view mode only)
  collapseStringsAfterLength?: number;

  // View-only mode: renders just the view without toolbar or edit capabilities
  viewOnly?: boolean;

  // Expand stringified JSON values for display and collapse back on change
  expandJsonStrings?: boolean;

  // Automatically format valid JSON when entering edit mode
  autoFormatOnEdit?: boolean;

  // Soft-wrap long lines in edit mode while preserving logical line numbers
  wrapLongLinesInEdit?: boolean;

  // Show or hide the line number gutter
  showLineNumbers?: boolean;

  // Custom toolbar content
  toolbarLeftContent?: ReactNode;
  toolbarRightContent?: ReactNode;
}

export interface CursorPosition {
  line: number;
  column: number;
}

export interface UseJsonEditorOptions {
  initialValue?: unknown;
  initialContent?: string;
  onChange?: (value: unknown) => void;
  onRawChange?: (content: string) => void;
  onValidationError?: (error: string | null) => void;
  expandJsonStrings?: boolean;
}

export interface UseJsonEditorReturn {
  content: string;
  setContent: (value: string) => void;
  isValid: boolean;
  validationError: string | null;
  cursorPosition: CursorPosition;
  setCursorPosition: (position: CursorPosition) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  format: () => void;
  reset: () => void;
  getParsedValue: () => unknown;
  sourceContent: string;
}
