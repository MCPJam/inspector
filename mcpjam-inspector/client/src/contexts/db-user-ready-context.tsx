import { createContext, useContext, type ReactNode } from "react";

const DbUserReadyContext = createContext(false);

export function DbUserReadyProvider({
  children,
  isUserReady,
}: {
  children: ReactNode;
  isUserReady: boolean;
}) {
  return (
    <DbUserReadyContext.Provider value={isUserReady}>
      {children}
    </DbUserReadyContext.Provider>
  );
}

export function useDbUserReady() {
  return useContext(DbUserReadyContext);
}
