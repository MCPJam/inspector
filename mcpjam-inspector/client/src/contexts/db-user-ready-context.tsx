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
  useEffect(() => {
    // Bootstrap readiness becomes true only after Convex confirms the identity
    // and its database user is ready. Token retrieval alone cannot release the
    // pause. Do not depend on queriesPaused: the old readiness may still be
    // true when the token fetcher pauses queries before Convex drops auth.
    if (isUserReady) useSessionRefreshStore.getState().resumeQueries();
  }, [isUserReady]);
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
