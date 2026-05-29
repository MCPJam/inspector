import { useEffect, useMemo, useRef } from "react";
import { json } from "@codemirror/lang-json";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { cn } from "@/lib/utils";
import type { CursorPosition } from "./types";

interface CodeMirrorJsonEditorProps {
  content: string;
  onChange?: (content: string) => void;
  onCursorChange?: (position: CursorPosition) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onEscape?: () => void;
  isValid?: boolean;
  height?: string | number;
  maxHeight?: string | number;
  showLineNumbers?: boolean;
  wrapLongLines?: boolean;
  className?: string;
}

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    width: "100%",
    backgroundColor: "transparent",
    color: "var(--foreground)",
    fontSize: "12px",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    height: "100%",
    overflow: "auto",
    fontFamily: "var(--font-code)",
    lineHeight: "20px",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "12px 0",
    caretColor: "var(--foreground)",
  },
  ".cm-line": {
    padding: "0 12px",
  },
  ".cm-gutters": {
    backgroundColor: "color-mix(in oklch, var(--muted) 50%, transparent)",
    color: "var(--muted-foreground)",
    borderRight:
      "1px solid color-mix(in oklch, var(--border) 50%, transparent)",
    fontFamily: "var(--font-code)",
    fontSize: "12px",
    lineHeight: "20px",
    paddingTop: "12px",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "2.5rem",
    padding: "0 8px 0 0",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklch, var(--foreground) 3%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in oklch, var(--foreground) 3%, transparent)",
    color: "var(--foreground)",
    fontWeight: "500",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    {
      backgroundColor: "color-mix(in oklch, var(--primary) 20%, transparent)",
    },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--foreground)",
  },
  ".cm-matchingBracket": {
    backgroundColor: "color-mix(in oklch, var(--primary) 14%, transparent)",
    outline: "1px solid color-mix(in oklch, var(--primary) 35%, transparent)",
  },
});

const jsonHighlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--json-key)" },
  { tag: tags.string, color: "var(--json-string)" },
  { tag: tags.number, color: "var(--json-number)" },
  { tag: tags.bool, color: "var(--json-boolean)" },
  { tag: tags.null, color: "var(--json-null)" },
  { tag: tags.punctuation, color: "var(--json-punctuation)" },
  { tag: tags.invalid, color: "var(--destructive)" },
]);

function toCursorPosition(view: EditorView): CursorPosition {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return {
    line: line.number,
    column: head - line.from + 1,
  };
}

function formatSize(value: string | number | undefined, fallback: string) {
  if (typeof value === "number") {
    return `${value}px`;
  }

  return value ?? fallback;
}

export function CodeMirrorJsonEditor({
  content,
  onChange,
  onCursorChange,
  onUndo,
  onRedo,
  onEscape,
  isValid = true,
  height,
  maxHeight,
  showLineNumbers = true,
  wrapLongLines = true,
  className,
}: CodeMirrorJsonEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef(content);
  const handlersRef = useRef({
    onChange,
    onCursorChange,
    onUndo,
    onRedo,
    onEscape,
  });

  contentRef.current = content;
  handlersRef.current = { onChange, onCursorChange, onUndo, onRedo, onEscape };

  const extensions = useMemo(() => {
    const nextExtensions: Extension[] = [
      editorTheme,
      syntaxHighlighting(jsonHighlightStyle),
      json(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          handlersRef.current.onChange?.(update.state.doc.toString());
        }

        if (update.docChanged || update.selectionSet || update.focusChanged) {
          handlersRef.current.onCursorChange?.(toCursorPosition(update.view));
        }
      }),
      keymap.of([
        {
          key: "Mod-z",
          run: () => {
            handlersRef.current.onUndo?.();
            return true;
          },
        },
        {
          key: "Mod-y",
          run: () => {
            handlersRef.current.onRedo?.();
            return true;
          },
        },
        {
          key: "Shift-Mod-z",
          run: () => {
            handlersRef.current.onRedo?.();
            return true;
          },
        },
        {
          key: "Escape",
          run: () => {
            handlersRef.current.onEscape?.();
            return true;
          },
        },
        indentWithTab,
        ...defaultKeymap,
      ]),
    ];

    if (showLineNumbers) {
      nextExtensions.push(lineNumbers(), highlightActiveLineGutter());
    }

    if (wrapLongLines) {
      nextExtensions.push(EditorView.lineWrapping);
    }

    return nextExtensions;
  }, [showLineNumbers, wrapLongLines]);

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }

    const view = new EditorView({
      state: EditorState.create({
        doc: contentRef.current,
        extensions,
      }),
      parent: hostRef.current,
    });

    viewRef.current = view;
    handlersRef.current.onCursorChange?.(toCursorPosition(view));

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [extensions]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === content) {
      return;
    }

    const selectionHead = Math.min(
      view.state.selection.main.head,
      content.length,
    );

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      selection: { anchor: selectionHead },
    });
  }, [content]);

  return (
    <div
      className={cn(
        "h-full w-full overflow-hidden bg-muted/30",
        !isValid && "border-destructive",
        className,
      )}
      style={{
        height: formatSize(height, "100%"),
        maxHeight: formatSize(maxHeight, "none"),
      }}
    >
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
