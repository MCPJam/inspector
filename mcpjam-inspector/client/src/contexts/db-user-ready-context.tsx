import { createContext, useContext, useEffect, type ReactNode } from "react";

import { useSessionRefreshStore } from "@/stores/session-refresh-store";

type DbUserReadyContextValue = {
  isEnsuringUser: boolean;
  isUserReady: boolean;
};

const DbUserReadyContext = createContext<DbUserReadyContextValue>({
  isEnsuringUser: false,
  isUserReady: false,
});

export function DbUserReadyProvider({
  children,
  isEnsuringUser = false,
  isUserReady,
}: {
  children: ReactNode;
  isEnsuringUser?: boolean;
  isUserReady: boolean;
}) {
  const queriesPaused = useSessionRefreshStore((state) => state.queriesPaused);
  const authConfirmed = useSessionRefreshStore((state) => state.authConfirmed);
  useEffect(() => {
    // The current connection must confirm auth AND finish user setup. A stale
    // readiness value or a token fetch alone must never reopen subscriptions.
    if (isUserReady && authConfirmed) {
      useSessionRefreshStore.getState().resumeQueries();
    }
  }, [isUserReady, authConfirmed]);
  return (
    <DbUserReadyContext.Provider
      value={{ isEnsuringUser, isUserReady: isUserReady && !queriesPaused }}
    >
      {children}
    </DbUserReadyContext.Provider>
  );
}

export function useDbUserReady() {
  return useContext(DbUserReadyContext).isUserReady;
}

export function useDbUserBootstrapStatus() {
  return useContext(DbUserReadyContext);
}
