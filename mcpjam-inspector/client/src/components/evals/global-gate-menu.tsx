import { useMemo } from "react";
import type { LucideIcon } from "lucide-react";
import { Bug, Coins, Plus, ShieldCheck } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { cn } from "@/lib/utils";
import type { Predicate } from "@/shared/eval-matching";
import {
  GLOBAL_GATE_CATALOG,
  SYNTHETIC_MONITOR_KINDS,
  type Kind,
} from "./predicate-kind-meta";
import {
  GlobalGateKindInfoHint,
} from "./global-gates-info";

const GATE_ICONS: Partial<Record<Kind, LucideIcon>> = {
  tokenBudgetUnder: Coins,
  noToolErrors: ShieldCheck,
  widgetNoConsoleErrors: Bug,
};

export function AddGlobalGateMenu({
  onAdd,
  className,
}: {
  onAdd: (kind: Predicate["type"]) => void;
  className?: string;
}) {
  const syntheticMonitorsEnabled = useFeatureFlagEnabled("synthetic-monitors");
  const items = useMemo(
    () =>
      GLOBAL_GATE_CATALOG.filter(
        (entry) =>
          syntheticMonitorsEnabled ||
          !SYNTHETIC_MONITOR_KINDS.has(entry.kind),
      ),
    [syntheticMonitorsEnabled],
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-haspopup="dialog"
          aria-label="Add global gate"
          className={cn("h-8 gap-1.5 border-dashed text-xs", className)}
        >
          <Plus className="h-3.5 w-3.5" />
          Add gate…
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-72 p-1">
        <div className="px-2 pb-1.5 pt-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Add global gate
          </span>
        </div>
        <ul className="space-y-0.5">
          {items.map((entry) => {
            const Icon = GATE_ICONS[entry.kind] ?? ShieldCheck;
            return (
              <li
                key={entry.kind}
                className="flex items-center gap-0.5 pr-1"
              >
                <button
                  type="button"
                  data-testid={`add-global-gate-${entry.kind}`}
                  onClick={() => onAdd(entry.kind)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent/50"
                >
                  <Icon
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="text-xs font-medium text-foreground">
                    {entry.label}
                  </span>
                </button>
                <GlobalGateKindInfoHint kind={entry.kind} side="left" />
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
