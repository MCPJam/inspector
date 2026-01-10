"use client";

import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ComboboxItem } from "./combobox";

interface ComboboxMultiSelectProps {
  items: ComboboxItem[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  className?: string;
  value?: string[];
  onValueChange?: (value: string[]) => void;
  label?: string;
}

export function ComboboxMultiSelect({
  items,
  placeholder = "Select item...",
  searchPlaceholder = "Search...",
  emptyMessage = "No item found.",
  className,
  value,
  onValueChange,
  label = "Model",
}: ComboboxMultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [internalValue, setInternalValue] = React.useState<string[]>([]);

  const currentValue = value !== undefined ? value : internalValue;
  const setValue = (newValue: string[]) => {
    if (onValueChange) {
      onValueChange(newValue);
    } else {
      setInternalValue(newValue);
    }
  };

  const getDisplayValue = () => {
    const val = currentValue;
    if (val && val.length > 0) {
      return val.length === 1
        ? `1 ${label} Selected`
        : `${val.length} ${label}s Selected`;
    }
    return placeholder;
  };

  return (
    <Popover open={open} onOpenChange={setOpen} modal={true}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("w-[200px] justify-between bg-background", className)}
        >
          <span className="truncate">{getDisplayValue()}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} className="h-9" />
          <CommandEmpty>{emptyMessage}</CommandEmpty>
          <CommandGroup className="max-h-48 overflow-auto">
            {items.map((item) => {
              const isSelected = currentValue.includes(item.value);

              return (
                <CommandItem
                  key={item.value}
                  value={item.value}
                  onSelect={(_) => {
                    const currentArray = currentValue || [];
                    const newSelection = currentArray.includes(item.value)
                      ? currentArray.filter((v) => v !== item.value)
                      : [...currentArray, item.value];
                    setValue(newSelection);
                  }}
                >
                  <div className="flex flex-col">
                    <span>{item.label}</span>
                    {item.description && (
                      <span className="text-xs text-muted-foreground">
                        {item.description}
                      </span>
                    )}
                  </div>
                  <Check
                    className={cn(
                      "ml-auto h-4 w-4",
                      isSelected ? "opacity-100" : "opacity-0",
                    )}
                  />
                </CommandItem>
              );
            })}
          </CommandGroup>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
