import { ChevronDown } from "lucide-react";
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

const INLINE_CHIP_LIMIT = 6;

interface HostCompareSelectorProps {
  hosts: ReadonlyArray<HostListItem>;
  selectedHostIds: ReadonlyArray<string>;
  subjectsByHost: Readonly<Record<string, HostComparisonSubject>>;
  onToggleHost: (hostId: string) => void;
  divergingOnly: boolean;
  onDivergingOnlyChange: (enabled: boolean) => void;
  disabled?: boolean;
}

export function HostCompareSelector({
  hosts,
  selectedHostIds,
  subjectsByHost,
  onToggleHost,
  divergingOnly,
  onDivergingOnlyChange,
  disabled = false,
}: HostCompareSelectorProps) {
  const selectedSet = new Set(selectedHostIds);
  const inlineHosts = hosts.slice(0, INLINE_CHIP_LIMIT);
  const overflowHosts = hosts.slice(INLINE_CHIP_LIMIT);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {inlineHosts.map((host) => (
        <HostCompareChip
          key={host.hostId}
          host={host}
          subject={subjectsByHost[host.hostId]}
          selected={selectedSet.has(host.hostId)}
          onToggle={() => onToggleHost(host.hostId)}
          disabled={disabled}
        />
      ))}

      {overflowHosts.length > 0 ? (
        <HostCompareOverflowMenu
          hosts={overflowHosts}
          selectedSet={selectedSet}
          subjectsByHost={subjectsByHost}
          onToggleHost={onToggleHost}
          disabled={disabled}
        />
      ) : null}

      <label className="ml-auto flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
        <Switch
          checked={divergingOnly}
          onCheckedChange={onDivergingOnlyChange}
          aria-label="Show only diverging fields"
        />
        <span>Only diverging</span>
      </label>
    </div>
  );
}

function HostCompareChip({
  host,
  subject,
  selected,
  onToggle,
  disabled,
}: {
  host: HostListItem;
  subject?: HostComparisonSubject;
  selected: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  const logoSrc =
    subject !== undefined
      ? getChatboxHostLogo(
          subject.hostStyle,
          subject.config.chatUiOverride,
        )
      : null;

  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      data-testid={`host-compare-chip-${host.hostId}`}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "inline-flex max-w-[180px] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "border-primary/35 bg-primary/8 text-foreground shadow-xs"
          : "border-border bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground",
      )}
      onClick={onToggle}
    >
      {logoSrc ? (
        <img src={logoSrc} alt="" className="size-3.5 shrink-0 object-contain" />
      ) : (
        <span
          aria-hidden
          className="size-3.5 shrink-0 rounded-full bg-muted"
        />
      )}
      <span className="truncate">{host.name}</span>
    </button>
  );
}

function HostCompareOverflowMenu({
  hosts,
  selectedSet,
  subjectsByHost,
  onToggleHost,
  disabled,
}: {
  hosts: ReadonlyArray<HostListItem>;
  selectedSet: ReadonlySet<string>;
  subjectsByHost: Readonly<Record<string, HostComparisonSubject>>;
  onToggleHost: (hostId: string) => void;
  disabled?: boolean;
}) {
  const selectedOverflowCount = hosts.filter((h) =>
    selectedSet.has(h.hostId),
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
          <CommandInput placeholder="Search clients" />
          <CommandList>
            <CommandEmpty>No matching clients.</CommandEmpty>
            {hosts.map((host) => {
              const selected = selectedSet.has(host.hostId);
              const subject = subjectsByHost[host.hostId];
              const logoSrc =
                subject !== undefined
                  ? getChatboxHostLogo(
                      subject.hostStyle,
                      subject.config.chatUiOverride,
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
                      selected
                        ? "text-foreground"
                        : "text-muted-foreground",
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
