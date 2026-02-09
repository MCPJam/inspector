import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useJsonEditor } from "../use-json-editor";

describe("useJsonEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("initial value handling", () => {
    it("initializes with provided object value", () => {
      const initialValue = { name: "John", age: 30 };
      const { result } = renderHook(() => useJsonEditor({ initialValue }));

      expect(result.current.content).toBe(
        JSON.stringify(initialValue, null, 2),
      );
      expect(result.current.isValid).toBe(true);
    });

    it("initializes with provided string content", () => {
      const initialContent = '{"key": "value"}';
      const { result } = renderHook(() => useJsonEditor({ initialContent }));

      expect(result.current.content).toBe(initialContent);
      expect(result.current.isValid).toBe(true);
    });

    it("prefers initialContent over initialValue when both provided", () => {
      const initialValue = { ignored: true };
      const initialContent = '{"used": true}';
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue, initialContent }),
      );

      expect(result.current.content).toBe(initialContent);
    });

    it("handles null initial value", () => {
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue: null }),
      );

      expect(result.current.content).toBe("null");
      expect(result.current.isValid).toBe(true);
    });

    it("handles array initial value", () => {
      const initialValue = [1, 2, 3];
      const { result } = renderHook(() => useJsonEditor({ initialValue }));

      expect(result.current.content).toBe(
        JSON.stringify(initialValue, null, 2),
      );
      expect(result.current.isValid).toBe(true);
    });

    it("handles primitive initial values", () => {
      const { result: stringResult } = renderHook(() =>
        useJsonEditor({ initialValue: "hello" }),
      );
      expect(stringResult.current.content).toBe('"hello"');

      const { result: numberResult } = renderHook(() =>
        useJsonEditor({ initialValue: 42 }),
      );
      expect(numberResult.current.content).toBe("42");

      const { result: boolResult } = renderHook(() =>
        useJsonEditor({ initialValue: true }),
      );
      expect(boolResult.current.content).toBe("true");
    });

    it("falls back to null for undefined initial value", () => {
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue: undefined }),
      );

      expect(result.current.content).toBe("null");
      expect(result.current.isValid).toBe(true);
    });
  });

  describe("onChange and onRawChange callbacks", () => {
    it("calls onChange callback with parsed value for valid JSON", () => {
      const onChange = vi.fn();
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue: {}, onChange }),
      );

      act(() => {
        result.current.setContent('{"updated": true}');
      });

      expect(onChange).toHaveBeenCalledWith({ updated: true });
    });

    it("does not call onChange for invalid JSON", () => {
      const onChange = vi.fn();
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue: {}, onChange }),
      );

      act(() => {
        result.current.setContent("{invalid json");
      });

      expect(onChange).not.toHaveBeenCalled();
    });

    it("calls onRawChange for all content changes", () => {
      const onRawChange = vi.fn();
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue: {}, onRawChange }),
      );

      act(() => {
        result.current.setContent("{invalid");
      });

      expect(onRawChange).toHaveBeenCalledWith("{invalid");
    });

    it("calls onRawChange for valid content", () => {
      const onRawChange = vi.fn();
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue: {}, onRawChange }),
      );

      act(() => {
        result.current.setContent('{"valid": true}');
      });

      expect(onRawChange).toHaveBeenCalledWith('{"valid": true}');
    });

    it("does not call onChange for whitespace-only valid edits", () => {
      const onChange = vi.fn();
      const onRawChange = vi.fn();
      const { result } = renderHook(() =>
        useJsonEditor({
          initialContent: '{"unchanged": true}',
          onChange,
          onRawChange,
        }),
      );

      act(() => {
        result.current.setContent('{\n  "unchanged": true\n}\n');
      });

      expect(onRawChange).toHaveBeenCalledWith('{\n  "unchanged": true\n}\n');
      expect(onChange).not.toHaveBeenCalled();
    });

    it("still calls onChange when parsed JSON changes after whitespace edits", () => {
      const onChange = vi.fn();
      const { result } = renderHook(() =>
        useJsonEditor({
          initialContent: '{"count": 1}',
          onChange,
        }),
      );

      act(() => {
        result.current.setContent('{\n  "count": 1\n}\n');
      });

      expect(onChange).not.toHaveBeenCalled();

      act(() => {
        result.current.setContent('{\n  "count": 2\n}\n');
      });

      expect(onChange).toHaveBeenCalledWith({ count: 2 });
    });
  });

  describe("validation", () => {
    it("validates initial content immediately", () => {
      const { result: validResult } = renderHook(() =>
        useJsonEditor({ initialContent: '{"valid": true}' }),
      );
      expect(validResult.current.isValid).toBe(true);
      expect(validResult.current.validationError).toBeNull();

      const { result: invalidResult } = renderHook(() =>
        useJsonEditor({ initialContent: "{invalid" }),
      );
      expect(invalidResult.current.isValid).toBe(false);
      expect(invalidResult.current.validationError).toEqual(expect.any(String));
    });

    it("calls onValidationError callback with error", () => {
      const onValidationError = vi.fn();
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue: {}, onValidationError }),
      );

      act(() => {
        result.current.setContent("{bad}");
      });

      expect(onValidationError).toHaveBeenCalled();
      const errorArg = onValidationError.mock.calls[0][0];
      expect(typeof errorArg).toBe("string");
      expect(errorArg.length).toBeGreaterThan(0);
    });

    it("calls onValidationError with null when content is valid", () => {
      const onValidationError = vi.fn();
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue: {}, onValidationError }),
      );

      act(() => {
        result.current.setContent('{"valid": true}');
      });

      expect(onValidationError).toHaveBeenCalledWith(null);
    });
  });

  describe("format function", () => {
    it("formats compact JSON to pretty-printed", () => {
      const { result } = renderHook(() =>
        useJsonEditor({ initialContent: '{"a":1,"b":2}' }),
      );

      act(() => {
        result.current.format();
      });

      expect(result.current.content).toBe(
        JSON.stringify({ a: 1, b: 2 }, null, 2),
      );
    });

    it("does not change invalid JSON on format", () => {
      const { result } = renderHook(() =>
        useJsonEditor({ initialContent: "{invalid" }),
      );

      const originalContent = result.current.content;

      act(() => {
        result.current.format();
      });

      expect(result.current.content).toBe(originalContent);
    });
  });

  describe("reset function", () => {
    it("resets content to initial value", () => {
      const initialValue = { original: true };
      const { result } = renderHook(() => useJsonEditor({ initialValue }));

      const expectedContent = JSON.stringify(initialValue, null, 2);

      act(() => {
        result.current.setContent('{"changed": true}');
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.content).toBe(expectedContent);
    });

    it("resets content to initial raw content when provided", () => {
      const initialContent = '{"raw": "original"}';
      const { result } = renderHook(() =>
        useJsonEditor({ initialContent, initialValue: { ignored: true } }),
      );

      act(() => {
        result.current.setContent('{"raw": "changed"}');
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.content).toBe(initialContent);
    });

    it("clears validation error on reset", () => {
      const onValidationError = vi.fn();
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue: {}, onValidationError }),
      );

      act(() => {
        result.current.setContent("{invalid");
      });

      // Verify validation error was set (look for non-null error in calls)
      const errorCalls = onValidationError.mock.calls.filter(
        (call) => call[0] !== null,
      );
      expect(errorCalls.length).toBeGreaterThan(0);

      act(() => {
        result.current.reset();
      });

      expect(result.current.isValid).toBe(true);
      expect(result.current.validationError).toBeNull();
    });

    it("calls onValidationError with null on reset", () => {
      const onValidationError = vi.fn();
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue: {}, onValidationError }),
      );

      act(() => {
        result.current.setContent("{invalid");
      });

      onValidationError.mockClear();

      act(() => {
        result.current.reset();
      });

      expect(onValidationError).toHaveBeenCalledWith(null);
    });

    it("notifies change callbacks on reset", () => {
      const onChange = vi.fn();
      const onRawChange = vi.fn();
      const initialValue = { original: true };
      const expectedContent = JSON.stringify(initialValue, null, 2);
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue, onChange, onRawChange }),
      );

      act(() => {
        result.current.setContent('{"changed": true}');
      });

      onChange.mockClear();
      onRawChange.mockClear();

      act(() => {
        result.current.reset();
      });

      expect(onRawChange).toHaveBeenCalledWith(expectedContent);
      expect(onChange).toHaveBeenCalledWith(initialValue);
    });
  });

  describe("getParsedValue", () => {
    it("returns parsed value for valid JSON", () => {
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue: { test: true } }),
      );

      expect(result.current.getParsedValue()).toEqual({ test: true });
    });

    it("returns undefined for invalid JSON", () => {
      const { result } = renderHook(() =>
        useJsonEditor({ initialContent: "{invalid" }),
      );

      expect(result.current.getParsedValue()).toBeUndefined();
    });

    it("returns null for null content", () => {
      const { result } = renderHook(() =>
        useJsonEditor({ initialContent: "null" }),
      );

      expect(result.current.getParsedValue()).toBeNull();
    });

    it("returns array for array content", () => {
      const { result } = renderHook(() =>
        useJsonEditor({ initialContent: "[1, 2, 3]" }),
      );

      expect(result.current.getParsedValue()).toEqual([1, 2, 3]);
    });
  });

  describe("cursor position", () => {
    it("initializes cursor at line 1, column 1", () => {
      const { result } = renderHook(() => useJsonEditor({ initialValue: {} }));

      expect(result.current.cursorPosition).toEqual({ line: 1, column: 1 });
    });

    it("updates cursor position when setCursorPosition is called", () => {
      const { result } = renderHook(() => useJsonEditor({ initialValue: {} }));

      act(() => {
        result.current.setCursorPosition({ line: 5, column: 10 });
      });

      expect(result.current.cursorPosition).toEqual({ line: 5, column: 10 });
    });
  });

  describe("undo/redo behavior", () => {
    it("starts with canUndo false", () => {
      const { result } = renderHook(() => useJsonEditor({ initialValue: {} }));

      expect(result.current.canUndo).toBe(false);
    });

    it("starts with canRedo false", () => {
      const { result } = renderHook(() => useJsonEditor({ initialValue: {} }));

      expect(result.current.canRedo).toBe(false);
    });

    it("undo function exists and is callable", () => {
      const { result } = renderHook(() => useJsonEditor({ initialValue: {} }));

      expect(typeof result.current.undo).toBe("function");

      // Should not throw when called with no history
      act(() => {
        result.current.undo();
      });
    });

    it("redo function exists and is callable", () => {
      const { result } = renderHook(() => useJsonEditor({ initialValue: {} }));

      expect(typeof result.current.redo).toBe("function");

      // Should not throw when called with no redo history
      act(() => {
        result.current.redo();
      });
    });

    it("undo restores previous content after change", () => {
      const { result } = renderHook(() =>
        useJsonEditor({ initialContent: '{"v": 1}' }),
      );

      act(() => {
        result.current.setContent('{"v": 2}');
      });

      expect(result.current.content).toBe('{"v": 2}');

      act(() => {
        result.current.undo();
      });

      expect(result.current.content).toBe('{"v": 1}');
    });

    it("redo restores content after undo", () => {
      const { result } = renderHook(() =>
        useJsonEditor({ initialContent: '{"v": 1}' }),
      );

      act(() => {
        result.current.setContent('{"v": 2}');
      });

      act(() => {
        result.current.undo();
      });

      expect(result.current.content).toBe('{"v": 1}');

      act(() => {
        result.current.redo();
      });

      expect(result.current.content).toBe('{"v": 2}');
    });

    it("undo validates restored content", () => {
      const onValidationError = vi.fn();
      const { result } = renderHook(() =>
        useJsonEditor({ initialContent: '{"valid": true}', onValidationError }),
      );

      // Initial content is valid
      expect(result.current.isValid).toBe(true);

      act(() => {
        result.current.setContent("{invalid");
      });

      // Now invalid
      expect(onValidationError).toHaveBeenCalled();
      const lastCall = onValidationError.mock.calls.pop();
      expect(lastCall[0]).not.toBeNull();

      act(() => {
        result.current.undo();
      });

      // After undo, we're back to valid content
      expect(result.current.isValid).toBe(true);
    });

    it("undo and redo notify parent callbacks with restored state", () => {
      const onChange = vi.fn();
      const onRawChange = vi.fn();
      const { result } = renderHook(() =>
        useJsonEditor({ initialContent: '{"v": 1}', onChange, onRawChange }),
      );

      act(() => {
        result.current.setContent('{"v": 2}');
      });

      onChange.mockClear();
      onRawChange.mockClear();

      act(() => {
        result.current.undo();
      });

      expect(onRawChange).toHaveBeenCalledWith('{"v": 1}');
      expect(onChange).toHaveBeenCalledWith({ v: 1 });

      onChange.mockClear();
      onRawChange.mockClear();

      act(() => {
        result.current.redo();
      });

      expect(onRawChange).toHaveBeenCalledWith('{"v": 2}');
      expect(onChange).toHaveBeenCalledWith({ v: 2 });
    });
  });

  describe("expandJsonStrings", () => {
    it("expands JSON string fields into objects on init", () => {
      const initialValue = {
        toolInput: { elements: '[{"type":"ellipse","x":10}]' },
      };
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue, expandJsonStrings: true }),
      );

      const parsed = JSON.parse(result.current.content);
      expect(parsed.toolInput.elements).toEqual([{ type: "ellipse", x: 10 }]);
    });

    it("collapses expanded fields back to strings on onChange", () => {
      const onChange = vi.fn();
      const initialValue = {
        toolInput: { elements: '[{"type":"ellipse"}]' },
      };
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue, onChange, expandJsonStrings: true }),
      );

      // Modify an unrelated field to trigger onChange
      const parsed = JSON.parse(result.current.content);
      parsed.toolInput.elements[0].type = "rectangle";
      act(() => {
        result.current.setContent(JSON.stringify(parsed, null, 2));
      });

      expect(onChange).toHaveBeenCalled();
      const emitted = onChange.mock.calls[0][0];
      // elements should be collapsed back to a string
      expect(typeof emitted.toolInput.elements).toBe("string");
      expect(JSON.parse(emitted.toolInput.elements)).toEqual([
        { type: "rectangle" },
      ]);
    });

    it("does not fire onChange when content is unchanged (dedup)", () => {
      const onChange = vi.fn();
      const initialValue = {
        toolInput: { elements: '[{"type":"ellipse"}]' },
      };
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue, onChange, expandJsonStrings: true }),
      );

      // Re-set same expanded content
      act(() => {
        result.current.setContent(result.current.content);
      });

      expect(onChange).not.toHaveBeenCalled();
    });

    it("format preserves expansion", () => {
      const initialValue = {
        data: '{"nested":"value"}',
      };
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue, expandJsonStrings: true }),
      );

      // Compact the content manually
      const parsed = JSON.parse(result.current.content);
      act(() => {
        result.current.setContent(JSON.stringify(parsed));
      });

      // Format should re-expand
      act(() => {
        result.current.format();
      });

      const formatted = JSON.parse(result.current.content);
      expect(formatted.data).toEqual({ nested: "value" });
    });

    it("reset re-expands from original value", () => {
      const initialValue = {
        items: "[1,2,3]",
      };
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue, expandJsonStrings: true }),
      );

      // Edit content
      act(() => {
        result.current.setContent('{"items": [99]}');
      });

      // Reset
      act(() => {
        result.current.reset();
      });

      const parsed = JSON.parse(result.current.content);
      expect(parsed.items).toEqual([1, 2, 3]);
    });

    it("re-expands when value changes externally", () => {
      const { result, rerender } = renderHook(
        ({ value }) =>
          useJsonEditor({ initialValue: value, expandJsonStrings: true }),
        {
          initialProps: {
            value: { data: '{"v":1}' } as unknown,
          },
        },
      );

      let parsed = JSON.parse(result.current.content);
      expect(parsed.data).toEqual({ v: 1 });

      rerender({ value: { data: '{"v":2}' } });

      parsed = JSON.parse(result.current.content);
      expect(parsed.data).toEqual({ v: 2 });
    });

    it("keeps primitive JSON strings as strings", () => {
      const initialValue = {
        count: "42",
        flag: "true",
        name: "hello",
      };
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue, expandJsonStrings: true }),
      );

      const parsed = JSON.parse(result.current.content);
      // Primitives should NOT be expanded
      expect(parsed.count).toBe("42");
      expect(parsed.flag).toBe("true");
      expect(parsed.name).toBe("hello");
    });

    it("does not double-stringify when user changes type", () => {
      const onChange = vi.fn();
      const initialValue = {
        data: '{"key":"val"}',
      };
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue, onChange, expandJsonStrings: true }),
      );

      // User replaces the expanded object with a string
      act(() => {
        result.current.setContent('{\n  "data": "plain string"\n}');
      });

      expect(onChange).toHaveBeenCalled();
      const emitted = onChange.mock.calls[0][0];
      // Since original was a string and current is also a string, no collapse needed
      expect(emitted.data).toBe("plain string");
    });

    it("sourceContent matches content on init", () => {
      const initialValue = {
        toolInput: { elements: '[{"type":"ellipse"}]' },
      };
      const { result } = renderHook(() =>
        useJsonEditor({ initialValue, expandJsonStrings: true }),
      );

      expect(result.current.sourceContent).toBe(result.current.content);
    });

    it("sourceContent updates on round-trip (parent echoes onChange)", () => {
      const onChange = vi.fn();
      const initialValue = {
        toolInput: { elements: '[{"type":"ellipse"}]' },
      };
      const { result, rerender } = renderHook(
        ({ value }) =>
          useJsonEditor({
            initialValue: value,
            onChange,
            expandJsonStrings: true,
          }),
        { initialProps: { value: initialValue as unknown } },
      );

      // Edit content
      const parsed = JSON.parse(result.current.content);
      parsed.toolInput.elements[0].type = "rectangle";
      act(() => {
        result.current.setContent(JSON.stringify(parsed, null, 2));
      });

      // Simulate parent echoing back the collapsed onChange value
      const collapsedValue = onChange.mock.calls[0][0];
      rerender({ value: collapsedValue });

      // sourceContent should track current editor content after round-trip
      expect(result.current.sourceContent).toBe(result.current.content);
    });

    it("sourceContent updates on genuine external change", () => {
      const { result, rerender } = renderHook(
        ({ value }) =>
          useJsonEditor({ initialValue: value, expandJsonStrings: true }),
        {
          initialProps: {
            value: { data: '{"v":1}' } as unknown,
          },
        },
      );

      const initialSourceContent = result.current.sourceContent;

      // External change (not a round-trip)
      rerender({ value: { data: '{"v":2}' } });

      expect(result.current.sourceContent).not.toBe(initialSourceContent);
      expect(result.current.sourceContent).toBe(result.current.content);
    });
  });

  describe("external value sync", () => {
    it("syncs content when initialValue prop changes", () => {
      const { result, rerender } = renderHook(
        ({ value }) => useJsonEditor({ initialValue: value }),
        { initialProps: { value: { version: 1 } } },
      );

      expect(result.current.content).toBe('{\n  "version": 1\n}');

      rerender({ value: { version: 2 } });

      expect(result.current.content).toBe('{\n  "version": 2\n}');
    });

    it("syncs content when initialContent prop changes", () => {
      const { result, rerender } = renderHook(
        ({ content }) => useJsonEditor({ initialContent: content }),
        { initialProps: { content: '{"v": 1}' } },
      );

      expect(result.current.content).toBe('{"v": 1}');

      rerender({ content: '{"v": 2}' });

      expect(result.current.content).toBe('{"v": 2}');
    });
  });
});
