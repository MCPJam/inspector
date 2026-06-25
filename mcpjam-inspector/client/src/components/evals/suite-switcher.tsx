import { useMemo, useState } from "react";
import { Check, ChevronDown, Plus, Search, Trash2 } from "lucide-react";
import { Input } from "@mcpjam/design-system/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { cn } from "@/lib/utils";
import type { EvalSuite, EvalSuiteOverviewEntry } from "./types";
import {
  formatOverviewRelativeTime,
  getSuitePassFailCounts,
  stripTimestampSuffix,
} from "./suite-overview-presentation";

interface SuiteSwitcherProps {
  suites: EvalSuiteOverviewEntry[];
  currentSuiteId: string;
  onSelectSuite: (suiteId: string) => void;
  onCreateSuite: () => void;
  onDeleteSuite?: (suite: EvalSuite) => void;
}

/**
 * Breadcrumb "Suites" label rendered as a dropdown — switching suites lives
 * here instead of a standalone list page. Search, jump, and create from one place.
 */
export function SuiteSwitcher({
  suites,
  currentSuiteId,
  onSelectSuite,
  onCreateSuite,
  onDeleteSuite,
}: SuiteSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const current = suites.find((e) => e.suite._id === currentSuiteId) ?? null;
  const currentName = current
    ? stripTimestampSuffix(current.suite.name || "") || "Untitled suite"
    : "Suite";

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return suites;
    return suites.filter((e) =>
      (e.suite.name || "").toLowerCase().includes(q),
    );
  }, [suites, search]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex max-w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          title={`Switch suite (current: ${currentName})`}
          aria-label={`Switch suite (current: ${currentName})`}
        >
          <span>Suites</span>
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 transition-transform",
              open && "rotate-180",
            )}
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1.5">
        {suites.length > 6 ? (
          <div className="relative mb-1.5">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              autoFocus
              type="search"
              placeholder="Switch suite…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-full pl-8 text-xs"
              aria-label="Search suites"
            />
          </div>
        ) : null}
        <div className="max-h-72 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              No suites match.
            </p>
          ) : (
            filtered.map((entry) => {
              const id = entry.suite._id;
              const isActive = id === currentSuiteId;
              const counts = getSuitePassFailCounts(entry);
              const name =
                stripTimestampSuffix(entry.suite.name || "") ||
                "Untitled suite";
              return (
                <div
                  key={id}
                  className={cn(
                    "group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 transition-colors",
                    isActive ? "bg-primary/[0.06]" : "hover:bg-muted/60",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      setSearch("");
                      if (!isActive) onSelectSuite(id);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus:outline-none"
                  >
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-foreground text-[11px] font-semibold uppercase text-background">
                      {name.slice(0, 1)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-foreground">
                        {name}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {entry.latestRun
                          ? formatOverviewRelativeTime(
                              entry.latestRun.completedAt ??
                                entry.latestRun.createdAt,
                            )
                          : "No runs yet"}
                      </span>
                    </span>
                  </button>
                  {counts ? (
                    <span
                      className={cn(
                        "shrink-0 font-mono text-[11px] font-semibold tabular-nums",
                        counts.passed >= counts.total
                          ? "text-success"
                          : counts.passed === 0
                            ? "text-destructive"
                            : "text-amber-600 dark:text-amber-400",
                      )}
                    >
                      {counts.passed}/{counts.total}
                    </span>
                  ) : null}
                  {isActive ? (
                    <Check className="h-4 w-4 shrink-0 text-primary" />
                  ) : null}
                  {onDeleteSuite ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(false);
                        setSearch("");
                        onDeleteSuite(entry.suite);
                      }}
                      className="shrink-0 rounded p-1 text-muted-foreground/50 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:text-destructive focus-visible:outline-none group-hover:opacity-100"
                      aria-label={`Delete suite ${name}`}
                      title="Delete suite"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
        <div className="mt-1 border-t border-border/50 pt-1">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onCreateSuite();
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-md border border-dashed border-border">
              <Plus className="h-3.5 w-3.5" />
            </span>
            New suite
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
