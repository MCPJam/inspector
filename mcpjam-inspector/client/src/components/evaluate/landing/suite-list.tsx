import { useMemo, useState } from "react";
import { ArrowUpDown, ChevronDown, Search } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { Input } from "@mcpjam/design-system/input";
import type { EvalSuite, EvalSuiteOverviewEntry } from "../../evals/types";
import { SuiteListRunReview } from "../suite-list-run-review";
import { SuiteCard } from "./suite-card";
import {
  buildSuiteRows,
  SUITE_SORTS,
  type SuiteSort,
} from "./suite-list-model";
import type { useQuotaGuardedRerun } from "../use-quota-guarded-rerun";

interface SuiteListProps {
  projectId: string | null;
  suites: readonly EvalSuiteOverviewEntry[];
  run: Pick<
    ReturnType<typeof useQuotaGuardedRerun>,
    "rerun" | "disabledReason"
  >;
  rerunningSuiteId: string | null;
  onOpenSuite: (suiteId: string) => void;
  onOpenRun: (target: { suiteId: string; runId: string }) => void;
  onOpenSettings: (suiteId: string) => void;
}

/** The Suites tab: search, sort, a card per suite, and the run review a card's Run opens. */
export function SuiteList({
  projectId,
  suites,
  run,
  rerunningSuiteId,
  onOpenSuite,
  onOpenRun,
  onOpenSettings,
}: SuiteListProps) {
  const [sort, setSort] = useState<SuiteSort>("recent");
  const [query, setQuery] = useState("");
  const [reviewSuite, setReviewSuite] = useState<EvalSuite | null>(null);
  const rows = useMemo(
    () => buildSuiteRows(suites, sort, query),
    [suites, sort, query],
  );
  const sortLabel = SUITE_SORTS.find((o) => o.value === sort)?.label;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-6 sm:px-6"
      data-testid="evals-suites-landing"
    >
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="All suites"
            aria-label="Search suites"
            className="h-8 pl-8 text-sm"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              aria-label={`Sort suites by ${sortLabel}`}
            >
              <ArrowUpDown className="size-3.5" aria-hidden />
              <span>
                <span className="text-muted-foreground">Sort:</span> {sortLabel}
              </span>
              <ChevronDown
                className="size-3.5 text-muted-foreground"
                aria-hidden
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={sort}
              onValueChange={(value) => {
                const next = SUITE_SORTS.find((o) => o.value === value);
                if (next) setSort(next.value);
              }}
            >
              {SUITE_SORTS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {rows.length ? (
        <ul className="flex flex-col gap-3" aria-label="Suites">
          {rows.map(({ entry, slice }) => (
            <SuiteCard
              key={entry.suite._id}
              entry={entry}
              slice={slice}
              running={rerunningSuiteId === entry.suite._id}
              onRun={() => setReviewSuite(entry.suite)}
              onOpenSuite={onOpenSuite}
              onOpenRun={onOpenRun}
              onOpenSettings={onOpenSettings}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No suites match “{query.trim()}”.
        </p>
      )}
      {reviewSuite ? (
        <SuiteListRunReview
          key={reviewSuite._id}
          projectId={projectId}
          suite={reviewSuite}
          onClose={() => setReviewSuite(null)}
          onStart={run.rerun}
          onEditSettings={() => {
            setReviewSuite(null);
            onOpenSettings(reviewSuite._id);
          }}
          disabledReason={run.disabledReason}
        />
      ) : null}
    </div>
  );
}
