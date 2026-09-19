import { Check, ChevronDown } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { OrgIconBadge, ProjectIconBadge } from "../sidebar/context-icon-badges";

export function SettingsContextPicker({
  label,
  value,
  options,
  onValueChange,
}: {
  label: "Organization" | "Project";
  value: string;
  options: readonly { id: string; name: string; icon?: string }[];
  onValueChange: (value: string) => void;
}) {
  const selected = options.find((option) => option.id === value);
  const badge = (option?: (typeof options)[number]) =>
    label === "Organization" ? (
      <OrgIconBadge
        org={option ? { _id: option.id, name: option.name } : undefined}
        size={5}
      />
    ) : (
      <ProjectIconBadge
        icon={option?.icon}
        fallback={option?.name.charAt(0).toUpperCase() ?? "P"}
      />
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          aria-label={label}
          className="mb-1 h-9 w-full justify-start gap-2 px-2 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent"
        >
          {badge(selected)}
          <span className="min-w-0 flex-1 truncate text-left">
            {selected?.name ?? `Select ${label.toLowerCase()}`}
          </span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className="w-[300px] max-w-[calc(100vw-24px)] rounded-xl bg-sidebar p-1.5 shadow-md"
      >
        <DropdownMenuLabel className="px-2 py-2 text-sm">
          {label === "Organization" ? "Organizations" : "Projects"}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={onValueChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.id}
              value={option.id}
              className="gap-3 rounded-md px-2 py-2 [&>span:first-child]:hidden"
            >
              {badge(option)}
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {option.name}
              </span>
              {value === option.id && (
                <Check
                  aria-hidden="true"
                  className="size-4 shrink-0 text-foreground"
                />
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {!options.length && (
          <p className="px-2 py-3 text-sm text-foreground">
            No {label.toLowerCase()}s available.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
