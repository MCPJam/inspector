import { useSyncExternalStore } from "react";
import type { CoffeeToolOutput } from "../types";

export function useToolOutput(): CoffeeToolOutput | undefined {
  return useSyncExternalStore(
    (onChange) => {
      const handleSetGlobals = (event: CustomEvent) => {
        if (event.detail?.globals) {
          onChange();
        }
      };

      window.addEventListener(
        "openai:set_globals",
        handleSetGlobals as EventListener,
        { passive: true }
      );

      return () => {
        window.removeEventListener(
          "openai:set_globals",
          handleSetGlobals as EventListener
        );
      };
    },
    () => window.openai?.toolOutput
  );
}
