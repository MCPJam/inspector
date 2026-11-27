import { useEffect } from "react";
import { usePostHog } from "posthog-js/react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import type { ThemeMode, ThemePreference } from "@/types/preferences/theme";

/**
 * Registers the app theme as PostHog super properties, so every event says
 * which theme the user sees. `theme_mode` is the resolved light/dark mode;
 * `theme_preference` is the Settings choice, which can also be "system".
 */
export function usePostHogThemeContext(
  themeMode: ThemeMode,
  themePreference: ThemePreference,
) {
  const posthog = usePostHog();

  useEffect(() => {
    if (!posthog) return;
    posthog.register({
      theme_mode: themeMode,
      theme_preference: themePreference,
    });
  }, [posthog, themeMode, themePreference]);
}

/** Renders nothing; must sit inside `PreferencesStoreProvider`. */
export function PostHogThemeContext() {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const themePreference = usePreferencesStore((s) => s.themePreference);
  usePostHogThemeContext(themeMode, themePreference);
  return null;
}
