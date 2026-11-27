import { useId, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@mcpjam/design-system/cn";
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
import type { HostListItem } from "@/hooks/useClients";
import { clientDisplayName } from "@/lib/client-display-name";
import { resolveHostLogo } from "@/lib/host-logo";
import { HostChipLogo } from "@/components/hosts/host-chip";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

interface ClientMultiSelectProps {
  hosts: ReadonlyArray<HostListItem>;
  value: ReadonlyArray<string>;
  onChange: (hostIds: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  triggerId?: string;
  /** Render the list in place, for use inside a modal Dialog. */
  inModal?: boolean;
}

export function ClientMultiSelect({
  hosts,
  value,
  onChange,
  placeholder = "Select clients",
  disabled,
  triggerId,
  inModal,
}: ClientMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const selectionId = useId();
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const selected = new Set(value);
  const selectedHosts = hosts.filter((host) => selected.has(host.hostId));

  const toggle = (hostId: string) => {
    onChange(
      selected.has(hostId)
        ? value.filter((id) => id !== hostId)
        : [...value, hostId],
    );
  };

  const label =
    selectedHosts.length === 0
      ? placeholder
      : selectedHosts.length === 1
        ? clientDisplayName(selectedHosts[0])
        : `${clientDisplayName(selectedHosts[0])} +${selectedHosts.length - 1}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={triggerId}
          disabled={disabled}
          aria-describedby={selectionId}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50"
          data-testid="client-multi-select-trigger"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selectedHosts.slice(0, 3).map((host, index) => (
              <HostChipLogo
                key={host.hostId}
                logoSrc={resolveHostLogo(host, themeMode)}
                name={clientDisplayName(host)}
                size="sm"
                className={index > 0 ? "max-sm:hidden" : undefined}
              />
            ))}
            <span
              className={cn(
                "truncate",
                selectedHosts.length === 0 && "text-muted-foreground",
              )}
            >
              {label}
            </span>
          </span>
          <span id={selectionId} className="sr-only">
            {selectedHosts.length === 0
              ? placeholder
              : selectedHosts.map(clientDisplayName).join(", ")}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
        portalled={!inModal}
      >
        <Command>
          <CommandInput placeholder="Search clients" />
          <CommandList>
            <CommandEmpty>No clients match.</CommandEmpty>
            {hosts.map((host) => {
              const isSelected = selected.has(host.hostId);
              return (
                <CommandItem
                  key={host.hostId}
                  value={`${clientDisplayName(host)} ${host.hostId}`}
                  onSelect={() => toggle(host.hostId)}
                  aria-checked={isSelected}
                  className="cursor-pointer gap-2 rounded-sm px-2 py-1"
                  data-testid={`client-multi-select-option-${host.hostId}`}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-[background-color,border-color] duration-200",
                      isSelected
                        ? "border-primary bg-primary shadow-sm"
                        : "border-border/60 bg-transparent",
                    )}
                  >
                    {isSelected ? (
                      <Check
                        strokeWidth={3}
                        className="size-2.5 text-primary-foreground"
                      />
                    ) : null}
                  </span>
                  <HostChipLogo
                    logoSrc={resolveHostLogo(host, themeMode)}
                    name={clientDisplayName(host)}
                    size="sm"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {clientDisplayName(host)}
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
