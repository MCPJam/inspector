import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import { computeIterationPassed } from "./pass-criteria";
import { formatDuration } from "./helpers";
import { EVAL_OUTCOME_STATUS_TEXT_CLASS } from "./constants";
import type { EvalIteration, EvalSuiteRun } from "./types";

export type RunDetailKpiStat = {
  label: string;
  value: string;
  detail: string;
  valueClass?: string;
};

export function normalizeRunPassRatePercent(passRate: number): number {
  if (passRate > 0 && passRate <= 1) {
    return Math.round(passRate * 100);
  }
  return Math.round(passRate);
}

export function computeRunDashboardKpis({
  selectedRunDetails,
  caseGroupsForSelectedRun,
  source,
}: {
  selectedRunDetails: EvalSuiteRun;
  caseGroupsForSelectedRun: EvalIteration[];
  source?: "ui" | "sdk";
}): RunDetailKpiStat[] {
  const computedStats =
    caseGroupsForSelectedRun.length === 0
      ? (selectedRunDetails.summary ?? {
          passed: 0,
          failed: 0,
          total: 0,
          passRate: 0,
        })
      : (() => {
          const passed = caseGroupsForSelectedRun.filter((i) =>
            computeIterationPassed(i),
          ).length;
          const failed = caseGroupsForSelectedRun.filter(
            (i) => !computeIterationPassed(i),
          ).length;
          const total = caseGroupsForSelectedRun.length;
          const passRate = total > 0 ? passed / total : 0;
          return { passed, failed, total, passRate };
        })();

  const isRunning = selectedRunDetails.status === "running";
  const expected = selectedRunDetails.expectedIterations;
  const metricLabel = source === "sdk" ? "Pass Rate" : "Accuracy";
  const passRatePercent =
    computedStats.total > 0
      ? normalizeRunPassRatePercent(computedStats.passRate)
      : null;
  const durationText =
    selectedRunDetails.completedAt && selectedRunDetails.createdAt
      ? formatDuration(
          selectedRunDetails.completedAt - selectedRunDetails.createdAt,
        )
      : "—";
  const totalDisplay =
    expected && isRunning
      ? `${computedStats.total.toLocaleString()} / ${expected.toLocaleString()}`
      : computedStats.total.toLocaleString();

  const accuracyDetail =
    computedStats.total === 0 ? "No cases recorded yet." : "";
  const durationDetail =
    durationText === "—" ? "available when complete" : "";

  return [
    {
      label: metricLabel,
      value: passRatePercent !== null ? `${passRatePercent}%` : "—",
      detail: accuracyDetail,
      valueClass: undefined,
    },
    {
      label: "Passed",
      value: computedStats.passed.toLocaleString(),
      detail: "",
      valueClass:
        computedStats.passed > 0
          ? EVAL_OUTCOME_STATUS_TEXT_CLASS.passed
          : undefined,
    },
    {
      label: "Failed",
      value: computedStats.failed.toLocaleString(),
      detail: "",
      valueClass:
        computedStats.failed > 0
          ? EVAL_OUTCOME_STATUS_TEXT_CLASS.failed
          : undefined,
    },
    {
      label: "Total",
      value: totalDisplay,
      detail: "",
      valueClass: undefined,
    },
    {
      label: "Duration",
      value: durationText,
      detail: durationDetail,
      valueClass: undefined,
    },
  ];
}

function KpiCard({
  stat,
  index,
  compact,
  shouldReduceMotion,
}: {
  stat: RunDetailKpiStat;
  index: number;
  compact: boolean;
  shouldReduceMotion: boolean | null;
}) {
  return (
    <motion.div
      initial={shouldReduceMotion ? false : { opacity: 0, y: 6 }}
      animate={shouldReduceMotion ? undefined : { opacity: 1, y: 0 }}
      transition={
        shouldReduceMotion
          ? undefined
          : {
              duration: 0.2,
              delay: 0.03 * index,
              ease: [0.16, 1, 0.3, 1],
            }
      }
      className={cn(
        "flex min-w-0 flex-1 basis-0 flex-col rounded-lg border border-border/25 bg-muted/10",
        compact ? "p-2 sm:p-2.5" : "p-3 sm:p-4",
      )}
    >
      <div
        className={cn(
          "text-muted-foreground/90",
          compact
            ? "text-[10px] font-medium leading-tight"
            : "text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80",
        )}
      >
        {stat.label}
      </div>
      <div
        className={cn(
          "font-semibold leading-none tracking-tight tabular-nums",
          compact
            ? "mt-1 text-base sm:text-lg"
            : "mt-2 text-2xl sm:mt-3 sm:text-3xl md:text-4xl",
          stat.valueClass,
        )}
      >
        {stat.value}
      </div>
      {stat.detail ? (
        <div
          className={cn(
            "mt-0.5 line-clamp-2 text-muted-foreground/70",
            compact ? "text-[10px]" : "text-[11px]",
          )}
        >
          {stat.detail}
        </div>
      ) : null}
    </motion.div>
  );
}

export function RunDetailKpiStrip({
  kpis,
  compact = false,
}: {
  kpis: RunDetailKpiStat[];
  compact?: boolean;
}) {
  const shouldReduceMotion = useReducedMotion();

  if (compact) {
    return (
      <motion.div
        initial={shouldReduceMotion ? false : { opacity: 0, y: 4 }}
        animate={shouldReduceMotion ? undefined : { opacity: 1, y: 0 }}
        transition={
          shouldReduceMotion
            ? undefined
            : { duration: 0.2, ease: [0.16, 1, 0.3, 1] }
        }
        className="flex w-full min-w-0 flex-nowrap items-stretch overflow-x-auto overflow-y-hidden overscroll-x-contain rounded-xl border border-border/40 bg-muted/15 shadow-sm [scrollbar-width:thin]"
      >
        {kpis.map((stat, index) => (
          <div
            key={`${stat.label}-${index}`}
            className={cn(
              "flex min-w-[5rem] flex-1 flex-col justify-center border-border/30 px-2.5 py-2.5 sm:min-w-0 sm:px-3 sm:py-2.5",
              index > 0 && "border-l",
            )}
          >
            <div className="text-[10px] font-medium leading-none text-muted-foreground">
              {stat.label}
            </div>
            <div
              className={cn(
                "mt-1 text-sm font-semibold tabular-nums leading-none tracking-tight sm:text-base",
                stat.valueClass,
              )}
            >
              {stat.value}
            </div>
            {stat.detail ? (
              <div className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground/70">
                {stat.detail}
              </div>
            ) : null}
          </div>
        ))}
      </motion.div>
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-nowrap gap-2 sm:gap-3">
      {kpis.map((stat, index) => (
        <KpiCard
          key={`${stat.label}-${index}`}
          stat={stat}
          index={index}
          compact={false}
          shouldReduceMotion={shouldReduceMotion}
        />
      ))}
    </div>
  );
}
