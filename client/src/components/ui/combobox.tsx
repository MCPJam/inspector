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

export interface ComboboxItem {
  value: string;
  label: string;
  description?: string;
}

interface ComboboxProps {
  items: ComboboxItem[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  className?: string;
  value?: string | string[];
  onValueChange?: (value: any) => void;
  multiSelect?: boolean;
  label?: string;
}

export function Combobox({
  items,
  placeholder = "Select item...",
  searchPlaceholder = "Search...",
  emptyMessage = "No item found.",
  className,
  value,
  onValueChange,
  multiSelect = true,
  label = "Model",
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [internalValue, setInternalValue] = React.useState<string | string[]>(
    multiSelect ? [] : "",
  );

  const currentValue = value !== undefined ? value : internalValue;
  const setValue = (newValue: string | string[]) => {
    if (onValueChange) {
      onValueChange(newValue);
    } else {
      setInternalValue(newValue);
    }
  };

  const getDisplayValue = () => {
    if (multiSelect) {
      const val = currentValue as string[];
      if (val && val.length > 0) {
        return val.length === 1
          ? `1 ${label} Selected`
          : `${val.length} ${label}s Selected`;
      }
      return placeholder;
    } else {
      const val = currentValue as string;
      if (val) {
        const item = items.find((i) => i.value === val);
        return item ? item.label : val;
      }
      return placeholder;
    }
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
              const isSelected = multiSelect
                ? (currentValue as string[]).includes(item.value)
                : currentValue === item.value;

              return (
                <CommandItem
                  key={item.value}
                  value={item.value}
                  onSelect={(_) => {
                    if (multiSelect) {
                      const currentArray = (currentValue as string[]) || [];
                      const newSelection = currentArray.includes(item.value)
                        ? currentArray.filter((v) => v !== item.value)
                        : [...currentArray, item.value];
                      setValue(newSelection);
                    } else {
                      setValue(item.value);
                      setOpen(false);
                    }
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
