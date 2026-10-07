import { createContext, useContext, type ReactNode } from "react";
import { WidgetWorkspaceContext } from "./widget-workspace-context";

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
  const legacy = useContext(WidgetSurfaceHostContext);
  const workspace = useContext(WidgetWorkspaceContext);
  return legacy || workspace !== null;
}
