import { useEffect } from "react";

interface UseEscapeToStopChatOptions {
  enabled: boolean;
  onStop: () => void;
}

export function useEscapeToStopChat({
  enabled,
  onStop,
}: UseEscapeToStopChatOptions) {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.repeat) return;
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }

      event.preventDefault();
      onStop();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, onStop]);
}
