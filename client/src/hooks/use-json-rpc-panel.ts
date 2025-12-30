import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "mcpjam-inspector-jsonrpc-panel-visible";

export function useJsonRpcPanelVisibility() {
  const [isVisible, setIsVisible] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? true : stored === "true";
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(isVisible));
  }, [isVisible]);

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
