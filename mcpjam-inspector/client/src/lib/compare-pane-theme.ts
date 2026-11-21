import { extractHostTheme } from "@/lib/client-config";
import type {
  PaneTheme,
  PaneThemePreference,
} from "@/stores/compare-pane-display-store";

export function resolveComparePaneTheme(
  appTheme: PaneTheme,
  preference: PaneThemePreference | undefined,
  hostContext: Record<string, unknown> | undefined,
  isUneditedStarterClient?: boolean,
) {
  const clientTheme = isUneditedStarterClient
    ? undefined
    : extractHostTheme(hostContext);
  const choice =
    preference === "client" && !clientTheme
      ? "app"
      : preference ?? (clientTheme ? "client" : "app");
  const theme =
    choice === "app"
      ? appTheme
      : choice === "client"
        ? (clientTheme ?? appTheme)
        : choice;
  return { choice, theme, clientTheme };
}
