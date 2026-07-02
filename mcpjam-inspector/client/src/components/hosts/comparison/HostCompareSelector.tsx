import { ChevronDown } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { Button } from "@mcpjam/design-system/button";
import { Switch } from "@mcpjam/design-system/switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@mcpjam/design-system/command";
import { cn } from "@/lib/utils";
import { getChatboxHostLogo } from "@/lib/chatbox-client-style";
import type { HostListItem } from "@/hooks/useClients";
import type { HostComparisonSubject } from "@/lib/host-config-field-schema";
import type { HostThemeMode } from "@/lib/client-styles";
import type { SupportFilterMode } from "./support-level";

const INLINE_CHIP_LIMIT = 6;

const SUPPORT_FILTERS: ReadonlyArray<{
  value: SupportFilterMode;
  label: string;
  title: string;
}> = [
  { value: "all", label: "All", title: "Show every field" },
  {
    value: "missing",
    label: "Missing",
    title: "Capabilities not supported by at least one host",
  },
  {
    value: "partial",
    label: "Partial",
    title: "Capabilities that are partial / Auto for at least one host",
  },
  {
    value: "supported",
    label: "Full",
    title: "Capabilities supported by every host",
  },
];

interface HostCompareSelectorProps {
  hosts: ReadonlyArray<HostListItem>;
  selectedHostIds: ReadonlyArray<string>;
  subjectsByHost: Readonly<Record<string, HostComparisonSubject>>;
  onToggleHost: (hostId: string) => void;
  matchCount?: number;
  totalCount?: number;
  showCount?: boolean;
  viewMode?: "table" | "list";
  onViewModeChange?: (mode: "table" | "list") => void;
  disableListView?: boolean;
  divergingOnly: boolean;
  onDivergingOnlyChange: (enabled: boolean) => void;
  supportFilter: SupportFilterMode;
  onSupportFilterChange: (mode: SupportFilterMode) => void;
  showDescriptions: boolean;
  onShowDescriptionsChange: (enabled: boolean) => void;
  descriptionsDisabled?: boolean;
  disabled?: boolean;
  themeMode?: HostThemeMode;
  mobileOptimized?: boolean;
}

