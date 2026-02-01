import { useMemo } from "react";
import { JsonEditorEdit } from "./json-editor-edit";

interface JsonEditorViewProps {
  value: unknown;
  className?: string;
  height?: string | number;
  maxHeight?: string | number;
}

export function JsonEditorView({
  value,
  className,
  height,
  maxHeight,
}: JsonEditorViewProps) {
  // Convert value to formatted JSON string
  const content = useMemo(() => {
    if (value === null || value === undefined) {
      return "null";
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);

  return (
    <JsonEditorEdit
      content={content}
      readOnly
      className={className}
      height={height}
      maxHeight={maxHeight}
    />
  );
}
