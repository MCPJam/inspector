import { Moon, Sun } from "lucide-react";

import { SidebarMenuButton } from "@/components/ui/sidebar";
import { updateThemeMode } from "@/lib/theme-utils";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

export function ThemeSwitcher() {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const setThemeMode = usePreferencesStore((s) => s.setThemeMode);

  const handleValueChange = () => {
    const newTheme = themeMode === "dark" ? "light" : "dark";
    updateThemeMode(newTheme);
    setThemeMode(newTheme);
  };

  return (
    <SidebarMenuButton
      tooltip={`Switch to ${themeMode === "dark" ? "light" : "dark"} mode`}
      onClick={handleValueChange}
      className="cursor-pointer"
    >
      {themeMode === "dark" ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
      <span>{themeMode === "dark" ? "Light mode" : "Dark mode"}</span>
    </SidebarMenuButton>
  );
}
