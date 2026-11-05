/**
 * The Conformance home once servers have runs: one card per server with its
 * latest result, suite scores, a link to that run, and a one-click Run.
 */

import { useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { useArtifactQuery } from "@/lib/artifact-urls";
import { type ConformanceRunListItem } from "./ConformanceHistory";
import { RunResultRing } from "./RunResultRing";
import { SUITE_COPY, ServerAvatar } from "./conformance-ui";

const SUITES = ["protocol", "apps", "tasks", "oauth"] as const;
/** Four text-sm rows plus the gaps between them. */
const SUITE_STACK = "min-h-[6.875rem]";

type SuiteReport = {
  suiteKind: string;
  status?: string;
  score: number | null;
  applicable?: number;
  passed?: number;
};

/** A suite with no score never ran, or every check was not applicable. */
function suiteRan(
  report: SuiteReport | undefined,
): report is SuiteReport & { applicable: number; passed: number } {
  return (
    report != null &&
    report.status !== "skipped" &&
    report.score != null &&
    typeof report.applicable === "number" &&
    report.applicable > 0 &&
    typeof report.passed === "number"
  );
}

function lastRunLabel(createdAt: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - createdAt) / 60_000));
  if (minutes < 1) return "Last run just now";
  if (minutes < 60) return `Last run ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last run ${hours}h ago`;
  const days = Math.round(hours / 24);
  return `Last run ${days}d ago`;
}

function SuiteMeter({
  report,
}: {
  report: SuiteReport & { applicable: number; passed: number };
}) {
  const title =
    SUITE_COPY[report.suiteKind as keyof typeof SUITE_COPY]?.title ??
    report.suiteKind;
  const width = Math.max(0, Math.min(100, report.score ?? 0));
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      setFilled(true);
      return;
    }
    let inner = 0;
    const frame = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setFilled(true));
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(inner);
    };
  }, []);
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-sm">{title}</span>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-success transition-[width] duration-700 ease-out motion-reduce:transition-none"
          style={{ width: filled ? `${width}%` : "0%" }}
        />
      </span>
      <span className="w-12 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
        {report.passed}/{report.applicable}
      </span>
    </div>
  );
}

function ServerCard({
  serverName,
  run,
  iconUrl,
  onViewRun,
  onRun,
  disabled,
}: {
  serverName: string;
  run: ConformanceRunListItem;
  iconUrl?: string;
  onViewRun: (runId: string) => void;
  onRun: (serverName: string) => void;
  disabled: boolean;
}) {
  const detail = useArtifactQuery<{ reports?: SuiteReport[] } | null>(
    "conformanceRuns:getRun",
    { runId: run._id },
  );
  const reports = new Map(
    (detail?.reports ?? []).map((report) => [report.suiteKind, report]),
  );
  const suites = SUITES.flatMap((kind) => {
    const report = reports.get(kind);
    return suiteRan(report) ? [report] : [];
  });
  const percent = run.score == null ? "—" : `${Math.round(run.score)}%`;

  return (
    <li className="flex h-full flex-col gap-4 rounded-lg bg-popover px-5 py-4 text-popover-foreground shadow-sm">
      <div className="flex min-w-0 items-center gap-3">
        <ServerAvatar name={serverName} iconUrl={iconUrl} className="size-9" />
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[15px] font-semibold">
            {serverName}
          </span>
          <span className="shrink-0 text-sm text-muted-foreground">
            · Protocol {run.protocolVersion ?? "Auto"}
          </span>
        </div>
      </div>
      <div className="mb-2 flex items-center gap-5">
        <div className="flex w-[88px] shrink-0 items-center justify-center">
          <RunResultRing run={run} size={88} label={percent} animate />
        </div>
        <div
          className={`flex ${SUITE_STACK} min-w-0 flex-1 flex-col justify-center gap-2.5`}
          role="group"
          aria-label={`${serverName} suites`}
        >
          {suites.map((report) => (
            <SuiteMeter key={report.suiteKind} report={report} />
          ))}
        </div>
      </div>
      <div className="mt-auto flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {lastRunLabel(run.createdAt)}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onViewRun(run._id)}
          >
            View last run
          </Button>
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => onRun(serverName)}
            aria-label={`Run ${serverName}`}
          >
            Run
          </Button>
        </div>
      </div>
    </li>
  );
}

export function ConformanceServerList({
  runs,
  serverIcons,
  onViewRun,
  onRun,
  disabled = false,
  disabledServerName,
}: {
  /** Each server's latest run, by server name. */
  runs: Array<{ serverName: string; run: ConformanceRunListItem }>;
  /** Each server's logo URL, by name; initials where there is none. */
  serverIcons?: Record<string, string>;
  onViewRun: (runId: string) => void;
  onRun: (serverName: string) => void;
  /** A run is connecting, or the saved defaults are still loading. */
  disabled?: boolean;
  /** The server whose saved defaults could not be loaded. */
  disabledServerName?: string;
}) {
  return (
    <ul
      className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2"
      aria-label="Servers"
    >
      {runs.map(({ serverName, run }) => (
        <ServerCard
          key={serverName}
          serverName={serverName}
          run={run}
          iconUrl={serverIcons?.[serverName]}
          onViewRun={onViewRun}
          onRun={onRun}
          disabled={disabled || disabledServerName === serverName}
        />
      ))}
    </ul>
  );
}
