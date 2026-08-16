import { useState, useCallback, useMemo, useEffect, useRef } from "react";

interface UseJsonTreeStateOptions {
  /**
   * The value being rendered. Needed at hook-call time so the initial collapse
   * state can be derived on the first render rather than after it.
   */
  value?: unknown;
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

    // Array.from, not map: map keeps holes, and destructuring a hole in the
    // loop below throws. Holes materialize as undefined and get skipped by the
    // object check above, matching the forEach this walk replaced.
    const entries: Array<[string, unknown]> = Array.isArray(node.value)
      ? Array.from(node.value, (item, index) => [String(index), item])
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
  value,
  defaultExpandDepth,
  initialCollapsedPaths,
  onCollapseChange,
}: UseJsonTreeStateOptions = {}): UseJsonTreeStateReturn {
  // Derived during the first render, not in a mount effect: an effect commits
  // after that render, so the tree would paint fully expanded once before
  // collapsing. That is wasted work on a large tool result and exhausts the
  // renderer's heap on a deeply nested one (INSPECTOR-CLIENT-232).
  // null means nothing was derived, so the effect below knows whether the
  // parent still has to be told.
  const [derivedCollapsedPaths] = useState<Set<string> | null>(() => {
    if (initialCollapsedPaths !== undefined) return null;
    if (defaultExpandDepth === undefined) return null;
    return new Set(getPathsAtDepth(value, defaultExpandDepth));
  });

  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(
    () => derivedCollapsedPaths ?? initialCollapsedPaths ?? new Set(),
  );

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

  // onCollapseChange is a parent callback, so it cannot fire while the state
  // above is being derived — announcing the derived set has to wait for commit.
  const announcedInitial = useRef(false);
  useEffect(() => {
    if (announcedInitial.current || derivedCollapsedPaths === null) return;
    announcedInitial.current = true;
    onCollapseChange?.(derivedCollapsedPaths);
  }, [derivedCollapsedPaths, onCollapseChange]);

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
    }),
    [collapsedPaths, isCollapsed, toggleCollapse, expandAll, collapseAll],
  );
}
