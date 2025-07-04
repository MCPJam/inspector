import { useCallback, useEffect, useMemo } from "react";
import { useUserPreferencesDatabase } from "../../hooks/useUserPreferencesDatabase";

type Theme = "light" | "dark" | "system";

const useTheme = (): [Theme, (mode: Theme) => void] => {
  const { preferences, setTheme: setThemeInDb } = useUserPreferencesDatabase();
  const theme = preferences.theme;

  useEffect(() => {
    const darkModeMediaQuery = window.matchMedia(
      "(prefers-color-scheme: dark)",
    );
    const handleDarkModeChange = (e: MediaQueryListEvent) => {
      if (theme === "system") {
        updateDocumentTheme(e.matches ? "dark" : "light");
      }
    };

    const updateDocumentTheme = (newTheme: "light" | "dark") => {
      document.documentElement.classList.toggle("dark", newTheme === "dark");
    };

    // Set initial theme based on current mode
    if (theme === "system") {
      updateDocumentTheme(darkModeMediaQuery.matches ? "dark" : "light");
    } else {
      updateDocumentTheme(theme);
    }

    darkModeMediaQuery.addEventListener("change", handleDarkModeChange);

    return () => {
      darkModeMediaQuery.removeEventListener("change", handleDarkModeChange);
    };
  }, [theme]);

  const setThemeWithSideEffect = useCallback((newTheme: Theme) => {
    void setThemeInDb(newTheme);
    if (newTheme === "system") {
      const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.classList.toggle("dark", isDark);
    } else {
      document.documentElement.classList.toggle("dark", newTheme === "dark");
    }
  }, [setThemeInDb]);
  return useMemo(
    () => [theme, setThemeWithSideEffect],
    [theme, setThemeWithSideEffect],
  );
};

export default useTheme;
