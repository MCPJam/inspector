import type { ReactNode } from "react";
import { usePreferencesStoreWithDefaults } from "@/stores/preferences/preferences-provider";
import type {
  PluginIconRef,
  PluginIcons,
} from "@/lib/plugins/plugin-api-types";
import {
  PluginIconImage,
  pluginIconRefs,
  type PluginIconKind,
} from "./plugin-icon-image";

/**
 * Pick a plugin icon (OpenAI's plugin design guidance):
 * - `directory` (plugin lists and cards): the theme's variant of
 *   `logo`/`logoDark`, else the other variant.
 * - `composer` (chips naming the plugin): `composerIcon`, else the
 *   directory icon.
 */
export function selectPluginIcon(
  icons: PluginIcons | undefined,
  kind: PluginIconKind,
  theme: "light" | "dark",
): PluginIconRef | undefined {
  return pluginIconRefs(icons, kind, theme)[0];
}

export function PluginIcon({
  icons,
  kind = "directory",
  className,
  fallback,
}: {
  icons: PluginIcons | undefined;
  kind?: PluginIconKind;
  className?: string;
  /** Rendered while loading, without icons, or when every icon fails. */
  fallback: ReactNode;
}) {
  const themeMode = usePreferencesStoreWithDefaults((state) => state.themeMode);
  return (
    <PluginIconImage
      refs={pluginIconRefs(
        icons,
        kind,
        themeMode === "dark" ? "dark" : "light",
      )}
      className={className}
      fallback={fallback}
    />
  );
}
