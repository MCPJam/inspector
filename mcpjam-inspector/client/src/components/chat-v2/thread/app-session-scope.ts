import { createContext, useContext } from "react";

/** Only widget lifetimes follow a conflict continuation; history keeps its row id. */
export const AppSessionScopeContext = createContext<string | undefined>(undefined);

export function useAppSessionScope(chatSessionId?: string) {
  return useContext(AppSessionScopeContext) ?? chatSessionId;
}
