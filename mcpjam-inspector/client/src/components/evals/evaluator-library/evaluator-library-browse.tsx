import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  CircleAlert,
  Library,
  MessageSquare,
  Search,
  Server,
  Shield,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useId, useRef } from "react";
import { CUSTOM_JUDGE_COST_COPY } from "./custom-judges-model";
import { EvaluatorCard } from "./evaluator-card";
import {
  builtFrom,
  isInSuite,
  type LibraryEvaluator,
  type LibrarySuiteParts,
} from "./library-catalog";

type CategoryId = LibraryEvaluator["category"];

// Keyed by every category, so a new one cannot be left out of the library.
const CATEGORIES: Record<
  CategoryId,
  { id: CategoryId; label: string; icon: LucideIcon }
> = {
  "tool-calls": { id: "tool-calls", label: "Calling tools", icon: Wrench },
  "final-answer": {
    id: "final-answer",
    label: "Final answer",
    icon: MessageSquare,
  },
  "tool-errors": { id: "tool-errors", label: "Tool errors", icon: CircleAlert },
  "server-output": {
    id: "server-output",
    label: "Server output",
    icon: Server,
  },
  security: { id: "security", label: "Security", icon: Shield },
};

type Category = CategoryId | "all";
export type LibraryFilters = { category: Category; search: string };

export function EvaluatorLibraryBrowse({
  evaluators,
  suite,
  filters,
  onFiltersChange,
  onOpen,
  onAdd,
  getAddDisabledReason,
}: {
  evaluators: LibraryEvaluator[];
  suite: LibrarySuiteParts;
  filters: LibraryFilters;
  onFiltersChange: (filters: LibraryFilters) => void;
  onOpen: (id: string) => void;
  onAdd: (evaluator: LibraryEvaluator) => void;
  getAddDisabledReason: (evaluator: LibraryEvaluator) => string | undefined;
}) {
  const searchId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const { category, search } = filters;
  // A new query shows its results from the top. Returning from preset details
  // changes no query, so the place in the list is kept.
  const setSearch = (next: string) => {
    if (resultsRef.current) resultsRef.current.scrollTop = 0;
    onFiltersChange({ category, search: next });
  };
  const query = search.trim().toLowerCase();
  const groups = Object.values(CATEGORIES)
    .map((group) => {
      const entries = evaluators.filter((entry) => entry.category === group.id);
      return {
        ...group,
        available: entries.length > 0,
        matches: entries.filter((entry) =>
          [
            entry.name,
            entry.question,
            group.label,
            ...builtFrom(entry).map((part) => part.label),
          ].some((value) => value.toLowerCase().includes(query)),
        ),
      };
    })
    .filter((group) => group.available);
  const all = category === "all";
  const activeGroup = groups.find((group) => group.id === category);
  const visible = all
    ? groups
    : groups.filter((group) => group.id === category);
  const total = groups.reduce((sum, group) => sum + group.matches.length, 0);
  const nav = [
    {
      id: "all" as const,
      label: "All evaluators",
      icon: Library,
      count: total,
    },
    ...groups.map((group) => ({ ...group, count: group.matches.length })),
  ];
  return (
    <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] sm:grid-cols-[10.5rem_minmax(0,1fr)] sm:grid-rows-1">
      <div
        role="group"
        aria-label="Evaluator categories"
        className="flex gap-1 overflow-x-auto border-b border-border bg-muted/30 p-2 sm:flex-col sm:overflow-y-auto sm:border-r sm:border-b-0 sm:p-3"
      >
        {nav.map(({ id, label, icon: Icon, count }) => (
          <Button
            key={id}
            type="button"
            variant={category === id ? "secondary" : "ghost"}
            aria-pressed={category === id}
            size="sm"
            className="shrink-0 justify-start gap-2 px-2 sm:w-full"
            onClick={() => onFiltersChange({ category: id, search })}
          >
            <Icon aria-hidden />
            {label}
            <span
              aria-hidden
              className="ml-auto text-xs tabular-nums text-muted-foreground"
            >
              {count}
            </span>
          </Button>
        ))}
      </div>
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
          <h3 className="text-sm font-semibold">
            {activeGroup?.label ?? "All evaluators"}
          </h3>
          <div className="relative w-full sm:w-56">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground"
            />
            <label htmlFor={searchId} className="sr-only">
              Search presets
            </label>
            <Input
              ref={searchRef}
              id={searchId}
              type="search"
              placeholder="Search presets…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-8"
            />
          </div>
        </div>
        <div
          ref={resultsRef}
          key={category}
          className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5"
        >
          {query && visible.every((group) => !group.matches.length) ? (
            <div className="rounded-lg border border-border px-4 py-6 text-center">
              <p role="status" className="text-sm text-muted-foreground">
                No presets match your search.
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-1"
                onClick={() => {
                  setSearch("");
                  searchRef.current?.focus();
                }}
              >
                Clear search
              </Button>
            </div>
          ) : null}
          {visible
            .filter((group) => group.matches.length > 0)
            .map((group) => (
              // Card titles are the h4s under this view's h3; a group's
              // label names its section without taking a heading level.
              <section
                key={group.id}
                aria-label={group.label}
                className="space-y-2"
              >
                {all ? (
                  <p
                    aria-hidden
                    className="text-sm font-medium text-muted-foreground"
                  >
                    {group.label}
                  </p>
                ) : null}
                <div className="grid gap-2.5 md:grid-cols-2">
                  {group.matches.map((evaluator) => (
                    <EvaluatorCard
                      key={evaluator.id}
                      name={evaluator.name}
                      question={evaluator.question}
                      icon={evaluator.icon}
                      tone={evaluator.tone}
                      builtFrom={builtFrom(evaluator)}
                      note={
                        evaluator.judges?.length
                          ? CUSTOM_JUDGE_COST_COPY
                          : undefined
                      }
                      inSuite={isInSuite(evaluator, suite)}
                      onOpen={() => onOpen(evaluator.id)}
                      onAdd={() => onAdd(evaluator)}
                      addDisabledReason={getAddDisabledReason(evaluator)}
                    />
                  ))}
                </div>
              </section>
            ))}
        </div>
      </div>
    </div>
  );
}
