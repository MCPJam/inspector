/**
 * DisplayContextHeader
 *
 * Reusable component for display context controls (device, locale, timezone, CSP, capabilities, safe area).
 * Extracted from PlaygroundMain to be shared between App Builder and Views pages.
 *
 * Reads/writes to useUIPlaygroundStore for state management.
 */

import { useState, useMemo, useCallback } from "react";
import {
  Smartphone,
  Tablet,
  Monitor,
  Sun,
  Moon,
  Globe,
  Clock,
  Shield,
  MousePointer2,
  Hand,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useUIPlaygroundStore,
  DEVICE_VIEWPORT_CONFIGS,
  type DeviceType,
  type CspMode,
} from "@/stores/ui-playground-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { updateThemeMode } from "@/lib/theme-utils";
import { SafeAreaEditor } from "@/components/ui-playground/SafeAreaEditor";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";

/** Device frame configurations - extends shared viewport config with UI properties */
export const PRESET_DEVICE_CONFIGS: Record<
  Exclude<DeviceType, "custom">,
  { width: number; height: number; label: string; icon: typeof Smartphone }
> = {
  mobile: {
    ...DEVICE_VIEWPORT_CONFIGS.mobile,
    label: "Phone",
    icon: Smartphone,
  },
  tablet: { ...DEVICE_VIEWPORT_CONFIGS.tablet, label: "Tablet", icon: Tablet },
  desktop: {
    ...DEVICE_VIEWPORT_CONFIGS.desktop,
    label: "Desktop",
    icon: Monitor,
  },
};

/** Custom device config - dimensions come from store */
const CUSTOM_DEVICE_BASE = {
  label: "Custom",
  icon: Settings2,
};

/** Common BCP 47 locales for testing (per OpenAI Apps SDK spec) */
export const LOCALE_OPTIONS = [
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "es-ES", label: "Español" },
  { code: "es-MX", label: "Español (MX)" },
  { code: "fr-FR", label: "Français" },
  { code: "de-DE", label: "Deutsch" },
  { code: "it-IT", label: "Italiano" },
  { code: "pt-BR", label: "Português (BR)" },
  { code: "ja-JP", label: "日本語" },
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "ko-KR", label: "한국어" },
  { code: "ar-SA", label: "العربية" },
  { code: "hi-IN", label: "हिन्दी" },
  { code: "ru-RU", label: "Русский" },
  { code: "nl-NL", label: "Nederlands" },
];

/** Common IANA timezones for testing (per SEP-1865 MCP Apps spec) */
export const TIMEZONE_OPTIONS = [
  { zone: "America/New_York", label: "New York", offset: "UTC-5/-4" },
  { zone: "America/Chicago", label: "Chicago", offset: "UTC-6/-5" },
  { zone: "America/Denver", label: "Denver", offset: "UTC-7/-6" },
  { zone: "America/Los_Angeles", label: "Los Angeles", offset: "UTC-8/-7" },
  { zone: "America/Sao_Paulo", label: "São Paulo", offset: "UTC-3" },
  { zone: "America/Mexico_City", label: "Mexico City", offset: "UTC-6/-5" },
  { zone: "Europe/London", label: "London", offset: "UTC+0/+1" },
  { zone: "Europe/Paris", label: "Paris", offset: "UTC+1/+2" },
  { zone: "Europe/Berlin", label: "Berlin", offset: "UTC+1/+2" },
  { zone: "Europe/Moscow", label: "Moscow", offset: "UTC+3" },
  { zone: "Asia/Dubai", label: "Dubai", offset: "UTC+4" },
  { zone: "Asia/Kolkata", label: "Mumbai", offset: "UTC+5:30" },
  { zone: "Asia/Singapore", label: "Singapore", offset: "UTC+8" },
  { zone: "Asia/Shanghai", label: "Shanghai", offset: "UTC+8" },
  { zone: "Asia/Tokyo", label: "Tokyo", offset: "UTC+9" },
  { zone: "Asia/Seoul", label: "Seoul", offset: "UTC+9" },
  { zone: "Australia/Sydney", label: "Sydney", offset: "UTC+10/+11" },
  { zone: "Pacific/Auckland", label: "Auckland", offset: "UTC+12/+13" },
  { zone: "UTC", label: "UTC", offset: "UTC+0" },
];

