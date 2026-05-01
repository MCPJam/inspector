/**
 * HostContextHeader
 *
 * Reusable preview/runtime controls for host context, adjacent preview chrome,
 * and CSP mode. Host context edits are live draft changes; persistence happens
 * through the Host Context dialog.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Clock,
  Globe,
  Hand,
  Moon,
  MousePointer2,
  Palette,
  Settings2,
  Shield,
  Sun,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import type { WorkspaceHostContextDraft } from "@/lib/client-config";
import {
  extractHostDeviceCapabilities,
  extractHostLocale,
  extractHostTheme,
  extractHostTimeZone,
} from "@/lib/client-config";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import { listHostStyles } from "@/lib/host-styles";
import { cn } from "@/lib/utils";
import { useHostContextStore } from "@/stores/host-context-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import { SafeAreaEditor } from "@/components/ui-playground/SafeAreaEditor";
import { HostContextDialog } from "@/components/shared/HostContextDialog";
import {
  PRESET_DEVICE_CONFIGS,
  TIMEZONE_OPTIONS,
} from "@/components/shared/host-context-constants";
import {
  CspPickerBody,
  DevicePickerBody,
  LocalePickerBody,
  TimezonePickerBody,
} from "@/components/shared/host-context-picker-bodies";

export { PRESET_DEVICE_CONFIGS } from "@/components/shared/host-context-constants";

const CUSTOM_DEVICE_BASE = {
  label: "Custom",
};

export interface HostContextHeaderProps {
  activeWorkspaceId: string | null;
  onSaveHostContext?: (
    workspaceId: string,
    hostContext: WorkspaceHostContextDraft,
  ) => Promise<void>;
  protocol: UIType | null;
  showThemeToggle?: boolean;
  className?: string;
}

export function HostContextHeader({
  activeWorkspaceId,
  onSaveHostContext,
  protocol,
  showThemeToggle = false,
  className,
}: HostContextHeaderProps) {
  const [devicePopoverOpen, setDevicePopoverOpen] = useState(false);
  const [localePopoverOpen, setLocalePopoverOpen] = useState(false);
  const [cspPopoverOpen, setCspPopoverOpen] = useState(false);
  const [timezonePopoverOpen, setTimezonePopoverOpen] = useState(false);
  const [hostContextDialogOpen, setHostContextDialogOpen] = useState(false);

  const widthInputId = useId();
  const heightInputId = useId();

  const deviceType = useUIPlaygroundStore((state) => state.deviceType);
  const setDeviceType = useUIPlaygroundStore((state) => state.setDeviceType);
  const customViewport = useUIPlaygroundStore((state) => state.customViewport);
  const setCustomViewport = useUIPlaygroundStore(
    (state) => state.setCustomViewport,
  );
  const cspMode = useUIPlaygroundStore((state) => state.cspMode);
  const setCspMode = useUIPlaygroundStore((state) => state.setCspMode);
  const mcpAppsCspMode = useUIPlaygroundStore((state) => state.mcpAppsCspMode);
  const setMcpAppsCspMode = useUIPlaygroundStore(
    (state) => state.setMcpAppsCspMode,
  );

  const draftHostContext = useHostContextStore(
    (state) => state.draftHostContext,
  );
  const patchHostContext = useHostContextStore((state) => state.patchHostContext);
  const hostContextDirty = useHostContextStore((state) => state.isDirty);

  const themeMode = usePreferencesStore((state) => state.themeMode);
  const hostStyle = usePreferencesStore((state) => state.hostStyle);
  const setHostStyle = usePreferencesStore((state) => state.setHostStyle);

  const usesMcpAppsCsp =
    protocol === UIType.MCP_APPS ||
    protocol === UIType.OPENAI_SDK_AND_MCP_APPS;
  const activeCspMode = usesMcpAppsCsp ? mcpAppsCspMode : cspMode;
  const setActiveCspMode = usesMcpAppsCsp ? setMcpAppsCspMode : setCspMode;

  const violationCount = useWidgetDebugStore((state) =>
    Array.from(state.widgets.values()).reduce(
      (sum, widget) => sum + (widget.csp?.violations?.length ?? 0),
      0,
    ),
  );
  const [shouldBlink, setShouldBlink] = useState(false);
  const prevViolationCount = useRef(violationCount);

  useEffect(() => {
    if (violationCount > prevViolationCount.current) {
      setShouldBlink(true);
    }
    prevViolationCount.current = violationCount;
  }, [violationCount]);

  const fallbackLocale = navigator.language || "en-US";
  const fallbackTimeZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const deviceConfig = useMemo(() => {
    if (deviceType === "custom") {
      return {
        ...CUSTOM_DEVICE_BASE,
        width: customViewport.width,
        height: customViewport.height,
      };
    }

    return PRESET_DEVICE_CONFIGS[deviceType];
  }, [customViewport, deviceType]);
  const DeviceIcon = deviceType === "custom" ? null : deviceConfig.icon;

  const locale = extractHostLocale(draftHostContext, fallbackLocale);
  const timeZone = extractHostTimeZone(draftHostContext, fallbackTimeZone);
  const capabilities = extractHostDeviceCapabilities(draftHostContext);
  const effectiveThemeMode = extractHostTheme(draftHostContext) ?? themeMode;

  const handleCapabilityToggle = useCallback(
    (key: "hover" | "touch") => {
      const nextCapabilities = {
        hover: key === "hover" ? !capabilities.hover : capabilities.hover,
        touch: key === "touch" ? !capabilities.touch : capabilities.touch,
      };
      patchHostContext({ deviceCapabilities: nextCapabilities });
    },
    [capabilities, patchHostContext],
  );

  const handleThemeChange = useCallback(() => {
    patchHostContext({
      theme: effectiveThemeMode === "dark" ? "light" : "dark",
    });
  }, [effectiveThemeMode, patchHostContext]);

  return (
    <div className={cn("min-w-0 max-w-full", className)}>
      <div className="flex min-w-0 max-w-full items-center gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] @max-[860px]/playground-header:gap-2 [&::-webkit-scrollbar]:hidden">
        <Popover open={devicePopoverOpen} onOpenChange={setDevicePopoverOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 gap-1.5 border bg-background px-2 text-xs shadow-xs"
                >
                  {DeviceIcon ? <DeviceIcon className="h-3.5 w-3.5" /> : null}
                  <span className="whitespace-nowrap">{deviceConfig.label}</span>
                  <span className="text-[10px] text-muted-foreground @max-[1020px]/playground-header:hidden">
                    {deviceConfig.width}x{deviceConfig.height}
                  </span>
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>
              <p className="font-medium">Device</p>
            </TooltipContent>
          </Tooltip>
          <PopoverContent className="w-56 p-2" align="start">
            <DevicePickerBody
              deviceType={deviceType}
              setDeviceType={setDeviceType}
              customViewport={customViewport}
              setCustomViewport={setCustomViewport}
              widthInputId={widthInputId}
              heightInputId={heightInputId}
              onPickPreset={() => setDevicePopoverOpen(false)}
            />
          </PopoverContent>
        </Popover>

        <Popover open={localePopoverOpen} onOpenChange={setLocalePopoverOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 gap-1.5 border bg-background px-2 text-xs shadow-xs"
                >
                  <Globe className="h-3.5 w-3.5" />
                  <span className="whitespace-nowrap @max-[800px]/playground-header:sr-only">
                    {locale}
                  </span>
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>
              <p className="font-medium">Locale</p>
            </TooltipContent>
          </Tooltip>
          <PopoverContent className="w-48 p-2" align="start">
            <LocalePickerBody
              locale={locale}
              patchHostContext={patchHostContext}
              onSelectLocale={() => setLocalePopoverOpen(false)}
            />
          </PopoverContent>
        </Popover>

        <Popover open={timezonePopoverOpen} onOpenChange={setTimezonePopoverOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 gap-1.5 border bg-background px-2 text-xs shadow-xs"
                >
                  <Clock className="h-3.5 w-3.5" />
                  <span className="whitespace-nowrap @max-[920px]/playground-header:sr-only">
                    {TIMEZONE_OPTIONS.find((option) => option.zone === timeZone)
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
            <TimezonePickerBody
              timeZone={timeZone}
              patchHostContext={patchHostContext}
              onSelectZone={() => setTimezonePopoverOpen(false)}
            />
          </PopoverContent>
        </Popover>

        <Popover open={cspPopoverOpen} onOpenChange={setCspPopoverOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "h-7 shrink-0 gap-1.5 border bg-background px-2 text-xs shadow-xs",
                    shouldBlink &&
                      activeCspMode === "widget-declared" &&
                      "animate-csp-alert-blink",
                  )}
                  onAnimationEnd={() => setShouldBlink(false)}
                >
                  <Shield className="h-3.5 w-3.5" />
                  <span className="whitespace-nowrap @max-[760px]/playground-header:sr-only">
                    {activeCspMode === "permissive" ? "Permissive" : "Strict"}
                  </span>
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>
              <p className="font-medium">CSP</p>
            </TooltipContent>
          </Tooltip>
          <PopoverContent className="w-56 p-2" align="start">
            <CspPickerBody
              activeCspMode={activeCspMode}
              setActiveCspMode={setActiveCspMode}
              onSelectMode={() => setCspPopoverOpen(false)}
            />
          </PopoverContent>
        </Popover>

        <div className="flex shrink-0 items-center gap-0.5 rounded-md border bg-background p-0.5 shadow-xs">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={capabilities.hover ? "secondary" : "ghost"}
                size="icon"
                onClick={() => handleCapabilityToggle("hover")}
                className="h-7 w-7"
              >
                <MousePointer2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="font-medium">Hover</p>
              <p className="text-xs font-light text-primary-foreground/90">
                {capabilities.hover ? "Enabled" : "Disabled"}
              </p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={capabilities.touch ? "secondary" : "ghost"}
                size="icon"
                onClick={() => handleCapabilityToggle("touch")}
                className="h-7 w-7"
              >
                <Hand className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="font-medium">Touch</p>
              <p className="text-xs font-light text-primary-foreground/90">
                {capabilities.touch ? "Enabled" : "Disabled"}
              </p>
            </TooltipContent>
          </Tooltip>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <div className="shrink-0 rounded-md border bg-background p-0.5 shadow-xs">
              <SafeAreaEditor />
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p className="font-medium">Safe Area</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1.5 border bg-background px-2 text-xs shadow-xs"
              data-testid="host-context-trigger"
              onClick={() => setHostContextDialogOpen(true)}
            >
              <Settings2 className="h-3.5 w-3.5" />
              <span className="whitespace-nowrap @max-[700px]/playground-header:sr-only">
                Host Context
              </span>
              {hostContextDirty ? (
                <span className="whitespace-nowrap text-[10px] text-amber-600 @max-[700px]/playground-header:sr-only dark:text-amber-400">
                  Unsaved
                </span>
              ) : null}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p className="font-medium">Host Context</p>
            <p className="text-xs text-muted-foreground">
              Edit raw `hostContext` JSON
            </p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex shrink-0 items-center gap-0.5 rounded-md border bg-background p-0.5 shadow-xs">
              <div className="flex h-6 w-6 items-center justify-center @max-[820px]/playground-header:hidden">
                <Palette className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
              {listHostStyles().map((host) => (
                <Button
                  key={host.id}
                  variant={hostStyle === host.id ? "secondary" : "ghost"}
                  size="icon"
                  onClick={() => setHostStyle(host.id)}
                  className="h-6 w-6"
                >
                  <img
                    src={host.logoSrc}
                    alt={host.label}
                    className="h-3.5 w-3.5 object-contain"
                  />
                </Button>
              ))}
            </div>
          </TooltipTrigger>
          <TooltipContent>Host Styles</TooltipContent>
        </Tooltip>

        {showThemeToggle ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleThemeChange}
                data-testid="host-context-theme-toggle"
                className="h-7 w-7 shrink-0 border bg-background shadow-xs"
              >
                {effectiveThemeMode === "dark" ? (
                  <Sun className="h-3.5 w-3.5" />
                ) : (
                  <Moon className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {effectiveThemeMode === "dark" ? "Light mode" : "Dark mode"}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <HostContextDialog
        activeWorkspaceId={activeWorkspaceId}
        open={hostContextDialogOpen}
        onOpenChange={setHostContextDialogOpen}
        onSaveHostContext={onSaveHostContext}
      />
    </div>
  );
}
