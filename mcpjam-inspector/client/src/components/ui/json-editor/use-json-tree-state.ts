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

// Whether a container holds anything, without materializing its entries.
function hasEntry(value: object): boolean {
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  }
  return false;
}

// Walks iteratively rather than recursively: deeply nested values overflowed
// the call stack (INSPECTOR-CLIENT-232).
function getPathsAtDepth(value: unknown, requestedDepth: number): string[] {
  // Clamped so the cap always lands on or past the expand depth: otherwise a
  // requested depth beyond the cap collapses nothing and the whole deep value
  // renders expanded, which is the crash this walk exists to avoid.
  const maxDepth = Math.min(requestedDepth, MAX_COLLAPSE_SCAN_DEPTH);
  const paths: string[] = [];
  const stack: Array<{ value: unknown; path: string; depth: number }> = [
    { value, path: "root", depth: 0 },
  ];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (typeof node.value !== "object" || node.value === null) continue;

    // At the cap the children are never visited, so only collapsibility is
    // still in question — answer it without enumerating a wide container.
    if (node.depth >= MAX_COLLAPSE_SCAN_DEPTH) {
      if (node.depth >= maxDepth && hasEntry(node.value)) {
        paths.push(node.path);
      }
      continue;
    }

    // Object.entries covers arrays too, and yields only populated indexes: a
    // sparse array costs nothing per hole, where mapping over one allocates a
    // tuple per hole (and holes cannot be destructured in the loop below).
    const entries: Array<[string, unknown]> = Object.entries(node.value);
    if (entries.length === 0) continue;

    if (node.depth >= maxDepth) {
      paths.push(node.path);
    }

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
