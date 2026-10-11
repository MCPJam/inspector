import { createContext, useContext, type ReactNode } from "react";

const WidgetPresentation = createContext<"live" | "placeholder">("live");

/** Scope only the transcript: the workspace owns the one live app surface. */
export function StaticWidgetTranscript({ children }: { children: ReactNode }) {
  return (
    <WidgetPresentation.Provider value="placeholder">
      {children}
    </WidgetPresentation.Provider>
  );
}

export function useWidgetPresentation() {
  return useContext(WidgetPresentation);
}
