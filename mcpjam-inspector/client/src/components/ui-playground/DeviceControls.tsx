/**
 * DeviceControls
 *
 * Device emulation and theme controls for the UI Playground
 */

import { Smartphone, Tablet, Monitor, Sun, Moon } from "lucide-react";
import { Button } from "../ui/button";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import type { DeviceType } from "@/stores/ui-playground-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { updateThemeMode } from "@/lib/theme-utils";

interface DeviceControlsProps {
  deviceType: DeviceType;
  onDeviceTypeChange: (type: DeviceType) => void;
}

export function DeviceControls({
  deviceType,
  onDeviceTypeChange,
}: DeviceControlsProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const setThemeMode = usePreferencesStore((s) => s.setThemeMode);

  const handleThemeChange = () => {
    const newTheme = themeMode === "dark" ? "light" : "dark";
    updateThemeMode(newTheme);
    setThemeMode(newTheme);
  };

  return (
    <div className="px-4 py-3 border-t border-border bg-background flex-shrink-0">
      <div className="flex items-center justify-center gap-3">
        {/* Device Type */}
        <ToggleGroup
          type="single"
          value={deviceType}
          onValueChange={(v) => v && onDeviceTypeChange(v as DeviceType)}
          className="gap-0.5"
        >
          <ToggleGroupItem
            value="mobile"
            aria-label="Mobile"
            title="Mobile (430×932)"
            className="h-8 w-8 p-0"
          >
            <Smartphone className="h-4 w-4" />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="tablet"
            aria-label="Tablet"
            title="Tablet (820×1180)"
            className="h-8 w-8 p-0"
          >
            <Tablet className="h-4 w-4" />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="desktop"
            aria-label="Desktop"
            title="Desktop (1280×800)"
            className="h-8 w-8 p-0"
          >
            <Monitor className="h-4 w-4" />
          </ToggleGroupItem>
        </ToggleGroup>

        <div className="w-px h-5 bg-border" aria-hidden="true" />

        {/* Theme Toggle */}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleThemeChange}
          className="h-8 w-8 p-0"
          title={`Switch to ${themeMode === "dark" ? "light" : "dark"} mode`}
        >
          {themeMode === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
