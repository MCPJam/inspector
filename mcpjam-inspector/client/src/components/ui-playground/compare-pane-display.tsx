import { Maximize2, Moon, Ruler, Sun } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import { PRESET_DEVICE_CONFIGS } from "@/components/shared/client-context-constants";
import type { PaneTheme } from "@/stores/compare-pane-display-store";
import type { DeviceType } from "@/stores/ui-playground-store";
import { ComparePaneSettingsSection } from "./compare-pane-settings";

type PresetDevice = keyof typeof PRESET_DEVICE_CONFIGS;
const PRESET_DEVICES = Object.keys(PRESET_DEVICE_CONFIGS) as PresetDevice[];

export function paneDeviceLabel(device: DeviceType): string {
  if (device === "fill") return "Fill";
  if (device === "custom") return "Custom";
  return PRESET_DEVICE_CONFIGS[device].label;
}

/** The pane's width when its device is a preset. */
export function paneDeviceWidth(device: DeviceType | undefined) {
  return device && device !== "fill" && device !== "custom"
    ? PRESET_DEVICE_CONFIGS[device].width
    : undefined;
}

/** A pane's Device and Theme, in its settings. */
export function ComparePaneDisplay({
  label,
  device,
  theme,
  onDeviceChange,
  onThemeChange,
}: {
  label: string;
  device: DeviceType;
  theme: PaneTheme;
  onDeviceChange: (device: DeviceType) => void;
  onThemeChange: (theme: PaneTheme) => void;
}) {
  return (
    <ComparePaneSettingsSection title="Display">
      <div className="flex items-center gap-2">
        <Select
          value={device}
          onValueChange={(value) => onDeviceChange(value as DeviceType)}
        >
          <SelectTrigger
            size="sm"
            className="flex-1"
            aria-label={`Device for ${label}`}
            data-testid="compare-pane-device"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fill">
              <Maximize2 className="size-3.5" />
              Fill
            </SelectItem>
            {PRESET_DEVICES.map((key) => {
              const config = PRESET_DEVICE_CONFIGS[key];
              const Icon = config.icon;
              return (
                <SelectItem key={key} value={key}>
                  <Icon className="size-3.5" />
                  {config.label}
                  <span className="text-[10px] text-muted-foreground">
                    {config.width}x{config.height}
                  </span>
                </SelectItem>
              );
            })}
            {device === "custom" ? (
              <SelectItem value="custom">
                <Ruler className="size-3.5" />
                Custom
              </SelectItem>
            ) : null}
          </SelectContent>
        </Select>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={theme}
          onValueChange={(value) => {
            if (value) onThemeChange(value as PaneTheme);
          }}
          aria-label={`Theme for ${label}`}
        >
          <ToggleGroupItem value="light" aria-label="Light">
            <Sun className="size-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem value="dark" aria-label="Dark">
            <Moon className="size-3.5" />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </ComparePaneSettingsSection>
  );
}
