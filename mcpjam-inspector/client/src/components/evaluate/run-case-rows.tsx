/**
 * Test runs: one row per test case in a suite run, with its result on each
 * shown client · model and how many iterations passed. Two small buttons on
 * the right open the test run's page or the test case editor.
 */
import { useState, type ReactNode } from "react";
import { ArrowUpRight, Pencil, Search } from "lucide-react";
import { Input } from "@mcpjam/design-system/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { cn } from "@/lib/utils";
import { InfoHint } from "../evals/global-gates-info";
import type { EvalIteration } from "../evals/types";
import {
  resultCounts,
  type RunResultsMatrixData,
} from "./run-results-matrix-model";

export type TestRunVerdict =
  "passed" | "flaky" | "failed" | "pending" | "cancelled";

/**
 * A test run's verdict against the suite's pass mark: flaky passed the mark
 * but not every time. Cancelled iterations are not failures, so they leave
 * the share; no pass mark counts as 100%.
 */
export function testRunVerdict(
  iterations: readonly EvalIteration[],
  passThreshold: number | null,
): TestRunVerdict | null {
  if (iterations.length === 0) return null;
  const counts = resultCounts(iterations);
  if (counts.pending > 0) return "pending";
  const decided = counts.passed + counts.failed;
  if (decided === 0) return "cancelled";
  if (counts.passed === decided) return "passed";
  return counts.passed / decided >= (passThreshold ?? 1) ? "flaky" : "failed";
}

const VERDICT_WORD: Record<TestRunVerdict, string> = {
  passed: "Pass",
  flaky: "Flaky",
  failed: "Fail",
  pending: "Running",
  cancelled: "Cancelled",
};
const VERDICT_TONE: Record<TestRunVerdict, string> = {
  passed: "text-success",
  flaky: "text-warning",
  failed: "text-destructive",
  pending: "text-pending",
  cancelled: "text-muted-foreground",
};
const VERDICT_RANK: Record<TestRunVerdict, number> = {
  failed: 0,
  flaky: 1,
  pending: 2,
  passed: 3,
  cancelled: 4,
};

const STATUS_FILTERS = [
  { value: "all", label: "All results" },
  { value: "failed", label: "Failed" },
  { value: "flaky", label: "Flaky" },
  { value: "passed", label: "Passed" },
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];
const isStatusFilter = (value: string): value is StatusFilter =>
  STATUS_FILTERS.some((option) => option.value === value);

export const TEST_RUNS_HINT =
  "One row per test case in this run: its result and how many iterations passed. Flaky means it cleared the pass mark but not every time. ↗ opens the test run; ✎ edits the test case.";

type Targets = RunResultsMatrixData["targets"];
type Row = RunResultsMatrixData["rows"][number];

function VerdictCell({
  iterations,
  passThreshold,
}: {
  iterations: readonly EvalIteration[];
  passThreshold: number | null;
}) {
  const verdict = testRunVerdict(iterations, passThreshold);
  if (!verdict) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const passed = resultCounts(iterations).passed;
  const count = `${passed} of ${iterations.length} iterations passed`;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold",
        VERDICT_TONE[verdict],
      )}
      title={count}
      data-testid="test-run-cell"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {VERDICT_WORD[verdict]}
      <span
        className="font-normal tabular-nums text-muted-foreground"
        aria-label={count}
      >
        {passed}/{iterations.length}
      </span>
    </span>
  );
}

/** An icon button whose label slides open to its left on hover or focus. */
function SlideButton({
  label,
  name,
  icon,
  onClick,
}: {
  label: string;
  /** The accessible name; the sliding label is decoration. */
  name: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={name}
      className="group/slide inline-flex h-7 shrink-0 items-center rounded-md border border-border bg-background px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        aria-hidden
        className="max-w-0 overflow-hidden whitespace-nowrap [transition:max-width_200ms_ease,margin-right_200ms_ease] group-hover/slide:mr-1 group-hover/slide:max-w-40 group-focus/slide:mr-1 group-focus/slide:max-w-40 motion-reduce:[transition:none]"
      >
        {label}
      </span>
      {icon}
    </button>
  );
}

