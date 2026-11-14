import { createContext, useContext, useState } from "react";

/** Only widget lifetimes follow a conflict continuation; history keeps its row id. */
export const AppSessionScopeContext = createContext<string | undefined>(
  undefined,
);

export function useAppSessionScope(chatSessionId?: string) {
  return useContext(AppSessionScopeContext) ?? chatSessionId;
}

/** A fork keeps its mount. Reopening its source starts fresh even though the scope matches. */
export function useAppSessionReopenKey(
  sessionId: string | null | undefined,
  scope: string | null | undefined,
) {
  const [previous, setPrevious] = useState({ sessionId, scope, key: 0 });
  if (sessionId === previous.sessionId && scope === previous.scope) {
    return previous.key;
  }
  const reopensSource = scope === previous.scope && sessionId === scope;
  const key = reopensSource ? previous.key + 1 : previous.key;
  setPrevious({ sessionId, scope, key });
  return key;
}
