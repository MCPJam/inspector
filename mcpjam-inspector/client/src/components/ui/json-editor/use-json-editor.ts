import { useState, useCallback, useRef, useEffect } from "react";
import type {
  UseJsonEditorOptions,
  UseJsonEditorReturn,
  CursorPosition,
} from "./types";

interface HistoryEntry {
  content: string;
  cursorPosition: CursorPosition;
}

const MAX_HISTORY_SIZE = 50;

function stringifyValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseJson(content: string): { value: unknown; error: string | null } {
  try {
    const value = JSON.parse(content);
    return { value, error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Invalid JSON";
    return { value: undefined, error };
  }
}

export function useJsonEditor({
  initialValue,
  initialContent: initialContentProp,
  onChange,
  onRawChange,
  onValidationError,
}: UseJsonEditorOptions): UseJsonEditorReturn {
  // Use raw content if provided, otherwise stringify the value
  const initialContent =
    initialContentProp !== undefined
      ? initialContentProp
      : stringifyValue(initialValue);
  const [content, setContentInternal] = useState(initialContent);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [cursorPosition, setCursorPosition] = useState<CursorPosition>({
    line: 1,
    column: 1,
  });

  // History for undo/redo
  const historyRef = useRef<HistoryEntry[]>([
    { content: initialContent, cursorPosition: { line: 1, column: 1 } },
  ]);
  const historyIndexRef = useRef(0);
  const isUndoRedoRef = useRef(false);

  // Sync initial value/content when it changes externally
  useEffect(() => {
    const newContent =
      initialContentProp !== undefined
        ? initialContentProp
        : stringifyValue(initialValue);
    if (newContent !== content && !isUndoRedoRef.current) {
      setContentInternal(newContent);
      historyRef.current = [
        { content: newContent, cursorPosition: { line: 1, column: 1 } },
      ];
      historyIndexRef.current = 0;
      // Validate the new content
      const { error } = parseJson(newContent);
      setValidationError(error);
      onValidationError?.(error);
    }
  }, [initialValue, initialContentProp]);

  const validate = useCallback(
    (text: string): boolean => {
      const { error } = parseJson(text);
      setValidationError(error);
      onValidationError?.(error);
      return error === null;
    },
    [onValidationError],
  );

  const setContent = useCallback(
    (newContent: string) => {
      if (isUndoRedoRef.current) {
        isUndoRedoRef.current = false;
        setContentInternal(newContent);
        validate(newContent);
        onRawChange?.(newContent);
        return;
      }

      setContentInternal(newContent);
      validate(newContent);

      // Add to history
      const currentIndex = historyIndexRef.current;
      const history = historyRef.current;

      // Remove any forward history if we're not at the end
      if (currentIndex < history.length - 1) {
        historyRef.current = history.slice(0, currentIndex + 1);
      }

      // Add new entry
      historyRef.current.push({ content: newContent, cursorPosition });

      // Trim history if too large
      if (historyRef.current.length > MAX_HISTORY_SIZE) {
        historyRef.current = historyRef.current.slice(-MAX_HISTORY_SIZE);
      }

      historyIndexRef.current = historyRef.current.length - 1;

      // Notify parent of raw content changes
      onRawChange?.(newContent);

      // Notify parent of valid parsed value changes
      const { value, error } = parseJson(newContent);
      if (error === null && onChange) {
        onChange(value);
      }
    },
    [cursorPosition, validate, onChange, onRawChange],
  );

  const undo = useCallback(() => {
    const history = historyRef.current;
    const currentIndex = historyIndexRef.current;

    if (currentIndex > 0) {
      isUndoRedoRef.current = true;
      historyIndexRef.current = currentIndex - 1;
      const entry = history[currentIndex - 1];
      setContentInternal(entry.content);
      setCursorPosition(entry.cursorPosition);
      validate(entry.content);
    }
  }, [validate]);

  const redo = useCallback(() => {
    const history = historyRef.current;
    const currentIndex = historyIndexRef.current;

    if (currentIndex < history.length - 1) {
      isUndoRedoRef.current = true;
      historyIndexRef.current = currentIndex + 1;
      const entry = history[currentIndex + 1];
      setContentInternal(entry.content);
      setCursorPosition(entry.cursorPosition);
      validate(entry.content);
    }
  }, [validate]);

  const format = useCallback(() => {
    const { value, error } = parseJson(content);
    if (error === null) {
      const formatted = JSON.stringify(value, null, 2);
      setContent(formatted);
    }
  }, [content, setContent]);

  const reset = useCallback(() => {
    const newContent = stringifyValue(initialValue);
    setContentInternal(newContent);
    historyRef.current = [
      { content: newContent, cursorPosition: { line: 1, column: 1 } },
    ];
    historyIndexRef.current = 0;
    setValidationError(null);
    onValidationError?.(null);
  }, [initialValue, onValidationError]);

  const getParsedValue = useCallback(() => {
    const { value, error } = parseJson(content);
    return error === null ? value : undefined;
  }, [content]);

  const canUndo = historyIndexRef.current > 0;
  const canRedo = historyIndexRef.current < historyRef.current.length - 1;

  return {
    content,
    setContent,
    isValid: validationError === null,
    validationError,
    cursorPosition,
    setCursorPosition,
    undo,
    redo,
    canUndo,
    canRedo,
    format,
    reset,
    getParsedValue,
  };
}
