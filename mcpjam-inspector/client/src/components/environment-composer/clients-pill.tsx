/**
 * Clients slot of the environment composer — the primary fan-out axis.
 *
 * Dashed-pill-plus-popover language shared with the other slots. `max === 1`
 * makes it a single-select (picking replaces the current client and closes),
 * for surfaces that run in exactly one environment.
 */
import { useState } from "react";
import { useConvexAuth } from "convex/react";
import { ChevronDown, Users } from "lucide-react";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  targetProductCapReason,
  type TargetBudgetContext,
} from "@/components/environment-composer/environment-stack";
import { useHostList } from "@/hooks/useClients";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { resolveHostLogoByDisplayName } from "@/lib/scenario-client-style";
import { clientDisplayName } from "@/lib/client-display-name";
import { cn } from "@/lib/utils";

export function ClientsPill({
  projectId,
  value,
  onChange,
  max,
  disabled,
  testId,
  inModal = false,
  budget,
}: {
  projectId: string;
  value: string[];
  onChange: (next: string[]) => void;
  /** Cap on the fan-out. `1` switches the pill to single-select. */
  max: number;
  disabled?: boolean;
  testId?: string;
  /** Product-cap context from the composer. Absent ⇒ `selected.length >= max`. */
  budget?: TargetBudgetContext;
  /**
   * Render the popover INLINE rather than portalled, for callers inside a Radix
   * Dialog — a portalled popover lands outside the dialog, where the modal
   * overlay swallows every click. Same escape hatch, same name, as
   * `EnvironmentPicker` and `ServerGroupPicker`.
   */
  inModal?: boolean;
}) {
  const { isAuthenticated } = useConvexAuth();
  const { hosts, isLoading } = useHostList({ isAuthenticated, projectId });
  const [open, setOpen] = useState(false);

  const single = max === 1;
  const selected = value;
  const selectedHost = hosts.find((item) => item.hostId === selected[0]);
  const triggerLabel =
    selected.length === 0
      ? single
        ? "No client · pick one"
        : "No clients · pick some"
      : selectedHost
        ? clientDisplayName(selectedHost)
        : selected[0].slice(0, 8);
  const extra = selected.length > 1 ? selected.length - 1 : 0;
  const logo =
    selected.length > 0
      ? resolveHostLogoByDisplayName(selectedHost?.name ?? triggerLabel)
      : null;

  const toggle = (hostId: string, checked: boolean) => {
    if (single) {
      // Picking REPLACES rather than being refused by the cap — a single-target
      // surface would otherwise need the user to deselect before reselecting.
      onChange(checked ? [hostId] : []);
      setOpen(false);
      return;
    }
    if (checked) {
      if (selected.includes(hostId) || selected.length >= max) return;
      onChange([...selected, hostId]);
    } else {
      onChange(selected.filter((id) => id !== hostId));
    }
  };

  return (
    <Popover open={open} onOpenChange={(next) => {
        // CLOSE always goes through, even when disabled: a menu open at the
        // moment the strip becomes disabled (a commit starting) would otherwise
        // be stuck open with no way out.
        if (!next || !disabled) setOpen(next);
      }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid={testId}
          aria-label="Clients"
          className={cn(
            "flex h-8 max-w-[260px] shrink-0 items-center gap-1 rounded-full border px-2 text-foreground",
            "outline-none transition-colors",
            selected.length === 0
              ? "border-dashed border-border/60 bg-muted/30 hover:bg-muted/45"
              : "border-border/60 bg-muted/40 hover:bg-muted/60",
            disabled && "cursor-not-allowed opacity-60"
          )}
        >
          {logo ? (
            <img
              src={logo}
              alt=""
              className="size-3.5 shrink-0 rounded-sm object-contain"
            />
          ) : (
            <Users className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {triggerLabel}
          </span>
          {extra > 0 ? (
            <span className="text-[10px] text-muted-foreground">+{extra}</span>
          ) : null}
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 p-1"
        align="start"
        sideOffset={4}
        portalled={!inModal}
      >
        <div className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {single ? "Client" : "Clients"}
        </div>
        {isLoading ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            Loading clients…
          </p>
        ) : hosts.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            No clients in this project yet.
          </p>
        ) : (
          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {hosts.map((host) => {
              const checked = selected.includes(host.hostId);
              const productBlocked =
                !single &&
                !checked &&
                budget != null &&
                (selected.length + 1) * budget.choiceCount > budget.maxTargets;
              const capBlocked =
                !single &&
                !checked &&
                (productBlocked ||
                  (budget == null && selected.length >= max));
              return (
                <Label
                  key={host.hostId}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/30",
                    (capBlocked || disabled) &&
                      "cursor-not-allowed opacity-60 hover:bg-transparent"
                  )}
                  title={
                    productBlocked && budget
                      ? targetProductCapReason(
                          selected.length + 1,
                          budget.choiceCount,
                          budget.maxTargets
                        )
                      : undefined
                  }
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(next) =>
                      toggle(host.hostId, next === true)
                    }
                    disabled={capBlocked || disabled}
                    aria-label={clientDisplayName(host)}
                  />
                  <span className="min-w-0 flex-1 truncate font-normal">
                    {clientDisplayName(host)}
                  </span>
                </Label>
              );
            })}
          </div>
        )}
        <div className="pt-0.5">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigateApp(routePaths.hosts);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
          >
            Manage clients…
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
