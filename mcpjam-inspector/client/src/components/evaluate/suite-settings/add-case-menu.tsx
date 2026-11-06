import { Fragment, useEffect, useRef, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import type { AddCaseItem } from "./suite-cases-card";

/** How long a pointer rests on an item before its description shows. */
export const ADD_CASE_HINT_DELAY_MS = 2000;

/** Add case: Describe, Generate, Import and Add manually, with slow hints. */
export function AddCaseMenu({
  items,
  generateDisabledReason,
}: {
  items: AddCaseItem[];
  generateDisabledReason?: string;
}) {
  const [hinted, setHinted] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const stopHint = () => {
    window.clearTimeout(timer.current);
    setHinted(null);
  };
  const startHint = (label: string) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () => setHinted(label),
      ADD_CASE_HINT_DELAY_MS,
    );
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <DropdownMenu onOpenChange={(open) => (open ? null : stopHint())}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          className="h-8 gap-1.5"
          data-testid="suite-settings-add-case"
        >
          <Plus className="size-3.5" aria-hidden /> Add case
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {items.map((item) => (
          <Fragment key={item.label}>
            <DropdownMenuItem
              disabled={item.disabled}
              onSelect={item.onSelect}
              onMouseEnter={() => startHint(item.label)}
              onMouseLeave={stopHint}
              data-testid={`suite-settings-add-case-${item.label
                .toLowerCase()
                .replace(/\s+/g, "-")}`}
            >
              {hinted === item.label ? (
                <span className="flex max-w-64 flex-col gap-0.5">
                  {item.busyLabel ?? item.label}
                  <span className="text-xs leading-snug text-muted-foreground">
                    {item.description}
                  </span>
                </span>
              ) : (
                (item.busyLabel ?? item.label)
              )}
            </DropdownMenuItem>
            {item.label === "Generate" &&
            item.disabled &&
            generateDisabledReason ? (
              <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">
                {generateDisabledReason}
              </p>
            ) : null}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
