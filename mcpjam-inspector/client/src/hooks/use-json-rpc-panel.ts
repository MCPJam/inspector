import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "mcpjam-inspector-jsonrpc-panel-visible";
const MOBILE_BREAKPOINT = 768;

export function useJsonRpcPanelVisibility({
  useDesktopPreference = false,
  storageKey = STORAGE_KEY,
  defaultVisible = true,
}: {
  useDesktopPreference?: boolean;
  storageKey?: string;
  defaultVisible?: boolean;
} = {}) {
  const [isVisible, setIsVisible] = useState(() => {
    if (typeof window === "undefined") return defaultVisible;
    // Default to closed on narrow viewports (phones)
    if (!useDesktopPreference && window.innerWidth < MOBILE_BREAKPOINT)
      return false;
    const stored = localStorage.getItem(storageKey);
    return stored === null ? defaultVisible : stored === "true";
  });

  useEffect(() => {
    // Only persist preference on non-mobile so phone doesn't overwrite desktop setting
    if (
      typeof window !== "undefined" &&
      window.innerWidth >= MOBILE_BREAKPOINT
    ) {
      localStorage.setItem(storageKey, String(isVisible));
    }
  }, [isVisible, storageKey]);

  const toggle = useCallback(() => {
    setIsVisible((prev) => !prev);
  }, []);

  const show = useCallback(() => {
    setIsVisible(true);
  }, []);

  const hide = useCallback(() => {
    setIsVisible(false);
  }, []);

  return { isVisible, toggle, show, hide };
}
