import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@mcpjam/design-system/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";

export function OrganizationModelPicker({
  id,
  label,
  value,
  suggestions,
  isAzure,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  suggestions: string[];
  isAzure: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const custom = query.trim();
  const select = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          className="w-full min-w-0 justify-between font-normal"
        >
          <span className="truncate">
            {value || (isAzure ? "Choose a deployment" : "Choose a model")}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            aria-label={`Search ${label}`}
            placeholder={
              isAzure ? "Enter a deployment name" : "Search or enter a model ID"
            }
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandGroup>
              {suggestions
                .filter((model) =>
                  model.toLowerCase().includes(custom.toLowerCase()),
                )
                .map((model) => (
                  <CommandItem
                    key={model}
                    value={model}
                    onSelect={() => select(model)}
                  >
                    <span className="min-w-0 flex-1 break-all">{model}</span>
                    {value === model ? (
                      <Check className="size-4 shrink-0" />
                    ) : null}
                  </CommandItem>
                ))}
              {custom && !suggestions.includes(custom) ? (
                <CommandItem value={custom} onSelect={() => select(custom)}>
                  Use {custom}
                </CommandItem>
              ) : null}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
