import { createContext, useContext } from "react";
import type { PaneDisplay } from "@/stores/compare-pane-display-store";

const PaneDisplayContext = createContext<PaneDisplay | null>(null);

/** A Compare pane's Device and Theme, read by the Apps it renders. */
export const PaneDisplayProvider = PaneDisplayContext.Provider;

export function usePaneDisplay(): PaneDisplay | null {
  return useContext(PaneDisplayContext);
}
