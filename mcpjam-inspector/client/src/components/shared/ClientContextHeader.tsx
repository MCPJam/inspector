/**
 * ClientContextHeader
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
import { usePostHog } from "posthog-js/react";
import { standardEventProps } from "@/lib/PosthogUtils";
import {
  Clock,
  Cpu,
  Globe,
  Hand,
  Moon,
  MousePointer2,
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
import type { ProjectHostContextDraft } from "@/lib/client-config";
import {
  extractHostDeviceCapabilities,
  extractHostLocale,
  extractHostTheme,
  extractHostTimeZone,
} from "@/lib/client-config";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import { listHostStyles } from "@/lib/client-styles";
import type { ChatboxHostStyle } from "@/lib/chatbox-client-style";
import { applyHostDefaultsToPlayground } from "@/lib/playground/apply-client-defaults";
import { cn } from "@/lib/utils";
import { useHostContextStore } from "@/stores/client-context-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import { SafeAreaEditor } from "@/components/ui-playground/SafeAreaEditor";
import { ClientContextDialog } from "@/components/shared/ClientContextDialog";
import { ClientCapabilitiesOverrideDialog } from "@/components/client-config/ClientCapabilitiesOverrideDialog";
import {
  PRESET_DEVICE_CONFIGS,
  TIMEZONE_OPTIONS,
} from "@/components/shared/client-context-constants";
import {
  CspPickerBody,
  DevicePickerBody,
  HostStylePickerBody,
  LocalePickerBody,
  TimezonePickerBody,
} from "@/components/shared/client-context-picker-bodies";

export { PRESET_DEVICE_CONFIGS } from "@/components/shared/client-context-constants";

const CUSTOM_DEVICE_BASE = {
  label: "Custom",
};

/** Muted toolbar hints (`design-system/tooltip`): popover chrome, avoids primary “CTA” orange. */
const PLAYGROUND_HEADER_TOOLTIP = {
  variant: "muted" as const,
  sideOffset: 6,
  collisionPadding: 12,
};

export interface HostContextHeaderProps {
  activeProjectId: string | null;
  onSaveHostContext?: (
    projectId: string,
    hostContext: ProjectHostContextDraft,
  ) => Promise<void>;
  protocol: UIType | null;
  showThemeToggle?: boolean;
  className?: string;
}

