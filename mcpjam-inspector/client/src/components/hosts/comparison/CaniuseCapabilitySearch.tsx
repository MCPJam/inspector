import { useState } from "react";
import { cn } from "@mcpjam/design-system/cn";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "@mcpjam/design-system/command";
import type { HostConfigFieldDef } from "@/lib/host-config-field-schema";
import { caniuseTitle } from "./caniuse-coverage";
import { fieldMatchesQuery } from "./support-level";

export function matchesCaniuseQuery(field: HostConfigFieldDef, query: string) {
  return (
    fieldMatchesQuery(field, query) ||
    caniuseTitle(field).toLowerCase().includes(query.trim().toLowerCase())
  );
}

export function CaniuseCapabilitySearch({
  fields,
  query,
  onQueryChange,
  hero = false,
}: {
  fields: readonly HostConfigFieldDef[];
  query: string;
  onQueryChange: (query: string) => void;
  hero?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const suggestions = fields
    .filter((field) => matchesCaniuseQuery(field, query))
    .slice(0, 12);
  const expanded = open && suggestions.length > 0;

  return (
    <Command
      label={hero ? "Type a capability" : "Search capabilities"}
      shouldFilter={false}
      className={cn(
        "relative h-auto overflow-visible",
        hero
          ? "min-w-0 max-w-[13em] flex-[1_1_9em] bg-transparent [&_[data-slot=command-input-wrapper]]:h-auto [&_[data-slot=command-input-wrapper]]:border-primary/40 [&_[data-slot=command-input-wrapper]]:px-0 [&_[data-slot=command-input-wrapper]>svg]:hidden"
          : "min-w-28 flex-1 basis-full rounded-md border border-border bg-background sm:basis-40 [&_[data-slot=command-input-wrapper]]:border-b-0",
      )}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          setOpen(false);
        } else if (event.key === "ArrowDown" && !open) {
          setOpen(true);
        } else if (event.key === "Enter" && !expanded) {
          event.preventDefault();
        }
      }}
    >
      <CommandInput
        asChild
        aria-label={hero ? "Type a capability" : "Search capabilities"}
        placeholder={hero ? "type a capability…" : "Search capabilities…"}
        className={hero ? "h-auto rounded-none pb-1 pt-0 text-[length:inherit] font-[weight:inherit] leading-[inherit] tracking-[inherit] text-primary" : undefined}
        value={query}
        onFocus={() => setOpen(true)}
        onValueChange={(value) => {
          onQueryChange(value);
          setOpen(true);
        }}
      >
        <input aria-expanded={expanded} />
      </CommandInput>
      {/* Keep items registered while collapsed so cmdk doesn't reselect during dismissal. */}
      <CommandList
        hidden={!expanded}
        className="absolute inset-x-0 top-full z-40 mt-2 max-h-64 rounded-lg border border-border bg-popover p-1 text-sm font-normal tracking-normal text-popover-foreground shadow-md"
        onMouseDown={(event) => event.preventDefault()}
      >
        {suggestions.map((field) => (
          <CommandItem
            key={field.id}
            value={field.id}
            className="flex-col items-start gap-0.5"
            onSelect={() => {
              onQueryChange(caniuseTitle(field));
              setOpen(false);
            }}
          >
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-semibold">{caniuseTitle(field)}</span>
              <span className="text-[11px] text-muted-foreground">{field.subsection}</span>
            </span>
            {field.description && (
              <span className="text-xs text-muted-foreground">
                {field.description}
              </span>
            )}
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}
