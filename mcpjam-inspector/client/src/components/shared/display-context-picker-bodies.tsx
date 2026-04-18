/**
 * Shared picker bodies for DisplayContextHeader (inline popovers + compact panel).
 */

import { Settings2 } from "lucide-react";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  PRESET_DEVICE_CONFIGS,
  LOCALE_OPTIONS,
  TIMEZONE_OPTIONS,
  CSP_MODE_OPTIONS,
} from "@/components/shared/display-context-constants";
import type {
  CustomViewport,
  CspMode,
  DeviceType,
} from "@/stores/ui-playground-store";

type PresetEntry = [
  Exclude<DeviceType, "custom">,
  (typeof PRESET_DEVICE_CONFIGS)[Exclude<DeviceType, "custom">],
];

export function DevicePickerBody({
  deviceType,
  setDeviceType,
  customViewport,
  setCustomViewport,
  widthInputId,
  heightInputId,
  onPickPreset,
}: {
  deviceType: DeviceType;
  setDeviceType: (t: DeviceType) => void;
  customViewport: CustomViewport;
  setCustomViewport: (v: Partial<CustomViewport>) => void;
  widthInputId: string;
  heightInputId: string;
  onPickPreset?: () => void;
}) {
  return (
    <div className="space-y-2">
      {(Object.entries(PRESET_DEVICE_CONFIGS) as PresetEntry[]).map(
        ([type, config]) => {
          const Icon = config.icon;
          const isSelected = deviceType === type;
          return (
            <button
              key={type}
              type="button"
              onClick={() => {
                setDeviceType(type);
                onPickPreset?.();
              }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors hover:bg-accent ${
                isSelected ? "bg-accent text-accent-foreground" : ""
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{config.label}</span>
              <span className="ml-auto text-[10px] text-muted-foreground">
                {config.width}×{config.height}
              </span>
            </button>
          );
        },
      )}

      <button
        type="button"
        onClick={() => setDeviceType("custom")}
        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors hover:bg-accent ${
          deviceType === "custom" ? "bg-accent text-accent-foreground" : ""
        }`}
      >
        <Settings2 className="h-3.5 w-3.5" />
        <span>Custom</span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {customViewport.width}×{customViewport.height}
        </span>
      </button>

      {deviceType === "custom" && (
        <div className="grid grid-cols-2 gap-2 pt-1">
          <div className="space-y-1">
            <Label
              htmlFor={widthInputId}
              className="text-[10px] text-muted-foreground"
            >
              Width
            </Label>
            <Input
              id={widthInputId}
              type="number"
              min={100}
              max={2560}
              defaultValue={customViewport.width}
              key={`${widthInputId}-w-${customViewport.width}`}
              onBlur={(e) => {
                const val = parseInt(e.target.value) || 100;
                setCustomViewport({
                  width: Math.max(100, Math.min(2560, val)),
                });
              }}
              className="h-7 text-xs [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
          <div className="space-y-1">
            <Label
              htmlFor={heightInputId}
              className="text-[10px] text-muted-foreground"
            >
              Height
            </Label>
            <Input
              id={heightInputId}
              type="number"
              min={100}
              max={2560}
              defaultValue={customViewport.height}
              key={`${heightInputId}-h-${customViewport.height}`}
              onBlur={(e) => {
                const val = parseInt(e.target.value) || 100;
                setCustomViewport({
                  height: Math.max(100, Math.min(2560, val)),
                });
              }}
              className="h-7 text-xs [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}

export function LocalePickerBody({
  locale,
  patchHostContext,
  onSelectLocale,
}: {
  locale: string;
  patchHostContext: (p: { locale: string }) => void;
  onSelectLocale?: () => void;
}) {
  return (
    <div className="space-y-1">
      {LOCALE_OPTIONS.map((option) => (
        <button
          key={option.code}
          type="button"
          onClick={() => {
            patchHostContext({ locale: option.code });
            onSelectLocale?.();
          }}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors hover:bg-accent ${
            locale === option.code ? "bg-accent text-accent-foreground" : ""
          }`}
        >
          <span>{option.label}</span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {option.code}
          </span>
        </button>
      ))}
    </div>
  );
}

export function TimezonePickerBody({
  timeZone,
  patchHostContext,
  onSelectZone,
}: {
  timeZone: string;
  patchHostContext: (p: { timeZone: string }) => void;
  onSelectZone?: () => void;
}) {
  return (
    <div className="space-y-1">
      {TIMEZONE_OPTIONS.map((option) => (
        <button
          key={option.zone}
          type="button"
          onClick={() => {
            patchHostContext({ timeZone: option.zone });
            onSelectZone?.();
          }}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors hover:bg-accent ${
            timeZone === option.zone ? "bg-accent text-accent-foreground" : ""
          }`}
        >
          <span>{option.label}</span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {option.offset}
          </span>
        </button>
      ))}
    </div>
  );
}

export function CspPickerBody({
  activeCspMode,
  setActiveCspMode,
  onSelectMode,
}: {
  activeCspMode: CspMode;
  setActiveCspMode: (m: CspMode) => void;
  onSelectMode?: () => void;
}) {
  return (
    <div className="space-y-1">
      {CSP_MODE_OPTIONS.map((option) => (
        <button
          key={option.mode}
          type="button"
          onClick={() => {
            setActiveCspMode(option.mode);
            onSelectMode?.();
          }}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors hover:bg-accent ${
            activeCspMode === option.mode
              ? "bg-accent text-accent-foreground"
              : ""
          }`}
        >
          <span className="font-medium">{option.label}</span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {option.description}
          </span>
        </button>
      ))}
    </div>
  );
}