export function ClientContextHeader({
  activeProjectId,
  onSaveHostContext,
  protocol,
  showThemeToggle = false,
  className,
}: HostContextHeaderProps) {
  const [devicePopoverOpen, setDevicePopoverOpen] = useState(false);
  const [localePopoverOpen, setLocalePopoverOpen] = useState(false);
  const [cspPopoverOpen, setCspPopoverOpen] = useState(false);
  const [timezonePopoverOpen, setTimezonePopoverOpen] = useState(false);
  const [hostStylePopoverOpen, setHostStylePopoverOpen] = useState(false);
  const [hostContextDialogOpen, setHostContextDialogOpen] = useState(false);
  const [hostCapsDialogOpen, setHostCapsDialogOpen] = useState(false);

  const widthInputId = useId();
  const heightInputId = useId();

  const posthog = usePostHog();
  const captureToolbar = useCallback(
    (event: string, props?: Record<string, unknown>) => {
      posthog?.capture(event, {
        ...standardEventProps("host_context_header"),
        ...props,
      });
    },
    [posthog],
  );

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

  const themeMode = usePreferencesStore((state) => state.themeMode);
  const hostStyle = usePreferencesStore((state) => state.hostStyle);
  const setHostStyle = usePreferencesStore((state) => state.setHostStyle);
  const hostCapabilitiesOverride = usePreferencesStore(
    (state) => state.hostCapabilitiesOverride,
  );
  const setHostCapabilitiesOverride = usePreferencesStore(
    (state) => state.setHostCapabilitiesOverride,
  );
  const setChatUiOverride = usePreferencesStore(
    (state) => state.setChatUiOverride,
  );

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

  const registeredHostStyles = useMemo(() => listHostStyles(), []);
  const activeHostStyle = useMemo((): (typeof registeredHostStyles)[number] => {
    const match = registeredHostStyles.find((h) => h.id === hostStyle);
    return match ?? registeredHostStyles[0];
  }, [hostStyle, registeredHostStyles]);
  const DeviceIcon =
    deviceType === "custom" || !("icon" in deviceConfig)
      ? null
      : deviceConfig.icon;

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
      captureToolbar("host_toolbar_capability_toggled", {
        capability: key,
        enabled: nextCapabilities[key],
      });
      patchHostContext({ deviceCapabilities: nextCapabilities });
    },
    [capabilities, patchHostContext, captureToolbar],
  );

  const handleThemeChange = useCallback(() => {
    const nextTheme = effectiveThemeMode === "dark" ? "light" : "dark";
    captureToolbar("host_theme_toggled", {
      from: effectiveThemeMode,
      to: nextTheme,
    });
    patchHostContext({ theme: nextTheme });
  }, [effectiveThemeMode, patchHostContext, captureToolbar]);

  return (
    <div className={cn("min-w-0 max-w-full", className)}>
      <div className="flex min-w-0 max-w-full items-center gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] @max-[860px]/playground-header:gap-2 [&::-webkit-scrollbar]:hidden">
        <Popover
          open={devicePopoverOpen}
          onOpenChange={(next) => {
            if (next) captureToolbar("host_toolbar_opened", { control: "device" });
            setDevicePopoverOpen(next);
          }}
        >
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
            <TooltipContent {...PLAYGROUND_HEADER_TOOLTIP}>
              <p className="font-medium">Device</p>
            </TooltipContent>
          </Tooltip>
          <PopoverContent className="w-56 p-2" align="start">
            <DevicePickerBody
              deviceType={deviceType}
              setDeviceType={(next) => {
                if (next !== deviceType) {
                  captureToolbar("host_toolbar_device_changed", {
                    from: deviceType,
                    to: next,
                  });
                }
                setDeviceType(next);
              }}
              customViewport={customViewport}
              setCustomViewport={setCustomViewport}
              widthInputId={widthInputId}
              heightInputId={heightInputId}
              onPickPreset={() => setDevicePopoverOpen(false)}
            />
          </PopoverContent>
        </Popover>

        <Popover
          open={localePopoverOpen}
          onOpenChange={(next) => {
            if (next) captureToolbar("host_toolbar_opened", { control: "locale" });
            setLocalePopoverOpen(next);
          }}
        >
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
            <TooltipContent {...PLAYGROUND_HEADER_TOOLTIP}>
              <p className="font-medium">Locale</p>
            </TooltipContent>
          </Tooltip>
          <PopoverContent className="w-48 p-2" align="start">
            <LocalePickerBody
              locale={locale}
              patchHostContext={(patch) => {
                if (patch.locale && patch.locale !== locale) {
                  captureToolbar("host_toolbar_locale_changed", {
                    from: locale,
                    to: patch.locale,
                  });
                }
                patchHostContext(patch);
              }}
              onSelectLocale={() => setLocalePopoverOpen(false)}
            />
          </PopoverContent>
        </Popover>

        <Popover
          open={timezonePopoverOpen}
          onOpenChange={(next) => {
            if (next) captureToolbar("host_toolbar_opened", { control: "timezone" });
            setTimezonePopoverOpen(next);
          }}
        >
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
            <TooltipContent {...PLAYGROUND_HEADER_TOOLTIP}>
              <p className="font-medium">Timezone</p>
            </TooltipContent>
          </Tooltip>
          <PopoverContent className="w-56 p-2" align="start">
            <TimezonePickerBody
              timeZone={timeZone}
              patchHostContext={(patch) => {
                if (patch.timeZone && patch.timeZone !== timeZone) {
                  captureToolbar("host_toolbar_timezone_changed", {
                    from: timeZone,
                    to: patch.timeZone,
                  });
                }
                patchHostContext(patch);
              }}
              onSelectZone={() => setTimezonePopoverOpen(false)}
            />
          </PopoverContent>
        </Popover>

        <Popover
          open={cspPopoverOpen}
          onOpenChange={(next) => {
            if (next)
              captureToolbar("host_toolbar_opened", {
                control: "csp",
                current: activeCspMode,
              });
            setCspPopoverOpen(next);
          }}
        >
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
            <TooltipContent {...PLAYGROUND_HEADER_TOOLTIP}>
              <p className="font-medium">CSP</p>
            </TooltipContent>
          </Tooltip>
          <PopoverContent className="w-56 p-2" align="start">
            <CspPickerBody
              activeCspMode={activeCspMode}
              setActiveCspMode={(next) => {
                if (next !== activeCspMode) {
                  captureToolbar("host_toolbar_csp_changed", {
                    from: activeCspMode,
                    to: next,
                  });
                }
                setActiveCspMode(next);
              }}
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
            <TooltipContent {...PLAYGROUND_HEADER_TOOLTIP}>
              <p className="font-medium">Hover</p>
              <p className="text-xs font-light text-muted-foreground">
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
            <TooltipContent {...PLAYGROUND_HEADER_TOOLTIP}>
              <p className="font-medium">Touch</p>
              <p className="text-xs font-light text-muted-foreground">
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
          <TooltipContent {...PLAYGROUND_HEADER_TOOLTIP}>
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
              onClick={() => {
                captureToolbar("host_context_dialog_opened");
                setHostContextDialogOpen(true);
              }}
            >
              <Settings2 className="h-3.5 w-3.5" />
              <span className="whitespace-nowrap @max-[700px]/playground-header:sr-only">
                Host Context
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent {...PLAYGROUND_HEADER_TOOLTIP} className="max-w-sm">
            <p className="font-medium">Client Context</p>
            <p className="text-xs text-muted-foreground">
              Edit raw `hostContext` JSON
            </p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1.5 border bg-background px-2 text-xs shadow-xs"
              data-testid="host-capabilities-trigger"
              onClick={() => {
                captureToolbar("host_capabilities_dialog_opened");
                setHostCapsDialogOpen(true);
              }}
            >
              <Cpu className="h-3.5 w-3.5" />
              <span className="whitespace-nowrap @max-[700px]/playground-header:sr-only">
                Host Capabilities
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent {...PLAYGROUND_HEADER_TOOLTIP} className="max-w-sm">
            <p className="font-medium">Host Capabilities</p>
            <p className="text-xs text-muted-foreground">
              JSON payload for `hostCapabilities` in ui/initialize
            </p>
          </TooltipContent>
        </Tooltip>

        <Popover
          open={hostStylePopoverOpen}
          onOpenChange={(next) => {
            if (next)
              captureToolbar("host_toolbar_opened", {
                control: "host_style",
                current: hostStyle,
              });
            setHostStylePopoverOpen(next);
          }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label="Client styles"
                  data-testid="host-style-picker-trigger"
                  className="h-7 w-7 shrink-0 border bg-background shadow-xs"
                >
                  <img
                    src={activeHostStyle.chatUi.logoSrc}
                    alt=""
                    aria-hidden="true"
                    className="h-3.5 w-3.5 object-contain"
                  />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent {...PLAYGROUND_HEADER_TOOLTIP}>
              <p className="font-medium">Client styles</p>
              <p className="text-xs font-light text-muted-foreground">
                {activeHostStyle.chatUi.label}
              </p>
            </TooltipContent>
          </Tooltip>
          <PopoverContent className="w-56 p-2" align="start">
            <HostStylePickerBody
              hostStyle={hostStyle}
              onPickHost={(id: ChatboxHostStyle) => {
                if (id !== hostStyle) {
                  captureToolbar("host_style_changed", {
                    from: hostStyle,
                    to: id,
                  });
                }
                applyHostDefaultsToPlayground(
                  id,
                  {
                    setHostStyle,
                    setHostCapabilitiesOverride,
                    setChatUiOverride,
                  },
                  { theme: themeMode },
                );
                setHostStylePopoverOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>

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
            <TooltipContent {...PLAYGROUND_HEADER_TOOLTIP}>
              <p className="font-medium">
                {effectiveThemeMode === "dark" ? "Light mode" : "Dark mode"}
              </p>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <ClientContextDialog
        activeProjectId={activeProjectId}
        open={hostContextDialogOpen}
        onOpenChange={setHostContextDialogOpen}
        onSaveHostContext={onSaveHostContext}
      />

      <ClientCapabilitiesOverrideDialog
        open={hostCapsDialogOpen}
        onOpenChange={setHostCapsDialogOpen}
        hostStyle={hostStyle}
        override={hostCapabilitiesOverride}
        onSave={setHostCapabilitiesOverride}
      />
    </div>
  );
}
