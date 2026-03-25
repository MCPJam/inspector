import { useEffect } from "react";
import type { Workspace } from "@/state/app-types";
import { buildDefaultWorkspaceClientConfig } from "@/lib/client-config";
import { useClientConfigStore } from "@/stores/client-config-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";

interface WorkspaceClientConfigSyncProps {
  activeWorkspaceId: string;
  savedClientConfig?: Workspace["clientConfig"];
}

export function WorkspaceClientConfigSync({
  activeWorkspaceId,
  savedClientConfig,
}: WorkspaceClientConfigSyncProps) {
  const themeMode = usePreferencesStore((state) => state.themeMode);
  const displayMode = useUIPlaygroundStore(
    (state) => state.globals.displayMode,
  );
  const locale = useUIPlaygroundStore((state) => state.globals.locale);
  const timeZone = useUIPlaygroundStore((state) => state.globals.timeZone);
  const hover = useUIPlaygroundStore((state) => state.capabilities.hover);
  const touch = useUIPlaygroundStore((state) => state.capabilities.touch);
  const safeAreaTop = useUIPlaygroundStore((state) => state.safeAreaInsets.top);
  const safeAreaRight = useUIPlaygroundStore(
    (state) => state.safeAreaInsets.right,
  );
  const safeAreaBottom = useUIPlaygroundStore(
    (state) => state.safeAreaInsets.bottom,
  );
  const safeAreaLeft = useUIPlaygroundStore(
    (state) => state.safeAreaInsets.left,
  );

  useEffect(() => {
    useClientConfigStore.getState().loadWorkspaceConfig({
      workspaceId: activeWorkspaceId,
      defaultConfig: buildDefaultWorkspaceClientConfig({
        theme: themeMode,
        displayMode,
        locale,
        timeZone,
        deviceCapabilities: { hover, touch },
        safeAreaInsets: {
          top: safeAreaTop,
          right: safeAreaRight,
          bottom: safeAreaBottom,
          left: safeAreaLeft,
        },
      }),
      savedConfig: savedClientConfig,
    });
  }, [
    activeWorkspaceId,
    savedClientConfig,
    themeMode,
    displayMode,
    locale,
    timeZone,
    hover,
    touch,
    safeAreaTop,
    safeAreaRight,
    safeAreaBottom,
    safeAreaLeft,
  ]);

  return null;
}
