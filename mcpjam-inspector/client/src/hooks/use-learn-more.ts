import { useState, useCallback, useRef } from "react";
import { learnMoreContent } from "@/lib/learn-more-content";

export function useLearnMore() {
  const [expandedTabId, setExpandedTabId] = useState<string | null>(null);
  const sourceRectRef = useRef<DOMRect | null>(null);

  const hasLearnMoreContent = useCallback((tabId: string): boolean => {
    return tabId in learnMoreContent;
  }, []);

  const openExpandedModal = useCallback(
    (tabId: string, rect?: DOMRect | null): void => {
      sourceRectRef.current = rect ?? null;
      setExpandedTabId(tabId);
    },
    [],
  );

  const closeExpandedModal = useCallback((): void => {
    setExpandedTabId(null);
    sourceRectRef.current = null;
  }, []);

  return {
    expandedTabId,
    sourceRect: sourceRectRef.current,
    hasLearnMoreContent,
    openExpandedModal,
    closeExpandedModal,
  };
}
