import { useEffect } from "react";
import type { Project } from "@/state/app-types";
import {
  buildDefaultProjectConnectionConfig,
  buildDefaultProjectHostContext,
  pickProjectConnectionConfig,
  pickProjectHostContext,
} from "@/lib/client-config";
import { useClientConfigStore } from "@/stores/client-config-store";
import { useHostContextStore } from "@/stores/client-context-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";

interface ProjectClientConfigSyncProps {
  activeProjectId: string;
  savedClientConfig?: Project["clientConfig"];
}

export function ProjectClientConfigSync({
  activeProjectId,
  savedClientConfig,
}: ProjectClientConfigSyncProps) {
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
    const defaultConnectionConfig = buildDefaultProjectConnectionConfig();
    const defaultHostContext = buildDefaultProjectHostContext({
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
    });

    useClientConfigStore.getState().loadProjectConfig({
      projectId: activeProjectId,
      defaultConfig: defaultConnectionConfig,
      savedConfig: savedClientConfig
        ? pickProjectConnectionConfig(savedClientConfig)
        : undefined,
    });
    useHostContextStore.getState().loadProjectHostContext({
      projectId: activeProjectId,
      defaultHostContext,
      savedHostContext: savedClientConfig
        ? pickProjectHostContext(savedClientConfig)
        : undefined,
    });
  }, [
    activeProjectId,
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