export function HostCompareSelector({
  hosts,
  selectedHostIds,
  subjectsByHost,
  onToggleHost,
  matchCount,
  totalCount,
  showCount = false,
  viewMode,
  onViewModeChange,
  disableListView = false,
  divergingOnly,
  onDivergingOnlyChange,
  supportFilter,
  onSupportFilterChange,
  showDescriptions,
  onShowDescriptionsChange,
  descriptionsDisabled = false,
  disabled = false,
  themeMode = "light",
  mobileOptimized = false,
}: HostCompareSelectorProps) {
  const selectedSet = new Set(selectedHostIds);
  const inlineHosts = hosts.slice(0, INLINE_CHIP_LIMIT);
  const overflowHosts = hosts.slice(INLINE_CHIP_LIMIT);
  const showMobileViewMode =
    mobileOptimized && viewMode !== undefined && onViewModeChange !== undefined;

  return (
    <div
      className={cn(
        "mb-4 flex flex-wrap items-center gap-2",
        mobileOptimized && "min-w-0"
      )}
    >
      {inlineHosts.map((host) => (
        <HostCompareChip
          key={host.hostId}
          host={host}
          subject={subjectsByHost[host.hostId]}
          selected={selectedSet.has(host.hostId)}
          onToggle={() => onToggleHost(host.hostId)}
          disabled={disabled}
          themeMode={themeMode}
        />
      ))}

      {overflowHosts.length > 0 ? (
        <HostCompareOverflowMenu
          hosts={overflowHosts}
          selectedSet={selectedSet}
          subjectsByHost={subjectsByHost}
          onToggleHost={onToggleHost}
          disabled={disabled}
          themeMode={themeMode}
        />
      ) : null}

      {showMobileViewMode ? (
        <>
          {showCount && matchCount !== undefined && totalCount !== undefined ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {matchCount} / {totalCount} fields
            </span>
          ) : null}
          <div
            role="group"
            aria-label="View mode"
            className="flex shrink-0 items-center gap-0.5 rounded-full border border-border p-0.5"
          >
            {(
              [
                { value: "table", label: "Tables" },
                { value: "list", label: "List" },
              ] as const
            ).map((v) => {
              const active = viewMode === v.value;
              const viewModeDisabled =
                disabled || (v.value === "list" && disableListView);
              return (
                <button
                  key={v.value}
                  type="button"
                  aria-pressed={active}
                  disabled={viewModeDisabled}
                  title={
                    viewModeDisabled
                      ? "Turn descriptions off before switching to list view"
                      : undefined
                  }
                  data-testid={`compare-view-${v.value}`}
                  onClick={() => onViewModeChange(v.value)}
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-[11px] transition-colors",
                    "disabled:cursor-not-allowed disabled:opacity-40",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                    active
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {v.label}
                </button>
              );
            })}
          </div>
        </>
      ) : null}

      <div
        className={cn(
          "ml-auto flex items-center gap-4",
          mobileOptimized &&
            "ml-0 min-w-0 w-full flex-wrap gap-2 sm:ml-auto sm:w-auto sm:flex-nowrap sm:gap-4"
        )}
      >
        <div
          role="group"
          aria-label="Filter by support level"
          className={cn(
            "flex items-center gap-0.5 rounded-full border border-border p-0.5",
            mobileOptimized &&
              "max-w-full overflow-x-auto [-webkit-overflow-scrolling:touch]"
          )}
        >
          {SUPPORT_FILTERS.map((f) => {
            const active = supportFilter === f.value;
            return (
              <button
                key={f.value}
                type="button"
                disabled={disabled}
                title={f.title}
                aria-pressed={active}
                data-testid={`support-filter-${f.value}`}
                onClick={() => onSupportFilterChange(f.value)}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-[11px] transition-colors",
                  mobileOptimized && "shrink-0",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  active
                    ? "bg-primary/10 text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        <label
          className={cn(
            "flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground",
            (disabled || descriptionsDisabled) &&
              "cursor-not-allowed opacity-40",
            mobileOptimized && "shrink-0"
          )}
          title={
            descriptionsDisabled
              ? "Descriptions are available in table view"
              : undefined
          }
        >
          <Switch
            checked={showDescriptions}
            disabled={disabled || descriptionsDisabled}
            onCheckedChange={onShowDescriptionsChange}
            aria-label="Show field descriptions"
          />
          <span>Descriptions</span>
        </label>
        <label
          className={cn(
            "flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground",
            disabled && "cursor-not-allowed opacity-40",
            mobileOptimized && "shrink-0"
          )}
        >
          <Switch
            checked={divergingOnly}
            disabled={disabled}
            onCheckedChange={onDivergingOnlyChange}
            aria-label="Show only diverging fields"
          />
          <span>Only diverging</span>
        </label>
      </div>
    </div>
  );
}

function HostCompareChip({
  host,
  subject,
  selected,
  onToggle,
  disabled,
  themeMode,
}: {
  host: HostListItem;
  subject?: HostComparisonSubject;
  selected: boolean;
  onToggle: () => void;
  disabled?: boolean;
  themeMode: HostThemeMode;
}) {
  const logoSrc =
    subject !== undefined
      ? getChatboxHostLogo(
          subject.hostStyle,
          subject.config.chatUiOverride,
          themeMode
        )
      : null;
  const reduceMotion = useReducedMotion();

  return (
    <motion.button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      data-testid={`host-compare-chip-${host.hostId}`}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "inline-flex max-w-[180px] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]",
        "transition-colors duration-150",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        selected
          ? "border-primary/35 bg-primary/8 text-foreground shadow-xs"
          : "border-border bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground"
      )}
      whileHover={reduceMotion || disabled ? undefined : { scale: 1.04 }}
      whileTap={reduceMotion || disabled ? undefined : { scale: 0.94 }}
      animate={reduceMotion ? undefined : { y: selected ? -1 : 0 }}
      transition={{ type: "spring", stiffness: 480, damping: 28, mass: 0.5 }}
      onClick={onToggle}
    >
      {logoSrc ? (
        <img
          src={logoSrc}
          alt=""
          className="size-3.5 shrink-0 object-contain"
        />
      ) : (
        <span aria-hidden className="size-3.5 shrink-0 rounded-full bg-muted" />
      )}
      <span className="truncate">{host.name}</span>
    </motion.button>
  );
}

function HostCompareOverflowMenu({
  hosts,
  selectedSet,
  subjectsByHost,
  onToggleHost,
  disabled,
  themeMode,
}: {
  hosts: ReadonlyArray<HostListItem>;
  selectedSet: ReadonlySet<string>;
  subjectsByHost: Readonly<Record<string, HostComparisonSubject>>;
  onToggleHost: (hostId: string) => void;
  disabled?: boolean;
  themeMode: HostThemeMode;
}) {
  const selectedOverflowCount = hosts.filter((h) =>
    selectedSet.has(h.hostId)
  ).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-7 gap-1 rounded-full px-2.5 text-[12px]"
          data-testid="host-compare-overflow-trigger"
        >
          More
          {selectedOverflowCount > 0 ? (
            <span className="text-muted-foreground">
              ({selectedOverflowCount})
            </span>
          ) : null}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[240px] p-0">
        <Command shouldFilter>
          <CommandInput placeholder="Search hosts" />
          <CommandList>
            <CommandEmpty>No matching hosts.</CommandEmpty>
            {hosts.map((host) => {
              const selected = selectedSet.has(host.hostId);
              const subject = subjectsByHost[host.hostId];
              const logoSrc =
                subject !== undefined
                  ? getChatboxHostLogo(
                      subject.hostStyle,
                      subject.config.chatUiOverride,
                      themeMode
                    )
                  : null;

              return (
                <CommandItem
                  key={host.hostId}
                  value={`${host.name} ${host.hostId}`}
                  onSelect={() => onToggleHost(host.hostId)}
                  data-testid={`host-compare-overflow-${host.hostId}`}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    {logoSrc ? (
                      <img
                        src={logoSrc}
                        alt=""
                        className="size-3.5 shrink-0 object-contain"
                      />
                    ) : (
                      <span
                        aria-hidden
                        className="size-3.5 shrink-0 rounded-full bg-muted"
                      />
                    )}
                    <span className="truncate">{host.name}</span>
                  </span>
                  <span
                    className={cn(
                      "text-[11px]",
                      selected ? "text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {selected ? "Shown" : "Hidden"}
                  </span>
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
