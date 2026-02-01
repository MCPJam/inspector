export type JsonEditorMode = "view" | "edit";

export interface JsonEditorProps {
  value: unknown;
  onChange?: (value: unknown) => void;
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
}

export interface CursorPosition {
  line: number;
  column: number;
}

export interface UseJsonEditorOptions {
  initialValue: unknown;
  onChange?: (value: unknown) => void;
  onValidationError?: (error: string | null) => void;
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
}
