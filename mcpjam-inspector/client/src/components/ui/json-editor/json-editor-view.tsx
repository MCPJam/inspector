import { useMemo } from "react";
import { JsonEditorEdit } from "./json-editor-edit";
import { JsonTreeView } from "./json-tree-view";

interface JsonEditorViewProps {
  value: unknown;
  className?: string;
  height?: string | number;
  maxHeight?: string | number;
  collapseStringsAfterLength?: number;
  collapsible?: boolean;
  defaultExpandDepth?: number;
  collapsedPaths?: Set<string>;
  onCollapseChange?: (paths: Set<string>) => void;
}

export function JsonEditorView({
  value,
  className,
  height,
  maxHeight,
  collapseStringsAfterLength,
  collapsible = false,
  defaultExpandDepth,
  collapsedPaths,
  onCollapseChange,
}: JsonEditorViewProps) {
  // Convert value to formatted JSON string (only needed for flat view)
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

  // Use collapsible tree view when enabled
  if (collapsible) {
    return (
      <JsonTreeView
        value={value}
        className={className}
        defaultExpandDepth={defaultExpandDepth}
        collapsedPaths={collapsedPaths}
        onCollapseChange={onCollapseChange}
        collapseStringsAfterLength={collapseStringsAfterLength}
      />
    );
  }

  return (
    <JsonEditorEdit
      content={content}
      readOnly
      className={className}
      height={height}
      maxHeight={maxHeight}
      collapseStringsAfterLength={collapseStringsAfterLength}
    />
  );
}
