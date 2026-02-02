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

function getPathsAtDepth(
  value: unknown,
  maxDepth: number,
  currentPath = "root",
  currentDepth = 0,
): string[] {
  const paths: string[] = [];

  if (currentDepth >= maxDepth) {
    if (
      (typeof value === "object" &&
        value !== null &&
        Object.keys(value).length > 0) ||
      (Array.isArray(value) && value.length > 0)
    ) {
      paths.push(currentPath);
    }
  }

  if (typeof value === "object" && value !== null) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        paths.push(
          ...getPathsAtDepth(
            item,
            maxDepth,
            `${currentPath}.${index}`,
            currentDepth + 1,
          ),
        );
      });
    } else {
      Object.entries(value).forEach(([key, val]) => {
        paths.push(
          ...getPathsAtDepth(
            val,
            maxDepth,
            `${currentPath}.${key}`,
            currentDepth + 1,
          ),
        );
      });
    }
  }

  return paths;
}

function getAllPaths(value: unknown, currentPath = "root"): string[] {
  const paths: string[] = [];

  if (typeof value === "object" && value !== null) {
    if (Array.isArray(value)) {
      if (value.length > 0) {
        paths.push(currentPath);
        value.forEach((item, index) => {
          paths.push(...getAllPaths(item, `${currentPath}.${index}`));
        });
      }
    } else {
      const keys = Object.keys(value);
      if (keys.length > 0) {
        paths.push(currentPath);
        Object.entries(value).forEach(([key, val]) => {
          paths.push(...getAllPaths(val, `${currentPath}.${key}`));
        });
      }
    }
  }

  return paths;
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
