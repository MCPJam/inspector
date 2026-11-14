import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { listAppToolCatalog, useAppToolsRegistry } from "@mcpjam/widget-react";
import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";
import { deriveAppPaneTools } from "./app-pane-tools";

export function useAppPaneTools() {
  const { appSessionScopeId, compareActive } = useActiveChatSessionStore(
    useShallow((state) => ({
      appSessionScopeId: state.appSessionScopeId,
      compareActive: state.compareActive,
    })),
  );
  const state = useAppToolsRegistry(
    useShallow((state) => ({
      aliases: state.aliases,
      instancesByBridgeId: state.instancesByBridgeId,
      activeBridgeByParent: state.activeBridgeByParent,
      enabled: state.enabled,
    })),
  );
  return useMemo(
    () =>
      deriveAppPaneTools(
        listAppToolCatalog(state, compareActive ? null : appSessionScopeId),
      ),
    [state, appSessionScopeId, compareActive],
  );
}
