/**
 * TestCaseClientHeader
 *
 * Per-case in-place tweak header for the eval test case editor. Mirrors the
 * playground's ClientContextHeader visually, but is fully controlled — no
 * writes to zustand stores. Tweaks live on `value` (a HostConfigInputV2)
 * and never persist back to the suite.
 *
 * Source-of-truth flow:
 *   baseline   → suite hostConfig (read via hostConfigsV2:getSuiteConfig)
 *   value      → null = "no tweak, use baseline"; non-null = override layer
 *   effective  → value ?? baseline (used for both display and the next Run)
 *
 * Controls surfaced: Locale, Timezone, Hover/Touch, Host Context dialog,
 * Host Capabilities override dialog, Host Style pills. Drops Device / CSP /
 * SafeArea / Theme — those are playground-iframe concerns that don't
 * influence a server-side eval run.
 */

import { useCallback, useMemo, useState } from "react";
import {
  ChevronDown,
  Clock,
  Cpu,
  Globe,
  Hand,
  MousePointer2,
  Paintbrush,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
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
import {
  LocalePickerBody,
  TimezonePickerBody,
} from "@/components/shared/client-context-picker-bodies";
import { TIMEZONE_OPTIONS } from "@/components/shared/client-context-constants";
import { TestCaseClientContextDialog } from "./TestCaseClientContextDialog";
import { ClientCapabilitiesOverrideDialog } from "@/components/client-config/ClientCapabilitiesOverrideDialog";
import {
  extractHostDeviceCapabilities,
  extractHostLocale,
  extractHostTimeZone,
} from "@/lib/client-config";
import { listHostStyles } from "@/lib/client-styles";
import {
  hostConfigInputsEqual,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { applyHostStyleToHostConfigInput } from "@/lib/client-config-v2-helpers";
import { cn } from "@/lib/utils";

const PLAYGROUND_HEADER_TOOLTIP = {
  variant: "muted" as const,
  sideOffset: 6,
  collisionPadding: 12,
};

export interface TestCaseHostHeaderProps {
  /** Suite-level baseline. Read-only at the header layer. */
  baseline: HostConfigInputV2;
  /**
   * Current override. `null` = no tweak (display the baseline). Non-null =
   * the user has tweaked at least one field; we display + use this instead.
   */
  value: HostConfigInputV2 | null;
  /**
   * Notify the parent of an override change. Pass `null` to clear the
   * override and fall back to the baseline.
   */
  onChange: (next: HostConfigInputV2 | null) => void;
  className?: string;
}

export function TestCaseClientHeader({
  baseline,
  value,
  onChange,
  className,
}: TestCaseHostHeaderProps) {
  const [localePopoverOpen, setLocalePopoverOpen] = useState(false);
  const [timezonePopoverOpen, setTimezonePopoverOpen] = useState(false);
  const [hostContextDialogOpen, setHostContextDialogOpen] = useState(false);
  const [hostCapsDialogOpen, setHostCapsDialogOpen] = useState(false);

  // What the user actually sees + what the next Run will use.
  const effective = value ?? baseline;
  const isTweaked = value !== null && !hostConfigInputsEqual(value, baseline);

  const locale = extractHostLocale(effective.hostContext, "en-US");
  const timeZone = extractHostTimeZone(effective.hostContext, "UTC");
  const capabilities = extractHostDeviceCapabilities(effective.hostContext);

  /**
   * Apply a patch to `effective` and collapse back to `null` if the
   * result is structurally equal to the baseline. Keeps the "Tweaked"
   * pill honest — toggling a field back to its original value clears the
   * override automatically.
   */
  const commit = useCallback(
    (next: HostConfigInputV2) => {
      if (hostConfigInputsEqual(next, baseline)) {
        onChange(null);
      } else {
        onChange(next);
      }
    },
    [baseline, onChange],
  );

  const patchHostContext = useCallback(
    (patch: Record<string, unknown>) => {
      commit({
        ...effective,
        hostContext: { ...effective.hostContext, ...patch },
      });
    },
    [commit, effective],
  );

  const setHostContext = useCallback(
    (nextHostContext: Record<string, unknown>) => {
      commit({ ...effective, hostContext: nextHostContext });
    },
    [commit, effective],
  );

  const setHostCapabilitiesOverride = useCallback(
    (next: Record<string, unknown> | undefined) => {
      commit({ ...effective, hostCapabilitiesOverride: next });
    },
    [commit, effective],
  );

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

  const handleHostStyleClick = useCallback(
    (hostStyle: string) => {
      commit(applyHostStyleToHostConfigInput(hostStyle, effective));
    },
    [commit, effective],
  );

  const handleReset = useCallback(() => {
    onChange(null);
  }, [onChange]);

  const hostStyles = useMemo(() => listHostStyles(), []);

  // Outer popover state. The chip row used to live inline and ate 60-80px
  // of vertical space on every test-case-edit view — even though the
  // typical user never tweaks locale/timezone/style per case. We collapse
  // to a single trigger button and surface the full row on click.
  const [scenarioOpen, setScenarioOpen] = useState(false);

  return (
    <div className={cn("min-w-0 max-w-full", className)}>
      <Popover open={scenarioOpen} onOpenChange={setScenarioOpen}>
        <div className="flex flex-wrap items-center gap-2">
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 shrink-0 gap-1.5 border bg-background px-2 text-xs shadow-xs",
                isTweaked &&
                  "border-primary/40 bg-primary/[0.06] text-foreground",
              )}
              data-testid="test-case-scenario-context-trigger"
              aria-label="Scenario context"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span className="whitespace-nowrap">
                Scenario:{" "}
                <span
                  className={cn(
                    "font-medium",
                    isTweaked ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {isTweaked ? "customized" : "suite default"}
                </span>
              </span>
              <ChevronDown
                className="h-3 w-3 text-muted-foreground"
                aria-hidden
              />
            </Button>
          </PopoverTrigger>
          {isTweaked ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 gap-1 px-1.5 text-[11px] text-muted-foreground"
                  onClick={handleReset}
                  data-testid="test-case-host-reset"
                >
                  <RotateCcw className="h-3 w-3" />
                  Reset
                </Button>
              </TooltipTrigger>
              <TooltipContent {...PLAYGROUND_HEADER_TOOLTIP}>
                <p className="font-medium">Reset to suite default</p>
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>

        <PopoverContent
          align="start"
          sideOffset={8}
          className="w-[min(40rem,calc(100vw-2rem))] p-3"
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Scenario context
            </span>
            <span className="h-px flex-1 bg-border/40" aria-hidden />
            {isTweaked ? (
              <span className="text-[10px] font-medium text-primary">
                Overriding suite default
              </span>
            ) : (
              <span className="text-[10px] text-muted-foreground/70">
                Inheriting suite default
              </span>
            )}
          </div>
          <div className="@container/test-case-host-header flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
        {/* Locale */}
        <Popover open={localePopoverOpen} onOpenChange={setLocalePopoverOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 gap-1.5 border bg-background px-2 text-xs shadow-xs"
                  data-testid="test-case-host-locale-trigger"
                >
                  <Globe className="h-3.5 w-3.5" />
                  <span className="whitespace-nowrap">{locale}</span>
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
              patchHostContext={patchHostContext}
              onSelectLocale={() => setLocalePopoverOpen(false)}
            />
          </PopoverContent>
        </Popover>

        {/* Timezone */}
        <Popover open={timezonePopoverOpen} onOpenChange={setTimezonePopoverOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 gap-1.5 border bg-background px-2 text-xs shadow-xs"
                  data-testid="test-case-host-timezone-trigger"
                >
                  <Clock className="h-3.5 w-3.5" />
                  <span className="whitespace-nowrap">
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
              patchHostContext={patchHostContext}
              onSelectZone={() => setTimezonePopoverOpen(false)}
            />
          </PopoverContent>
        </Popover>

        {/* Input capabilities: labeled segmented control */}
        <div className="flex shrink-0 items-center gap-1 rounded-md border bg-background p-0.5 pl-1.5 shadow-xs">
          <span className="text-[10px] font-medium text-muted-foreground">
            Input
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={capabilities.hover ? "secondary" : "ghost"}
                size="icon"
                onClick={() => handleCapabilityToggle("hover")}
                className="h-6 w-6"
                data-testid="test-case-host-hover-toggle"
                aria-label="Toggle hover capability"
                aria-pressed={capabilities.hover}
              >
                <MousePointer2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent {...PLAYGROUND_HEADER_TOOLTIP}>
              <p className="font-medium">Hover (pointer)</p>
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
                className="h-6 w-6"
                data-testid="test-case-host-touch-toggle"
                aria-label="Toggle touch capability"
                aria-pressed={capabilities.touch}
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

        {/* Group separator between Client and Host concerns */}
        <span
          className="mx-1 h-5 w-px shrink-0 bg-border/60"
          aria-hidden
        />

        {/* Host Context dialog */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1.5 border bg-background px-2 text-xs shadow-xs"
              data-testid="test-case-host-context-trigger"
              onClick={() => setHostContextDialogOpen(true)}
            >
              <Settings2 className="h-3.5 w-3.5" />
              <span className="whitespace-nowrap">Client Context</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent {...PLAYGROUND_HEADER_TOOLTIP} className="max-w-sm">
            <p className="font-medium">Client Context</p>
            <p className="text-xs text-muted-foreground">
              Edit raw `hostContext` JSON for the next Run
            </p>
          </TooltipContent>
        </Tooltip>

        {/* Host Capabilities override */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1.5 border bg-background px-2 text-xs shadow-xs"
              data-testid="test-case-host-capabilities-trigger"
              onClick={() => setHostCapsDialogOpen(true)}
            >
              <Cpu className="h-3.5 w-3.5" />
              <span className="whitespace-nowrap">Host Capabilities</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent {...PLAYGROUND_HEADER_TOOLTIP} className="max-w-sm">
            <p className="font-medium">Host Capabilities</p>
            <p className="text-xs text-muted-foreground">
              JSON payload for `hostCapabilities` in ui/initialize
            </p>
          </TooltipContent>
        </Tooltip>

        {/* Host Style brand pills — expand on hover/focus, otherwise compact */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "group/host-styles flex shrink-0 items-center gap-1 rounded-md border bg-background p-0.5 pl-2 shadow-xs transition-[border-color,background-color,box-shadow]",
                "hover:border-border focus-within:border-border",
              )}
            >
              <div className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-muted-foreground">
                <Paintbrush className="h-3 w-3" />
                Style
              </div>
              <div
                className={cn(
                  "flex min-w-0 items-center gap-0.5 overflow-hidden transition-[max-width,opacity] duration-200 ease-out",
                  "max-w-0 opacity-0",
                  "group-hover/host-styles:max-w-[320px] group-hover/host-styles:opacity-100",
                  "group-focus-within/host-styles:max-w-[320px] group-focus-within/host-styles:opacity-100",
                  "[@media(hover:none)]:!max-w-[320px] [@media(hover:none)]:!opacity-100",
                  "[@media(pointer:coarse)]:!max-w-[320px] [@media(pointer:coarse)]:!opacity-100",
                )}
              >
                {hostStyles.map((host) => (
                  <Button
                    key={host.id}
                    variant={
                      effective.hostStyle === host.id ? "secondary" : "ghost"
                    }
                    size="icon"
                    onClick={() => handleHostStyleClick(host.id)}
                    className="h-6 w-6 shrink-0"
                    data-testid={`test-case-host-style-${host.id}`}
                    data-selected={
                      effective.hostStyle === host.id ? "true" : undefined
                    }
                    aria-pressed={effective.hostStyle === host.id}
                    aria-label={`Set host style to ${host.chatUi.label}`}
                  >
                    <img
                      src={host.chatUi.logoSrc}
                      alt={host.chatUi.label}
                      className="h-3.5 w-3.5 object-contain"
                    />
                  </Button>
                ))}
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent {...PLAYGROUND_HEADER_TOOLTIP}>
            <p className="font-medium">Host style</p>
            <p className="text-xs font-light text-muted-foreground">
              Pick the brand shell this case runs under
            </p>
          </TooltipContent>
        </Tooltip>

        {/* Tweaked badge + Reset */}
        {isTweaked ? (
          <span
            className="ml-auto rounded-md border border-primary/40 bg-primary/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-primary"
            data-testid="test-case-host-tweaked-badge"
          >
            Customized
          </span>
        ) : null}
          </div>
        </PopoverContent>
      </Popover>

      <TestCaseClientContextDialog
        open={hostContextDialogOpen}
        onOpenChange={setHostContextDialogOpen}
        value={effective.hostContext}
        onChange={setHostContext}
        onClearOverride={handleReset}
      />

      <ClientCapabilitiesOverrideDialog
        open={hostCapsDialogOpen}
        onOpenChange={setHostCapsDialogOpen}
        hostStyle={effective.hostStyle}
        override={effective.hostCapabilitiesOverride}
        onSave={setHostCapabilitiesOverride}
      />
    </div>
  );
}
