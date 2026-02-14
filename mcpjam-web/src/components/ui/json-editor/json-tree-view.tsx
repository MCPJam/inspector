import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { useJsonTreeState } from "./use-json-tree-state";
import { JsonTreeNode } from "./json-tree-node";

interface JsonTreeViewProps {
  value: unknown;
  className?: string;
  defaultExpandDepth?: number;
  collapsedPaths?: Set<string>;
  onCollapseChange?: (paths: Set<string>) => void;
  collapseStringsAfterLength?: number;
  onCopy?: (value: string) => void;
}

export function JsonTreeView({
  value,
  className,
  defaultExpandDepth,
  collapsedPaths: controlledCollapsedPaths,
  onCollapseChange,
  collapseStringsAfterLength,
  onCopy,
}: JsonTreeViewProps) {
  const { isCollapsed, toggleCollapse, initializeFromValue } = useJsonTreeState(
    {
      defaultExpandDepth,
      initialCollapsedPaths: controlledCollapsedPaths,
      onCollapseChange,
    },
  );

  // Initialize collapse state based on defaultExpandDepth
  useEffect(() => {
    initializeFromValue(value);
  }, [value, initializeFromValue]);

  return (
    <div
      className={cn(
        "p-3 text-xs overflow-auto select-text cursor-text",
        className,
        // pl-7 must come after className to ensure space for collapse toggles
        "pl-7",
      )}
      style={{ fontFamily: "var(--font-code)" }}
    >
      <JsonTreeNode
        value={value}
        path="root"
        isCollapsed={isCollapsed}
        toggleCollapse={toggleCollapse}
        collapseStringsAfterLength={collapseStringsAfterLength}
        onCopy={onCopy}
      />
    </div>
  );
}