/** CSP mode options for widget sandbox */
export const CSP_MODE_OPTIONS: {
  mode: CspMode;
  label: string;
  description: string;
}[] = [
  {
    mode: "permissive",
    label: "Permissive",
    description: "Allows all HTTPS resources",
  },
  {
    mode: "widget-declared",
    label: "Strict",
    description: "Only widget-declared domains",
  },
];

export interface DisplayContextHeaderProps {
  /** Protocol for showing appropriate controls (null shows OpenAI/ChatGPT controls) */
  protocol: UIType | null;
  /** Optional: show theme toggle (default: false) */
  showThemeToggle?: boolean;
  /** Optional: custom class name */
  className?: string;
}

export function DisplayContextHeader({
  protocol,
  showThemeToggle = false,
  className,
}: DisplayContextHeaderProps) {
  // Popover states
  const [devicePopoverOpen, setDevicePopoverOpen] = useState(false);
  const [localePopoverOpen, setLocalePopoverOpen] = useState(false);
  const [cspPopoverOpen, setCspPopoverOpen] = useState(false);
  const [timezonePopoverOpen, setTimezonePopoverOpen] = useState(false);

  // Store state
  const deviceType = useUIPlaygroundStore((s) => s.deviceType);
  const setDeviceType = useUIPlaygroundStore((s) => s.setDeviceType);
  const customViewport = useUIPlaygroundStore((s) => s.customViewport);
  const setCustomViewport = useUIPlaygroundStore((s) => s.setCustomViewport);
  const globals = useUIPlaygroundStore((s) => s.globals);
  const updateGlobal = useUIPlaygroundStore((s) => s.updateGlobal);
  const capabilities = useUIPlaygroundStore((s) => s.capabilities);
  const setCapabilities = useUIPlaygroundStore((s) => s.setCapabilities);

  // CSP mode (ChatGPT Apps)
  const cspMode = useUIPlaygroundStore((s) => s.cspMode);
  const setCspMode = useUIPlaygroundStore((s) => s.setCspMode);

  // CSP mode for MCP Apps (SEP-1865)
  const mcpAppsCspMode = useUIPlaygroundStore((s) => s.mcpAppsCspMode);
  const setMcpAppsCspMode = useUIPlaygroundStore((s) => s.setMcpAppsCspMode);

  // Protocol-aware CSP mode
  const activeCspMode = protocol === UIType.MCP_APPS ? mcpAppsCspMode : cspMode;
  const setActiveCspMode =
    protocol === UIType.MCP_APPS ? setMcpAppsCspMode : setCspMode;

  // Theme handling
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const setThemeMode = usePreferencesStore((s) => s.setThemeMode);

  const handleThemeChange = useCallback(() => {
    const newTheme = themeMode === "dark" ? "light" : "dark";
    updateThemeMode(newTheme);
    setThemeMode(newTheme);
  }, [themeMode, setThemeMode]);

  // Device config - use custom dimensions from store for custom type
  const deviceConfig = useMemo(() => {
    if (deviceType === "custom") {
      return {
        ...CUSTOM_DEVICE_BASE,
        width: customViewport.width,
        height: customViewport.height,
      };
    }
    return PRESET_DEVICE_CONFIGS[deviceType];
  }, [deviceType, customViewport]);
  const DeviceIcon = deviceConfig.icon;

  // Locale and timezone from globals
  const locale = globals.locale;
  const timeZone = globals.timeZone;

  // Show ChatGPT Apps controls when: no protocol selected (default) or openai-apps
  const showChatGPTControls =
    protocol === null || protocol === UIType.OPENAI_SDK;
  // Show MCP Apps controls when mcp-apps protocol is selected
  const showMCPAppsControls = protocol === UIType.MCP_APPS;

  return (
    <div className={className}>
      <div className="flex items-center gap-4">
        {/* ChatGPT Apps controls */}
        {showChatGPTControls && (
          <>
            {/* Device type selector with custom dimensions */}
            <Popover
              open={devicePopoverOpen}
              onOpenChange={setDevicePopoverOpen}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs gap-1.5"
                    >
                      <DeviceIcon className="h-3.5 w-3.5" />
                      <span>{deviceConfig.label}</span>
                      <span className="text-muted-foreground text-[10px]">
                        {deviceConfig.width}×{deviceConfig.height}
                      </span>
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">Device</p>
                </TooltipContent>
              </Tooltip>
              <PopoverContent className="w-56 p-2" align="start">
                <div className="space-y-2">
                  {/* Preset devices */}
                  {(
                    Object.entries(PRESET_DEVICE_CONFIGS) as [
                      Exclude<DeviceType, "custom">,
                      (typeof PRESET_DEVICE_CONFIGS)[Exclude<
                        DeviceType,
                        "custom"
                      >],
                    ][]
                  ).map(([type, config]) => {
                    const Icon = config.icon;
                    const isSelected = deviceType === type;
                    return (
                      <button
                        key={type}
                        onClick={() => {
                          setDeviceType(type);
                          setDevicePopoverOpen(false);
                        }}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors ${
                          isSelected ? "bg-accent text-accent-foreground" : ""
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        <span>{config.label}</span>
                        <span className="text-muted-foreground text-[10px] ml-auto">
                          {config.width}×{config.height}
                        </span>
                      </button>
                    );
                  })}

                  {/* Custom option */}
                  <button
                    onClick={() => setDeviceType("custom")}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors ${
                      deviceType === "custom"
                        ? "bg-accent text-accent-foreground"
                        : ""
                    }`}
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                    <span>Custom</span>
                    <span className="text-muted-foreground text-[10px] ml-auto">
                      {customViewport.width}×{customViewport.height}
                    </span>
                  </button>

                  {/* Custom dimension inputs - only show when custom is selected */}
                  {deviceType === "custom" && (
                    <div className="grid grid-cols-2 gap-2 pt-1">
                      <div className="space-y-1">
                        <Label
                          htmlFor="custom-width"
                          className="text-[10px] text-muted-foreground"
                        >
                          Width
                        </Label>
                        <Input
                          id="custom-width"
                          type="number"
                          min={100}
                          max={2560}
                          defaultValue={customViewport.width}
                          key={`w-${customViewport.width}`}
                          onBlur={(e) => {
                            const val = parseInt(e.target.value) || 100;
                            setCustomViewport({
                              width: Math.max(100, Math.min(2560, val)),
                            });
                          }}
                          className="h-7 text-xs [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label
                          htmlFor="custom-height"
                          className="text-[10px] text-muted-foreground"
                        >
                          Height
                        </Label>
                        <Input
                          id="custom-height"
                          type="number"
                          min={100}
                          max={2560}
                          defaultValue={customViewport.height}
                          key={`h-${customViewport.height}`}
                          onBlur={(e) => {
                            const val = parseInt(e.target.value) || 100;
                            setCustomViewport({
                              height: Math.max(100, Math.min(2560, val)),
                            });
                          }}
                          className="h-7 text-xs [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>

            {/* Locale selector */}
            <Popover
              open={localePopoverOpen}
              onOpenChange={setLocalePopoverOpen}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs gap-1.5"
                    >
                      <Globe className="h-3.5 w-3.5" />
                      <span>{locale}</span>
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">Locale</p>
                </TooltipContent>
              </Tooltip>
              <PopoverContent className="w-48 p-2" align="start">
                <div className="space-y-1">
                  {LOCALE_OPTIONS.map((option) => (
                    <button
                      key={option.code}
                      onClick={() => {
                        updateGlobal("locale", option.code);
                        setLocalePopoverOpen(false);
                      }}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors ${
                        locale === option.code
                          ? "bg-accent text-accent-foreground"
                          : ""
                      }`}
                    >
                      <span>{option.label}</span>
                      <span className="text-muted-foreground text-[10px] ml-auto">
                        {option.code}
                      </span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>

            {/* CSP mode selector - uses protocol-aware store */}
            <Popover open={cspPopoverOpen} onOpenChange={setCspPopoverOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs gap-1.5"
                    >
                      <Shield className="h-3.5 w-3.5" />
                      <span>
                        {
                          CSP_MODE_OPTIONS.find((o) => o.mode === activeCspMode)
                            ?.label
                        }
                      </span>
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">CSP</p>
                </TooltipContent>
              </Tooltip>
              <PopoverContent className="w-56 p-2" align="start">
                <div className="space-y-1">
                  {CSP_MODE_OPTIONS.map((option) => (
                    <button
                      key={option.mode}
                      onClick={() => {
                        setActiveCspMode(option.mode);
                        setCspPopoverOpen(false);
                      }}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors ${
                        activeCspMode === option.mode
                          ? "bg-accent text-accent-foreground"
                          : ""
                      }`}
                    >
                      <span className="font-medium">{option.label}</span>
                      <span className="text-muted-foreground text-[10px] ml-auto">
                        {option.description}
                      </span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>

            {/* Capabilities toggles */}
            <div className="flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={capabilities.hover ? "secondary" : "ghost"}
                    size="icon"
                    onClick={() =>
                      setCapabilities({ hover: !capabilities.hover })
                    }
                    className="h-7 w-7"
                  >
                    <MousePointer2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">Hover</p>
                  <p className="text-xs text-muted-foreground">
                    {capabilities.hover ? "Enabled" : "Disabled"}
                  </p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={capabilities.touch ? "secondary" : "ghost"}
                    size="icon"
                    onClick={() =>
                      setCapabilities({ touch: !capabilities.touch })
                    }
                    className="h-7 w-7"
                  >
                    <Hand className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">Touch</p>
                  <p className="text-xs text-muted-foreground">
                    {capabilities.touch ? "Enabled" : "Disabled"}
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>

            {/* Safe area editor */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <SafeAreaEditor />
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">Safe Area</p>
              </TooltipContent>
            </Tooltip>
          </>
        )}

        {/* MCP Apps controls (SEP-1865) */}
        {showMCPAppsControls && (
          <>
            {/* Device type selector with custom dimensions */}
            <Popover
              open={devicePopoverOpen}
              onOpenChange={setDevicePopoverOpen}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs gap-1.5"
                    >
                      <DeviceIcon className="h-3.5 w-3.5" />
                      <span>{deviceConfig.label}</span>
                      <span className="text-muted-foreground text-[10px]">
                        {deviceConfig.width}×{deviceConfig.height}
                      </span>
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">Device</p>
                </TooltipContent>
              </Tooltip>
              <PopoverContent className="w-56 p-2" align="start">
                <div className="space-y-2">
                  {/* Preset devices */}
                  {(
                    Object.entries(PRESET_DEVICE_CONFIGS) as [
                      Exclude<DeviceType, "custom">,
                      (typeof PRESET_DEVICE_CONFIGS)[Exclude<
                        DeviceType,
                        "custom"
                      >],
                    ][]
                  ).map(([type, config]) => {
                    const Icon = config.icon;
                    const isSelected = deviceType === type;
                    return (
                      <button
                        key={type}
                        onClick={() => {
                          setDeviceType(type);
                          setDevicePopoverOpen(false);
                        }}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors ${
                          isSelected ? "bg-accent text-accent-foreground" : ""
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        <span>{config.label}</span>
                        <span className="text-muted-foreground text-[10px] ml-auto">
                          {config.width}×{config.height}
                        </span>
                      </button>
                    );
                  })}

                  {/* Custom option */}
                  <button
                    onClick={() => setDeviceType("custom")}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors ${
                      deviceType === "custom"
                        ? "bg-accent text-accent-foreground"
                        : ""
                    }`}
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                    <span>Custom</span>
                    <span className="text-muted-foreground text-[10px] ml-auto">
                      {customViewport.width}×{customViewport.height}
                    </span>
                  </button>

                  {/* Custom dimension inputs - only show when custom is selected */}
                  {deviceType === "custom" && (
                    <div className="grid grid-cols-2 gap-2 pt-1">
                      <div className="space-y-1">
                        <Label
                          htmlFor="custom-width-mcp"
                          className="text-[10px] text-muted-foreground"
                        >
                          Width
                        </Label>
                        <Input
                          id="custom-width-mcp"
                          type="number"
                          min={100}
                          max={2560}
                          defaultValue={customViewport.width}
                          key={`w-mcp-${customViewport.width}`}
                          onBlur={(e) => {
                            const val = parseInt(e.target.value) || 100;
                            setCustomViewport({
                              width: Math.max(100, Math.min(2560, val)),
                            });
                          }}
                          className="h-7 text-xs [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label
                          htmlFor="custom-height-mcp"
                          className="text-[10px] text-muted-foreground"
                        >
                          Height
                        </Label>
                        <Input
                          id="custom-height-mcp"
                          type="number"
                          min={100}
                          max={2560}
                          defaultValue={customViewport.height}
                          key={`h-mcp-${customViewport.height}`}
                          onBlur={(e) => {
                            const val = parseInt(e.target.value) || 100;
                            setCustomViewport({
                              height: Math.max(100, Math.min(2560, val)),
                            });
                          }}
                          className="h-7 text-xs [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>

            {/* Locale selector */}
            <Popover
              open={localePopoverOpen}
              onOpenChange={setLocalePopoverOpen}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs gap-1.5"
                    >
                      <Globe className="h-3.5 w-3.5" />
                      <span>{locale}</span>
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">Locale</p>
                </TooltipContent>
              </Tooltip>
              <PopoverContent className="w-48 p-2" align="start">
                <div className="space-y-1">
                  {LOCALE_OPTIONS.map((option) => (
                    <button
                      key={option.code}
                      onClick={() => {
                        updateGlobal("locale", option.code);
                        setLocalePopoverOpen(false);
                      }}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors ${
                        locale === option.code
                          ? "bg-accent text-accent-foreground"
                          : ""
                      }`}
                    >
                      <span>{option.label}</span>
                      <span className="text-muted-foreground text-[10px] ml-auto">
                        {option.code}
                      </span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>

            {/* Timezone selector (SEP-1865) */}
            <Popover
              open={timezonePopoverOpen}
              onOpenChange={setTimezonePopoverOpen}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs gap-1.5"
                    >
                      <Clock className="h-3.5 w-3.5" />
                      <span>
                        {TIMEZONE_OPTIONS.find((o) => o.zone === timeZone)
                          ?.label || timeZone}
                      </span>
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">Timezone</p>
                </TooltipContent>
              </Tooltip>
              <PopoverContent className="w-56 p-2" align="start">
                <div className="space-y-1">
                  {TIMEZONE_OPTIONS.map((option) => (
                    <button
                      key={option.zone}
                      onClick={() => {
                        updateGlobal("timeZone", option.zone);
                        setTimezonePopoverOpen(false);
                      }}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors ${
                        timeZone === option.zone
                          ? "bg-accent text-accent-foreground"
                          : ""
                      }`}
                    >
                      <span>{option.label}</span>
                      <span className="text-muted-foreground text-[10px] ml-auto">
                        {option.offset}
                      </span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>

            {/* CSP mode selector */}
            <Popover open={cspPopoverOpen} onOpenChange={setCspPopoverOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs gap-1.5"
                    >
                      <Shield className="h-3.5 w-3.5" />
                      <span>
                        {
                          CSP_MODE_OPTIONS.find(
                            (o) => o.mode === mcpAppsCspMode,
                          )?.label
                        }
                      </span>
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">CSP</p>
                </TooltipContent>
              </Tooltip>
              <PopoverContent className="w-56 p-2" align="start">
                <div className="space-y-1">
                  {CSP_MODE_OPTIONS.map((option) => (
                    <button
                      key={option.mode}
                      onClick={() => {
                        setMcpAppsCspMode(option.mode);
                        setCspPopoverOpen(false);
                      }}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors ${
                        mcpAppsCspMode === option.mode
                          ? "bg-accent text-accent-foreground"
                          : ""
                      }`}
                    >
                      <span className="font-medium">{option.label}</span>
                      <span className="text-muted-foreground text-[10px] ml-auto">
                        {option.description}
                      </span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>

            {/* Capabilities toggles */}
            <div className="flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={capabilities.hover ? "secondary" : "ghost"}
                    size="icon"
                    onClick={() =>
                      setCapabilities({ hover: !capabilities.hover })
                    }
                    className="h-7 w-7"
                  >
                    <MousePointer2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">Hover</p>
                  <p className="text-xs text-muted-foreground">
                    {capabilities.hover ? "Enabled" : "Disabled"}
                  </p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={capabilities.touch ? "secondary" : "ghost"}
                    size="icon"
                    onClick={() =>
                      setCapabilities({ touch: !capabilities.touch })
                    }
                    className="h-7 w-7"
                  >
                    <Hand className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">Touch</p>
                  <p className="text-xs text-muted-foreground">
                    {capabilities.touch ? "Enabled" : "Disabled"}
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>

            {/* Safe area editor */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <SafeAreaEditor />
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">Safe Area</p>
              </TooltipContent>
            </Tooltip>
          </>
        )}

        {/* Theme toggle */}
        {showThemeToggle && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleThemeChange}
                className="h-7 w-7"
              >
                {themeMode === "dark" ? (
                  <Sun className="h-3.5 w-3.5" />
                ) : (
                  <Moon className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {themeMode === "dark" ? "Light mode" : "Dark mode"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
