import { useState, useCallback, useMemo, useEffect } from "react";

interface UseJsonTreeStateOptions {
  defaultExpandDepth?: number;
  initialCollapsedPaths?: Set<string>;
  onCollapseChange?: (paths: Set<string>) => void;
}

interface UseJsonTreeStateReturn {
  collapsedPaths: Set<string>;
  isCollapsed: (path: string) => boolean;
  toggleCollapse: (path: string) => void;
  expandAll: () => void;
  collapseAll: (value: unknown) => void;
  initializeFromValue: (value: unknown) => void;
}

// Each collapsed descendant costs a path string that grows with its depth, so
// scanning a deeply nested value is quadratic in memory. Stop past this many
// levels: anything deeper stays hidden behind a collapsed ancestor anyway.
const MAX_COLLAPSE_SCAN_DEPTH = 100;

// Walks iteratively rather than recursively: deeply nested values overflowed
// the call stack (INSPECTOR-CLIENT-232).
function getPathsAtDepth(value: unknown, maxDepth: number): string[] {
  const paths: string[] = [];
  const stack: Array<{ value: unknown; path: string; depth: number }> = [
    { value, path: "root", depth: 0 },
  ];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (typeof node.value !== "object" || node.value === null) continue;

    const entries: Array<[string, unknown]> = Array.isArray(node.value)
      ? node.value.map((item, index) => [String(index), item])
      : Object.entries(node.value);
    if (entries.length === 0) continue;

    if (node.depth >= maxDepth) {
      paths.push(node.path);
    }
    if (node.depth >= MAX_COLLAPSE_SCAN_DEPTH) continue;

    for (const [key, child] of entries) {
      stack.push({
        value: child,
        path: `${node.path}.${key}`,
        depth: node.depth + 1,
      });
    }
  }

  return paths;
}

// "Collapse everything" is the same walk with an expand depth of zero.
function getAllPaths(value: unknown): string[] {
  return getPathsAtDepth(value, 0);
}

export function useJsonTreeState({
  defaultExpandDepth,
  initialCollapsedPaths,
  onCollapseChange,
}: UseJsonTreeStateOptions = {}): UseJsonTreeStateReturn {
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(
    () => initialCollapsedPaths ?? new Set(),
  );
  const [initialized, setInitialized] = useState(false);

  const isCollapsed = useCallback(
    (path: string): boolean => collapsedPaths.has(path),
    [collapsedPaths],
  );

  const toggleCollapse = useCallback(
    (path: string) => {
      setCollapsedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        onCollapseChange?.(next);
        return next;
      });
    },
    [onCollapseChange],
  );

  const expandAll = useCallback(() => {
    setCollapsedPaths(new Set());
    onCollapseChange?.(new Set());
  }, [onCollapseChange]);

  const collapseAll = useCallback(
    (value: unknown) => {
      const allPaths = getAllPaths(value);
      const newCollapsed = new Set(allPaths);
      setCollapsedPaths(newCollapsed);
      onCollapseChange?.(newCollapsed);
    },
    [onCollapseChange],
  );

  const initializeFromValue = useCallback(
    (value: unknown) => {
      if (initialized || initialCollapsedPaths !== undefined) return;

      if (defaultExpandDepth !== undefined) {
        const pathsToCollapse = getPathsAtDepth(value, defaultExpandDepth);
        const newCollapsed = new Set(pathsToCollapse);
        setCollapsedPaths(newCollapsed);
        onCollapseChange?.(newCollapsed);
      }
      setInitialized(true);
    },
    [initialized, defaultExpandDepth, initialCollapsedPaths, onCollapseChange],
  );

  // Sync with external collapsed paths if controlled
  useEffect(() => {
    if (initialCollapsedPaths !== undefined) {
      setCollapsedPaths(initialCollapsedPaths);
    }
  }, [initialCollapsedPaths]);

  return useMemo(
    () => ({
      collapsedPaths,
      isCollapsed,
      toggleCollapse,
      expandAll,
      collapseAll,
      initializeFromValue,
    }),
    [
      collapsedPaths,
      isCollapsed,
      toggleCollapse,
      expandAll,
      collapseAll,
      initializeFromValue,
    ],
  );
}
