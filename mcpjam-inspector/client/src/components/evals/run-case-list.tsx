import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import { cn } from "@/lib/utils";
import { caseListDataRowClassName } from "./case-list-shared";
import { evalSurfaceRowHoverClass } from "./eval-surface-chrome";
import {
  RunCaseIterationBar,
  runCaseFailCountClass,
  runCaseLatencyClassName,
  runCaseListDataRowClassName,
  runCaseListHeadClassName,
  runCaseListRowClassName,
  runCaseListSortGutterClassName,
  runCaseMetricsRailClassName,
  runCasePassCheckClass,
  runCaseTitleClassName,
} from "./run-case-list-shared";
import {
  formatRunCaseLatencyMs,
  groupRunIterationsByTestCase,
  type RunCaseGroup,
} from "./run-case-groups";
import type { EvalIteration } from "./types";

function RunCaseFailuresCell({ group }: { group: RunCaseGroup }) {
  if (group.failed === 0 && group.pending === 0) {
    return (
      <span
        className={cn(
          "inline-flex items-center justify-end",
          runCasePassCheckClass,
        )}
      >
        <Check className="size-3.5" aria-label="All iterations passed" />
      </span>
    );
  }

  if (group.failed === 0 && group.pending > 0) {
    return (
      <span className="font-mono text-xs tabular-nums text-muted-foreground">
        {group.pending}…
      </span>
    );
  }

  return (
    <span className={runCaseFailCountClass}>{group.failed}</span>
  );
}

function RunCaseMetricsHeader({ className }: { className?: string }) {
  return (
    <div className={cn(runCaseMetricsRailClassName, "hidden sm:grid", className)}>
      <div className="px-2 py-2">Iterations</div>
      <div className="px-2 py-2 text-right">P50</div>
      <div className="px-2 py-2 text-right">P95</div>
      <div className="px-2 py-2 text-right">Fail</div>
    </div>
  );
}

function RunCaseListColumnHeaders({
  caseCount,
  headerEnd,
  trailingGutter = false,
}: {
  /** When set, replaces the "Case" label with "Test cases · N". */
  caseCount?: number;
  headerEnd?: ReactNode;
  trailingGutter?: boolean;
}) {
  const reserveTrailing = trailingGutter || Boolean(headerEnd);

  return (
    <div className={cn(runCaseListRowClassName(), runCaseListHeadClassName)}>
      <div
        className={cn(
          runCaseTitleClassName,
          "px-2 py-2.5",
          caseCount !== undefined &&
            "min-h-10 normal-case tracking-normal font-sans text-base font-semibold leading-tight text-foreground sm:text-lg",
        )}
      >
        {caseCount !== undefined ? (
          <>
            Test cases{" "}
            <span className="font-mono text-sm font-normal tabular-nums text-muted-foreground">
              · {caseCount}
            </span>
          </>
        ) : (
          "Case"
        )}
      </div>
      <RunCaseMetricsHeader />
      {reserveTrailing ? (
        <div className={cn(runCaseListSortGutterClassName, "py-2")}>
          {headerEnd}
        </div>
      ) : null}
    </div>
  );
}

function RunCaseListItem({
  group,
  isSelected,
  onSelect,
  trailingGutter = false,
  reserveTrailing = false,
}: {
  group: RunCaseGroup;
  isSelected: boolean;
  onSelect: () => void;
  trailingGutter?: boolean;
  reserveTrailing?: boolean;
}) {
  const showTrailing = trailingGutter || reserveTrailing;

  return (
    <div
      className={cn(
        caseListDataRowClassName({
          isSelected,
          isDimmed: group.pending > 0 && group.passed === 0 && group.failed === 0,
        }),
        "!gap-0 !px-0 !py-0",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        title={group.title}
        aria-label={`View ${group.title}: ${group.passed} of ${group.total} passed`}
        className={cn(
          runCaseListRowClassName(),
          runCaseListDataRowClassName,
          "cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
          evalSurfaceRowHoverClass,
        )}
      >
        <span className={cn(runCaseTitleClassName, "px-2 py-2")}>
          {group.title}
        </span>
        <div className={cn(runCaseMetricsRailClassName, "hidden py-2 sm:grid")}>
          <div className="min-w-0 px-2">
            <RunCaseIterationBar
              results={group.iterationResults}
              passed={group.passed}
              total={group.total}
            />
          </div>
          <div className={cn(runCaseLatencyClassName, "px-2")}>
            {formatRunCaseLatencyMs(group.p50Ms)}
          </div>
          <div className={cn(runCaseLatencyClassName, "px-2")}>
            {formatRunCaseLatencyMs(group.p95Ms)}
          </div>
          <div className="flex justify-end px-2">
            <RunCaseFailuresCell group={group} />
          </div>
        </div>
        {showTrailing ? (
          <div className={runCaseListSortGutterClassName} aria-hidden />
        ) : null}
      </button>
    </div>
  );
}

const STAGGER_CAP = 20;

const listVariants: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.03, delayChildren: 0.05 } },
};

const itemVariants: Variants = {
  hidden: (i: number) =>
    i < STAGGER_CAP ? { opacity: 0, x: -6 } : { opacity: 1, x: 0 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.15, ease: [0.16, 1, 0.3, 1] },
  },
};

export function RunCaseListWithSections({
  iterations,
  sortBy,
  selectedTestCaseId,
  onSelectTestCase,
  caseCount,
  headerEnd,
  trailingGutter = false,
}: {
  iterations: EvalIteration[];
  sortBy: "model" | "test" | "result";
  selectedTestCaseId: string | null;
  onSelectTestCase: (group: RunCaseGroup) => void;
  caseCount?: number;
  headerEnd?: ReactNode;
  trailingGutter?: boolean;
}) {
  const shouldReduceMotion = useReducedMotion();
  const groups = groupRunIterationsByTestCase(iterations, sortBy);
  const reserveTrailing = trailingGutter || Boolean(headerEnd);

  if (groups.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-muted-foreground">
        No test cases in this run yet.
      </div>
    );
  }

  return (
    <>
      <RunCaseListColumnHeaders
        caseCount={caseCount}
        headerEnd={headerEnd}
        trailingGutter={trailingGutter}
      />
      <motion.div
        variants={shouldReduceMotion ? undefined : listVariants}
        initial={shouldReduceMotion ? false : "hidden"}
        animate="visible"
      >
        <div className="divide-y divide-border/40">
          {groups.map((group, index) => (
            <motion.div
              key={group.key}
              custom={index}
              variants={shouldReduceMotion ? undefined : itemVariants}
            >
              <RunCaseListItem
                group={group}
                isSelected={
                  selectedTestCaseId !== null &&
                  group.testCaseId === selectedTestCaseId
                }
                onSelect={() => onSelectTestCase(group)}
                trailingGutter={trailingGutter}
                reserveTrailing={reserveTrailing}
              />
            </motion.div>
          ))}
        </div>
      </motion.div>
    </>
  );
}

/** @deprecated Use RunCaseListWithSections column headers directly. */
export function RunCaseListHeaders(props: {
  headerEnd?: ReactNode;
  trailingGutter?: boolean;
}) {
  return <RunCaseListColumnHeaders {...props} />;
}
