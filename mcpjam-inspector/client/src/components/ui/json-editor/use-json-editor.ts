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
const FALLBACK_JSON_CONTENT = "null";

function getDefaultCursorPosition(): CursorPosition {
  return { line: 1, column: 1 };
}

function stringifyValue(value: unknown): string {
  if (value === undefined) {
    return FALLBACK_JSON_CONTENT;
  }

  try {
    return JSON.stringify(value, null, 2) ?? FALLBACK_JSON_CONTENT;
  } catch {
    return FALLBACK_JSON_CONTENT;
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

function serializeParsedValue(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
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
  const initialContentFromProps =
    initialContentProp !== undefined
      ? initialContentProp
      : stringifyValue(initialValue);
  const initialParsed = parseJson(initialContentFromProps);
  const [content, setContentInternal] = useState(initialContentFromProps);
  const contentRef = useRef(initialContentFromProps);
  const lastEmittedParsedValueRef = useRef<string | null>(
    initialParsed.error === null
      ? serializeParsedValue(initialParsed.value)
      : null,
  );
  const [validationError, setValidationError] = useState<string | null>(() => {
    return initialParsed.error;
  });
  const [cursorPosition, setCursorPosition] = useState<CursorPosition>(
    getDefaultCursorPosition,
  );

  // History for undo/redo
  const historyRef = useRef<HistoryEntry[]>([
    {
      content: initialContentFromProps,
      cursorPosition: getDefaultCursorPosition(),
    },
  ]);
  const historyIndexRef = useRef(0);

  const validateContent = useCallback(
    (text: string) => {
      const parsed = parseJson(text);
      setValidationError(parsed.error);
      onValidationError?.(parsed.error);
      return parsed;
    },
    [onValidationError],
  );

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  // Sync initial value/content when it changes externally
  useEffect(() => {
    const newContent =
      initialContentProp !== undefined
        ? initialContentProp
        : stringifyValue(initialValue);
    if (newContent === contentRef.current) {
      return;
    }

    contentRef.current = newContent;
    setContentInternal(newContent);
    setCursorPosition(getDefaultCursorPosition());
    historyRef.current = [
      { content: newContent, cursorPosition: getDefaultCursorPosition() },
    ];
    historyIndexRef.current = 0;
    validateContent(newContent);
    const parsed = parseJson(newContent);
    lastEmittedParsedValueRef.current =
      parsed.error === null ? serializeParsedValue(parsed.value) : null;
  }, [initialValue, initialContentProp, validateContent]);

  const notifyChangeCallbacks = useCallback(
    (newContent: string, parsedValue?: unknown, error?: string | null) => {
      onRawChange?.(newContent);

      const emitOnChangeIfNeeded = (value: unknown) => {
        const serialized = serializeParsedValue(value);

        // Fallback for unexpected non-serializable values
        if (serialized === null) {
          onChange?.(value);
          return;
        }

        if (serialized === lastEmittedParsedValueRef.current) {
          return;
        }

        lastEmittedParsedValueRef.current = serialized;
        onChange?.(value);
      };

      if (error === undefined) {
        const result = parseJson(newContent);
        if (result.error === null) {
          emitOnChangeIfNeeded(result.value);
        }
        return;
      }

      if (error === null) {
        emitOnChangeIfNeeded(parsedValue);
      }
    },
    [onChange, onRawChange],
  );

  const setContent = useCallback(
    (newContent: string) => {
      if (newContent === contentRef.current) {
        return;
      }

      contentRef.current = newContent;
      setContentInternal(newContent);
      const { value, error } = validateContent(newContent);

      // Add to history
      const currentIndex = historyIndexRef.current;
      let history = historyRef.current;

      // Remove any forward history if we're not at the end
      if (currentIndex < history.length - 1) {
        history = history.slice(0, currentIndex + 1);
      }

      const currentEntry = history[history.length - 1];

      if (!currentEntry || currentEntry.content !== newContent) {
        history = [...history, { content: newContent, cursorPosition }];
      }

      // Trim history if too large
      if (history.length > MAX_HISTORY_SIZE) {
        history = history.slice(-MAX_HISTORY_SIZE);
      }

      historyRef.current = history;
      historyIndexRef.current = history.length - 1;

      notifyChangeCallbacks(newContent, value, error);
    },
    [cursorPosition, notifyChangeCallbacks, validateContent],
  );

  const applyHistoryEntry = useCallback(
    (entry: HistoryEntry) => {
      contentRef.current = entry.content;
      setContentInternal(entry.content);
      setCursorPosition(entry.cursorPosition);
      const { value, error } = validateContent(entry.content);
      notifyChangeCallbacks(entry.content, value, error);
    },
    [notifyChangeCallbacks, validateContent],
  );

  const undo = useCallback(() => {
    const history = historyRef.current;
    const currentIndex = historyIndexRef.current;

    if (currentIndex > 0) {
      historyIndexRef.current = currentIndex - 1;
      const entry = history[currentIndex - 1];
      applyHistoryEntry(entry);
    }
  }, [applyHistoryEntry]);

  const redo = useCallback(() => {
    const history = historyRef.current;
    const currentIndex = historyIndexRef.current;

    if (currentIndex < history.length - 1) {
      historyIndexRef.current = currentIndex + 1;
      const entry = history[currentIndex + 1];
      applyHistoryEntry(entry);
    }
  }, [applyHistoryEntry]);

  const format = useCallback(() => {
    const { value, error } = parseJson(content);
    if (error === null) {
      const formatted = JSON.stringify(value, null, 2);
      setContent(formatted);
    }
  }, [content, setContent]);

  const reset = useCallback(() => {
    const newContent =
      initialContentProp !== undefined
        ? initialContentProp
        : stringifyValue(initialValue);
    contentRef.current = newContent;
    setContentInternal(newContent);
    setCursorPosition(getDefaultCursorPosition());
    historyRef.current = [
      { content: newContent, cursorPosition: getDefaultCursorPosition() },
    ];
    historyIndexRef.current = 0;
    const { value, error } = validateContent(newContent);
    notifyChangeCallbacks(newContent, value, error);
  }, [
    initialValue,
    initialContentProp,
    validateContent,
    notifyChangeCallbacks,
  ]);

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
