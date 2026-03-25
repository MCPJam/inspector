import { useState, useCallback, useRef } from "react";
import { learnMoreContent } from "@/lib/learn-more-content";

const STORAGE_PREFIX = "mcpjam_tab_learned_";
const DEV_OVERRIDE = import.meta.env.VITE_DEV_LEARN_MORE === "1";

function getStorageKey(tabId: string): string {
  return `${STORAGE_PREFIX}${tabId}`;
}

export function useLearnMore() {
  const [expandedTabId, setExpandedTabId] = useState<string | null>(null);
  const sourceRectRef = useRef<DOMRect | null>(null);
  // Track visited state in React so hover cards react to changes within the session
  const [visitedTabs, setVisitedTabs] = useState<Record<string, boolean>>(() => {
    if (DEV_OVERRIDE) return {};
    const initial: Record<string, boolean> = {};
    for (const tabId of Object.keys(learnMoreContent)) {
      initial[tabId] = localStorage.getItem(getStorageKey(tabId)) === "true";
    }
    return initial;
  });

  const hasVisitedTab = useCallback(
    (tabId: string): boolean => {
      if (DEV_OVERRIDE) return false;
      return visitedTabs[tabId] ?? false;
    },
    [visitedTabs],
  );

  const markTabVisited = useCallback((tabId: string): void => {
    if (DEV_OVERRIDE) return;
    localStorage.setItem(getStorageKey(tabId), "true");
    setVisitedTabs((prev) => ({ ...prev, [tabId]: true }));
  }, []);

  const hasLearnMoreContent = useCallback((tabId: string): boolean => {
    return tabId in learnMoreContent;
  }, []);

  const shouldAutoShowModal = useCallback(
    (tabId: string): boolean => {
      return hasLearnMoreContent(tabId) && !hasVisitedTab(tabId);
    },
    [hasLearnMoreContent, hasVisitedTab],
  );

  const openExpandedModal = useCallback((tabId: string, rect?: DOMRect | null): void => {
    sourceRectRef.current = rect ?? null;
    setExpandedTabId(tabId);
  }, []);

  const closeExpandedModal = useCallback((): void => {
    setExpandedTabId(null);
    sourceRectRef.current = null;
  }, []);

  return {
    expandedTabId,
    sourceRect: sourceRectRef.current,
    hasVisitedTab,
    markTabVisited,
    hasLearnMoreContent,
    shouldAutoShowModal,
    openExpandedModal,
    closeExpandedModal,
  };
}
