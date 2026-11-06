/** The Test run page's body: no queries, so tests and previews render it from fixtures. */
import type { ReactNode } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { SegmentedControl } from "@/components/ui/json-editor/segmented-control";
import type { RunResultsMatrixData } from "../run-results-matrix-model";
import { resultCounts } from "../run-results-matrix-model";
import { ExecutionPreviewToggle } from "../case-steps/execution-preview-panel";
import { CaseIterations } from "./case-iterations";
import type { TestRunFinding, TestRunVerdict } from "./test-run-findings-model";
import type { TestRunScorecard } from "./test-run-scorecard-model";
import { TestRunFindings, TestRunScorecards } from "./test-run-sections";
import { TEST_RUN_ITERATION_LIMIT } from "./use-test-run-data";

type Target = RunResultsMatrixData["targets"][number];

const VERDICT: Record<
  Exclude<TestRunVerdict, "undecided">,
  { word: string; tone: string }
> = {
  passed: { word: "Passed", tone: "text-success" },
  flaky: { word: "Flaky · passed, but not every time", tone: "text-warning" },
  failed: { word: "Failed", tone: "text-destructive" },
  pending: { word: "Running", tone: "text-pending" },
  empty: { word: "No results", tone: "text-muted-foreground" },
};

export type TestRunViewProps = {
  runNumber: number;
  title: string;
  verdict: TestRunVerdict;
  passed: number;
  total: number;
  findings: readonly TestRunFinding[];
  scorecard: TestRunScorecard;
  /** The launch's targets, in matrix order. */
  targets: readonly Target[];
  caseKey: string;
  /** The target the Iterations card shows. */
  selectedTarget: Target | null;
  onSelectTarget: (targetKey: string) => void;
  truncated: boolean;
  /** The docked execution preview, or null while closed. */
  preview: ReactNode;
  /** Null when the case could not be read: no toggle, no panel. */
  previewToggle: { open: boolean; onToggle: () => void } | null;
  onOpenIteration: (iterationId: string) => void;
  onCopyFixPrompt: (finding: TestRunFinding) => void;
  onEditTestCase: () => void;
};

const EYEBROW =
  "inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase leading-[14px] tracking-[0.06em] text-muted-foreground";

function IterationsCard({
  targets,
  caseKey,
  selectedTarget,
  onSelectTarget,
  onOpenIteration,
}: Pick<
  TestRunViewProps,
  | "targets"
  | "caseKey"
  | "selectedTarget"
  | "onSelectTarget"
  | "onOpenIteration"
> & { selectedTarget: Target }) {
  const tally = (target: Target) => {
    const items = target.cells.get(caseKey) ?? [];
    return `${resultCounts(items).passed}/${items.length}`;
  };
  return (
    <section
      className="rounded-xl border border-border bg-card p-5"
      data-testid="nav-test-run-iterations"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">Iterations</h3>
        {targets.length > 1 ? (
          <SegmentedControl
            size="sm"
            value={selectedTarget.targetKey}
            onChange={onSelectTarget}
            options={targets.map((target) => ({
              value: target.targetKey,
              title: `${target.client} · ${target.model}`,
              label: (
                <>
                  {target.model}
                  <span className="tabular-nums text-muted-foreground">
                    {tally(target)}
                  </span>
                </>
              ),
            }))}
          />
        ) : (
          <span className="text-xs text-muted-foreground">
            {selectedTarget.client} · {selectedTarget.model}
          </span>
        )}
      </div>
      <CaseIterations
        key={selectedTarget.key}
        target={selectedTarget}
        caseKey={caseKey}
        onSelectIteration={onOpenIteration}
      />
    </section>
  );
}

export function TestRunView(props: TestRunViewProps) {
  const { verdict, passed, total, preview } = props;
  const body = (
    <>
      <TestRunFindings
        findings={props.findings}
        onOpenIteration={props.onOpenIteration}
        onCopyFixPrompt={props.onCopyFixPrompt}
      />
      <TestRunScorecards
        scorecard={props.scorecard}
        onOpenIteration={props.onOpenIteration}
      />
      {props.selectedTarget && (
        <IterationsCard {...props} selectedTarget={props.selectedTarget} />
      )}
      {props.truncated && (
        <p className="text-xs text-muted-foreground">
          Showing the first {TEST_RUN_ITERATION_LIMIT} iterations of this test
          run.
        </p>
      )}
    </>
  );
  return (
    <div
      className="flex min-w-0 flex-col gap-5 pb-6"
      data-testid="nav-test-run"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className={EYEBROW}>Test run · Run #{props.runNumber}</span>
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="min-w-0 text-xl font-semibold tracking-tight text-foreground">
              {props.title.trim() || "Untitled test case"}
            </h2>
            {props.previewToggle && (
              <ExecutionPreviewToggle {...props.previewToggle} />
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {verdict !== "undecided" && (
              <>
                <span className={cn("font-semibold", VERDICT[verdict].tone)}>
                  {VERDICT[verdict].word}
                </span>
                {" · "}
              </>
            )}
            {passed}/{total} iterations passed
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          onClick={props.onEditTestCase}
        >
          <Pencil className="size-3.5" aria-hidden="true" />
          Edit Test Case
        </Button>
      </div>
      {preview ? (
        <div className="flex flex-col gap-5 md:flex-row">
          {preview}
          <div className="flex min-w-0 flex-1 flex-col gap-5">{body}</div>
        </div>
      ) : (
        body
      )}
    </div>
  );
}

/** Placeholders in the header, Findings, Scorecards and Iterations places. */
export function TestRunSkeleton() {
  return (
    <div
      className="flex min-w-0 flex-col gap-5 pb-6"
      data-testid="nav-test-run-loading"
      aria-busy="true"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-4 w-48" />
      </div>
      <Skeleton className="h-20 w-full rounded-lg" />
      <Skeleton className="h-48 w-full rounded-lg" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}

/** Scroll frame every state of the page shares, under the crumb bar. */
export function TestRunScrollArea({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6 pt-6 sm:px-6">
      {children}
    </div>
  );
}