export function RunTestRuns({
  rows,
  targets,
  passThreshold,
  onOpen,
  onEdit,
}: {
  rows: RunResultsMatrixData["rows"];
  /** The targets shown: every target, or the one picked on the page. */
  targets: Targets;
  /** 0–1; null counts as 100%. */
  passThreshold: number | null;
  onOpen: (caseKey: string) => void;
  onEdit: (testCaseId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const cellsOf = (row: Row) =>
    targets.map((target) => target.cells.get(row.key) ?? []);
  const verdictOf = (row: Row) =>
    testRunVerdict(cellsOf(row).flat(), passThreshold);
  // A queued run has no iterations yet; its cases still belong on screen.
  const recorded = rows.filter((row) =>
    cellsOf(row).some((items) => items.length > 0),
  );
  const listed = recorded.length > 0 ? recorded : rows;
  const query = search.trim().toLowerCase();
  const rank = (row: Row) => {
    const verdict = verdictOf(row);
    return verdict ? VERDICT_RANK[verdict] : 5;
  };
  const visible = listed
    .filter(
      (row) =>
        row.title.toLowerCase().includes(query) &&
        (status === "all" || verdictOf(row) === status),
    )
    .sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
  const several = targets.length > 1;
  return (
    <section
      aria-label="Test runs"
      data-testid="nav-test-runs"
      className="space-y-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            Test runs
            <InfoHint
              label="About Test runs"
              className="border border-border bg-muted/50"
            >
              {TEST_RUNS_HINT}
            </InfoHint>
          </h3>
          <span className="text-xs tabular-nums text-muted-foreground">
            {listed.length}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-48 max-w-full">
            <Search
              aria-hidden
              className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              className="h-7 w-full pl-8 text-xs"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find a test run…"
              aria-label="Find a test run"
            />
          </div>
          <Select
            value={status}
            onValueChange={(value) => {
              if (isStatusFilter(value)) setStatus(value);
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="Status"
              className="h-7 w-28 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  className="text-xs"
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <ul className="divide-y divide-border/60 rounded-lg border border-border">
        {several ? (
          <li
            aria-hidden
            className="flex items-center gap-3 bg-muted/30 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            <span className="min-w-0 flex-1">Test run</span>
            {targets.map((target) => (
              <span
                key={target.key}
                className="w-28 shrink-0 truncate normal-case tracking-normal"
              >
                {target.model}
              </span>
            ))}
            <span className="w-16 shrink-0" />
          </li>
        ) : null}
        {visible.map((row) => (
          <li
            key={row.key}
            className="flex items-center gap-3 px-3 py-2 hover:bg-muted/30"
            data-testid="test-run-row"
          >
            <button
              type="button"
              onClick={() => onOpen(row.key)}
              className="min-w-0 flex-1 truncate text-left text-sm text-foreground hover:underline"
            >
              {row.title}
            </button>
            {cellsOf(row).map((items, index) => (
              <span key={targets[index].key} className="w-28 shrink-0">
                <VerdictCell iterations={items} passThreshold={passThreshold} />
              </span>
            ))}
            <span className="flex min-w-16 shrink-0 items-center justify-end gap-1">
              <SlideButton
                label="Open test run"
                name={`Open test run: ${row.title}`}
                icon={<ArrowUpRight className="size-3.5" aria-hidden />}
                onClick={() => onOpen(row.key)}
              />
              {row.testCaseId ? (
                <SlideButton
                  label="Edit Test Case"
                  name={`Edit Test Case: ${row.title}`}
                  icon={<Pencil className="size-3.5" aria-hidden />}
                  onClick={() => row.testCaseId && onEdit(row.testCaseId)}
                />
              ) : null}
            </span>
          </li>
        ))}
        {visible.length === 0 ? (
          <li className="px-3 py-6 text-center text-sm text-muted-foreground">
            No test runs match.
          </li>
        ) : null}
      </ul>
    </section>
  );
}
