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
import type { PreferencesState } from "@/stores/preferences/preferences-store";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import {
  seedFromHostTemplate,
  HOST_TEMPLATE_IDS,
  type HostTemplateId,
} from "@mcpjam/sdk/host-config/templates";
import { extractHostSafeAreaInsets } from "@/lib/client-config";

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
  const hostStyle = usePreferencesStore((state) => state.hostStyle);
  const safeAreaPreset = useUIPlaygroundStore((state) => state.safeAreaPreset);
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
      // The device presets are a phone simulator — notch, island, gesture bar
      // — and they win as soon as the user picks one. Until then the emulated
      // host should say what the real one says: Claude reports 12px on every
      // edge, most hosts omit the key entirely and resolve to zero. Seeding
      // from the store alone made every host look like Claude reports nothing.
      safeAreaInsets:
        safeAreaPreset === "none"
          ? hostTemplateSafeAreaInsets(hostStyle, themeMode)
          : {
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
    hostStyle,
    safeAreaPreset,
    safeAreaTop,
    safeAreaRight,
    safeAreaBottom,
    safeAreaLeft,
  ]);

  return null;
}

/**
 * The insets the selected host declares in its template `hostContext`.
 *
 * Falls back to zeros for a host that omits `safeAreaInsets` — which is most
 * of them, and is what a widget on those hosts effectively gets, since
 * `hostContext.safeAreaInsets` arrives `undefined` there. A template id the
 * SDK does not know also lands on zeros rather than throwing.
 */
function hostTemplateSafeAreaInsets(
  hostStyle: PreferencesState["hostStyle"],
  theme: PreferencesState["themeMode"],
) {
  // `ScenarioHostStyle` is wider than the seedable template ids, so narrow
  // against the SDK's own list rather than casting — an id with no template
  // resolves to zeros, same as a host that omits the key.
  const templateIds: readonly string[] = HOST_TEMPLATE_IDS;
  if (!templateIds.includes(hostStyle)) {
    return extractHostSafeAreaInsets(undefined);
  }
  const seeded = seedFromHostTemplate(hostStyle as HostTemplateId, {
    theme,
  }) as { hostContext?: Record<string, unknown> } | undefined;
  return extractHostSafeAreaInsets(seeded?.hostContext);
}
