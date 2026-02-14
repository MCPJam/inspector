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

export function expandJsonStringsInValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null) {
        return expandJsonStringsInValue(parsed);
      }
    } catch {
      // not valid JSON, keep as string
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(expandJsonStringsInValue);
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value))
      result[key] = expandJsonStringsInValue(val);
    return result;
  }
  return value;
}

function collapseJsonStringsInValue(
  current: unknown,
  original: unknown,
): unknown {
  if (typeof original === "string" && typeof current !== "string") {
    try {
      const parsed = JSON.parse(original);
      if (typeof parsed === "object" && parsed !== null) {
        return JSON.stringify(current);
      }
    } catch {
      // original wasn't a JSON string, return as-is
    }
  }
  if (
    typeof current === "object" &&
    current !== null &&
    !Array.isArray(current) &&
    typeof original === "object" &&
    original !== null &&
    !Array.isArray(original)
  ) {
    const result: Record<string, unknown> = {};
    const origObj = original as Record<string, unknown>;
    for (const [key, val] of Object.entries(current as Record<string, unknown>))
      result[key] =
        key in origObj ? collapseJsonStringsInValue(val, origObj[key]) : val;
    return result;
  }
  if (Array.isArray(current) && Array.isArray(original)) {
    return current.map((item, i) =>
      i < original.length
        ? collapseJsonStringsInValue(item, original[i])
        : item,
    );
  }
  return current;
}

function computeDisplayContent(
  rawContent: string | undefined,
  value: unknown,
  expand: boolean,
): string {
  if (rawContent !== undefined) return rawContent;
  return stringifyValue(expand ? expandJsonStringsInValue(value) : value);
}

export function useJsonEditor({
  initialValue,
  initialContent: initialContentProp,
  onChange,
  onRawChange,
  onValidationError,
  expandJsonStrings = false,
}: UseJsonEditorOptions): UseJsonEditorReturn {
  // Lazy first-render initialization — avoids expensive expand+stringify on every render
  const initRef = useRef<{
    content: string;
    lastEmitted: string | null;
    error: string | null;
  } | null>(null);
  if (initRef.current === null) {
    const content = computeDisplayContent(
      initialContentProp,
      initialValue,
      expandJsonStrings,
    );
    const parsed = parseJson(content);
    let lastEmitted: string | null;
    if (parsed.error !== null) {
      lastEmitted = null;
    } else if (expandJsonStrings) {
      lastEmitted = serializeParsedValue(
        collapseJsonStringsInValue(parsed.value, initialValue),
      );
    } else {
      lastEmitted = serializeParsedValue(parsed.value);
    }
    initRef.current = {
      content,
      lastEmitted,
      error: parsed.error,
    };
  }

  const [content, setContentInternal] = useState(initRef.current.content);

  // Track the original (unexpanded) value for collapsing back on onChange
  const originalValueRef = useRef(initialValue);
  const contentRef = useRef(initRef.current.content);
  const sourceContentRef = useRef(initRef.current.content);
  const lastEmittedParsedValueRef = useRef<string | null>(
    initRef.current.lastEmitted,
  );
  const [validationError, setValidationError] = useState<string | null>(
    initRef.current.error,
  );
  const [cursorPosition, setCursorPosition] = useState<CursorPosition>(
    getDefaultCursorPosition,
  );

  // History for undo/redo
  const historyRef = useRef<HistoryEntry[]>([
    {
      content: initRef.current.content,
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

  // Render-time sourceContent update: detect when inputs change and update
  // sourceContentRef synchronously so the returned value is always current.
  // Uses round-trip detection to skip expensive expand+stringify during typing.
  const prevInputsRef = useRef({
    value: initialValue,
    content: initialContentProp,
  });
  if (
    initialValue !== prevInputsRef.current.value ||
    initialContentProp !== prevInputsRef.current.content
  ) {
    prevInputsRef.current = {
      value: initialValue,
      content: initialContentProp,
    };
    if (initialContentProp === undefined && expandJsonStrings) {
      const incomingSerialized = serializeParsedValue(initialValue);
      if (
        incomingSerialized !== null &&
        incomingSerialized === lastEmittedParsedValueRef.current
      ) {
        // Round-trip: parent echoed back our onChange — no expensive computation
        originalValueRef.current = initialValue;
        sourceContentRef.current = contentRef.current;
      } else {
        // Genuine external change
        originalValueRef.current = initialValue;
        sourceContentRef.current = computeDisplayContent(
          undefined,
          initialValue,
          true,
        );
      }
    } else {
      originalValueRef.current = initialValue;
      sourceContentRef.current = computeDisplayContent(
        initialContentProp,
        initialValue,
        expandJsonStrings,
      );
    }
  }

  // Sync initial value/content when it changes externally (state updates)
  useEffect(() => {
    const newContent = sourceContentRef.current;
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
    // Compute lastEmitted from collapsed form so dedup works correctly
    const parsed = parseJson(newContent);
    if (parsed.error === null && expandJsonStrings) {
      const collapsed = collapseJsonStringsInValue(parsed.value, initialValue);
      lastEmittedParsedValueRef.current = serializeParsedValue(collapsed);
    } else {
      lastEmittedParsedValueRef.current =
        parsed.error === null ? serializeParsedValue(parsed.value) : null;
    }
  }, [initialValue, initialContentProp, validateContent, expandJsonStrings]);

  const notifyChangeCallbacks = useCallback(
    (newContent: string, parsedValue?: unknown, error?: string | null) => {
      onRawChange?.(newContent);

      const emitOnChangeIfNeeded = (value: unknown) => {
        const valueToEmit = expandJsonStrings
          ? collapseJsonStringsInValue(value, originalValueRef.current)
          : value;
        const serialized = serializeParsedValue(valueToEmit);

        // Fallback for unexpected non-serializable values
        if (serialized === null) {
          onChange?.(valueToEmit);
          return;
        }

        if (serialized === lastEmittedParsedValueRef.current) {
          return;
        }

        lastEmittedParsedValueRef.current = serialized;
        onChange?.(valueToEmit);
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
    [onChange, onRawChange, expandJsonStrings],
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
      const toFormat = expandJsonStrings
        ? expandJsonStringsInValue(value)
        : value;
      const formatted = JSON.stringify(toFormat, null, 2);
      setContent(formatted);
    }
  }, [content, setContent, expandJsonStrings]);

  const reset = useCallback(() => {
    originalValueRef.current = initialValue;
    const newContent = computeDisplayContent(
      initialContentProp,
      initialValue,
      expandJsonStrings,
    );
    sourceContentRef.current = newContent;
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
    expandJsonStrings,
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
    sourceContent: sourceContentRef.current,
  };
}
