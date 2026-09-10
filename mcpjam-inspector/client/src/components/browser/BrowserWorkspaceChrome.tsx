import { createContext } from "react";

/** The comparison workspace owns the strip; the selected body owns navigation. */
export const BrowserWorkspaceChrome = createContext<{
  clientName?: string;
} | null>(null);
