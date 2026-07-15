import { createContext, useContext, type ReactNode } from "react";

const WidgetSurfaceHostContext = createContext(false);

export function WidgetSurfaceHostProvider({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <WidgetSurfaceHostContext.Provider value={true}>
      {children}
    </WidgetSurfaceHostContext.Provider>
  );
}

export function usePersistentWidgetSurfaceHost() {
  return useContext(WidgetSurfaceHostContext);
}
