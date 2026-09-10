import { createContext, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@mcpjam/design-system/sheet";
import {
  SYNTHETIC_MONITOR_KINDS,
  type PredicateKind,
} from "@/shared/predicate-kinds";
import {
  ADD_SECTIONS,
  EVAL_ADD_CATALOG,
  type EvalAddChoice,
  type EvalAddEntry,
} from "@/components/evals/eval-add-catalog";
export const AssertionDrawerContainer = createContext<HTMLElement | null>(null);

export function EvalAddDrawer({
  onSelect,
  authorableKinds,
  kinds,
  className,
  triggerLabel = "Add",
  wholeRunOnly = false,
  allowWidgetChecks = true,
  onOutcomeFocus,
}: {
  onSelect: (choice: EvalAddChoice) => void;
  authorableKinds?: readonly PredicateKind[];
  kinds?: readonly PredicateKind[];
  className?: string;
  triggerLabel?: string;
  wholeRunOnly?: boolean;
  allowWidgetChecks?: boolean;
  onOutcomeFocus?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const outcomeSelected = useRef(false);
  const monitors = useFeatureFlagEnabled("synthetic-monitors");
  const reason = (item: EvalAddEntry) => {
    if (item.choice.kind !== "check") return undefined;
    const kind = item.choice.predicateKind;
    if (SYNTHETIC_MONITOR_KINDS.has(kind) && !monitors)
      return "Requires synthetic monitors";
    return undefined;
  };
  const entries = EVAL_ADD_CATALOG.filter((item) => {
    if (
      wholeRunOnly &&
      item.choice.kind !== "check" &&
      !(allowWidgetChecks && item.choice.kind === "widget-check")
    )
      return false;
    if (
      kinds &&
      item.choice.kind === "check" &&
      !kinds.includes(item.choice.predicateKind)
    )
      return false;
    return `${item.label} ${item.section} ${item.key} ${item.scope === "whole-run" || wholeRunOnly ? "After the run" : "After this action"} ${item.advisory ? "Warn Report" : ""} ${reason(item) ?? ""}`
      .toLowerCase()
      .includes(search.trim().toLowerCase());
  });
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSearch("");
      }}
    >
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={`gap-1.5 border-dashed ${className ?? ""}`}
          aria-label={triggerLabel}
        >
          <Plus className="size-3.5" aria-hidden />
          {triggerLabel}
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="w-full gap-0 bg-popover text-popover-foreground sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          if (outcomeSelected.current) {
            event.preventDefault();
            outcomeSelected.current = false;
            onOutcomeFocus?.();
          }
        }}
      >
        <SheetHeader className="shrink-0 pr-12">
          <SheetTitle>Add actions and checks</SheetTitle>
          <SheetDescription>
            Choose what happens next or what this test verifies.
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-3">
          <Input
            autoFocus
            aria-label="Filter steps and checks"
            placeholder="Search all actions and checks…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="bg-popover"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-5 px-4 pb-4">
          {ADD_SECTIONS.map((section) => {
            const items = entries.filter((entry) => entry.section === section);
            if (!items.length) return null;
            return (
              <section key={section} aria-label={section}>
                <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
                  {section}
                </h3>
                <div className="space-y-1">
                  {items.map((item) => {
                    const disabledReason = reason(item);
                    return (
                      <div key={item.key}>
                        <button
                          type="button"
                          disabled={
                            !!disabledReason ||
                            (item.choice.kind === "check" &&
                              !!authorableKinds &&
                              !authorableKinds.includes(
                                item.choice.predicateKind,
                              ))
                          }
                          data-testid={`add-step-item-${item.key}`}
                          onClick={() => {
                            outcomeSelected.current =
                              item.choice.kind === "outcome";
                            setOpen(false);
                            if (!outcomeSelected.current) onSelect(item.choice);
                          }}
                          className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-ring disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <item.Icon
                            className={`mt-0.5 size-4 shrink-0 ${item.choice.kind === "step" ? "text-destructive" : "text-success"}`}
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">
                              {item.label}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {disabledReason ??
                                (item.scope === "outcome"
                                  ? "Edit the existing expected outcome"
                                  : item.choice.kind === "step"
                                    ? "Add an action to the sequence"
                                    : item.choice.kind === "widget-check"
                                      ? "Check the live view at this point"
                                      : wholeRunOnly ||
                                          item.scope === "whole-run"
                                        ? "After the run"
                                        : "After this action")}
                              {item.advisory ? " · Warn or Report only" : ""}
                            </span>
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {!entries.length && (
            <p className="py-4 text-sm text-muted-foreground">
              No matching actions or checks.
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
