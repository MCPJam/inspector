import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  ArrowUpRight,
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
import { cn } from "@/lib/utils";
import { CUSTOM_JUDGE_COST_COPY } from "./custom-judges-model";
import { EvaluatorCard } from "./evaluator-card";
import { EVALUATOR_METHODS } from "./evaluator-methods";
import type { EvaluatorMethod } from "./evaluator-library-types";
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
export type MethodAvailability = Record<EvaluatorMethod, string | null>;

export function EvaluatorLibraryBrowse({
  evaluators,
  suite,
  filters,
  onFiltersChange,
  methods,
  onMethod,
  onOpen,
  onAdd,
  getAddDisabledReason,
}: {
  evaluators: LibraryEvaluator[];
  suite: LibrarySuiteParts;
  filters: LibraryFilters;
  onFiltersChange: (filters: LibraryFilters) => void;
  methods: MethodAvailability;
  onMethod: (method: EvaluatorMethod) => void;
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
          {all && !query ? (
            <MethodCards methods={methods} onMethod={onMethod} />
          ) : null}
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

function MethodCards({
  methods,
  onMethod,
}: {
  methods: MethodAvailability;
  onMethod: (method: EvaluatorMethod) => void;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="space-y-2.5 border-b border-border pb-5"
    >
      <h4 id={id} className="text-sm font-semibold">
        Start from scratch
      </h4>
      <div className="grid gap-2.5 md:grid-cols-2">
        {EVALUATOR_METHODS.map(
          ({ value, title, icon: Icon, description, tone }) => {
            const reason = methods[value];
            const titleId = `${id}-${value}`;
            const descriptionId = `${titleId}-description`;
            return (
              <button
                key={value}
                type="button"
                aria-labelledby={titleId}
                aria-describedby={descriptionId}
                disabled={Boolean(reason)}
                onClick={() => onMethod(value)}
                className="flex items-start gap-3 rounded-lg border border-border bg-card p-3 text-left text-card-foreground hover:border-foreground/25 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:hover:border-border disabled:hover:bg-card"
              >
                <span
                  aria-hidden
                  className={cn(
                    "grid size-8 shrink-0 place-items-center rounded-md",
                    reason ? "bg-muted text-muted-foreground" : tone,
                  )}
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span id={titleId} className="block text-sm font-semibold">
                    {title}
                  </span>
                  <span
                    id={descriptionId}
                    className="block text-sm text-muted-foreground"
                  >
                    {reason ?? description}
                  </span>
                </span>
                {reason ? null : (
                  <ArrowUpRight
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                )}
              </button>
            );
          },
        )}
      </div>
    </section>
  );
}
