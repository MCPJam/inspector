/**
 * The Conformance home once servers have runs: one card per server with its
 * latest result, suite scores, a link to that run, and a one-click Run.
 */

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@mcpjam/design-system/select";
import {
  isKnownProtocolVersion,
  MCP_PROTOCOL_VERSIONS,
  type McpProtocolVersion,
} from "@mcpjam/sdk/browser";
import type { ProtocolVersionPin } from "@/hooks/use-conformance-run";
import { useArtifactQuery } from "@/lib/artifact-urls";
import { type ConformanceRunListItem } from "./ConformanceHistory";
import { RunResultRing } from "./RunResultRing";
import { SUITE_COPY, ServerAvatar } from "./conformance-ui";

const SUITES = ["protocol", "apps", "tasks", "oauth"] as const;
/** Four text-sm rows plus the gaps between them. */
const SUITE_STACK = "min-h-[6.875rem]";
const PROTOCOL_VERSIONS = [...MCP_PROTOCOL_VERSIONS].reverse();

const listRuns = makeFunctionReference<
  "query",
  {
    projectId: string;
    targetKey: string;
    protocolVersion: McpProtocolVersion;
    paginationOpts: { numItems: number; cursor: null };
  },
  { page: ConformanceRunListItem[] }
>("conformanceRuns:listRuns");

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

function lastRunLabel(createdAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - createdAt) / 60_000));
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
  run: latestRun,
  iconUrl,
  onViewRun,
  onRun,
  disabled,
  starting,
}: {
  serverName: string;
  run: ConformanceRunListItem;
  iconUrl?: string;
  onViewRun: (runId: string) => void;
  onRun: (serverName: string, version: ProtocolVersionPin) => void;
  disabled: boolean;
  /** This card's Run was pressed and its run is being set up. */
  starting: boolean;
}) {
  const [selection, setSelection] = useState<McpProtocolVersion | null>(null);
  const latestVersion = latestRun.protocolVersion;
  const selectedVersion = selection ?? latestVersion;
  const knownLatest = latestVersion && isKnownProtocolVersion(latestVersion);
  const pin = selection ?? (knownLatest ? latestVersion : "auto");
  const showLatest = selection === null || selection === latestVersion;
  const byVersion = useQuery(
    listRuns,
    !showLatest
      ? {
          projectId: latestRun.projectId,
          targetKey: latestRun.targetKey,
          protocolVersion: selection,
          paginationOpts: { numItems: 1, cursor: null },
        }
      : "skip",
  );
  const run = showLatest ? latestRun : byVersion?.page[0];
  const loading = !showLatest && byVersion === undefined;
  const detail = useArtifactQuery<{ reports?: SuiteReport[] } | null>(
    "conformanceRuns:getRun",
    run ? { runId: run._id } : "skip",
  );
  const reports = new Map(
    (detail?.reports ?? []).map((report) => [report.suiteKind, report]),
  );
  const suites = SUITES.flatMap((kind) => {
    const report = reports.get(kind);
    return suiteRan(report) ? [report] : [];
  });
  const percent = run?.score == null ? "—" : `${Math.round(run.score)}%`;
  // Query updates do not tick with the clock, so "Last run 2m ago" would go
  // stale on an open page without this.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <li className="flex h-full flex-col gap-4 rounded-lg bg-popover px-5 py-4 text-popover-foreground shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          <ServerAvatar name={serverName} iconUrl={iconUrl} className="size-9" />
          <span className="truncate text-[15px] font-semibold">
            {serverName}
          </span>
        </div>
        <Select
          value={pin}
          onValueChange={(value) =>
            setSelection(isKnownProtocolVersion(value) ? value : null)
          }
        >
          <SelectTrigger
            size="sm"
            aria-label={`Protocol version for ${serverName}`}
          >
            <span>Protocol · {selectedVersion ?? "Auto"}</span>
          </SelectTrigger>
          <SelectContent>
            {!knownLatest && (
              <SelectItem value="auto">{latestVersion ?? "Auto"}</SelectItem>
            )}
            {PROTOCOL_VERSIONS.map((version) => (
              <SelectItem key={version} value={version}>
                {version}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {run ? (
        <div key={run._id} className="mb-2 flex items-center gap-5">
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
      ) : (
        <p
          role="status"
          className={`mb-2 flex ${SUITE_STACK} items-center justify-center text-center text-sm text-muted-foreground`}
        >
          {loading
            ? "Loading latest run…"
            : "No runs for this protocol version yet."}
        </p>
      )}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {run && lastRunLabel(run.createdAt, now)}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {run && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onViewRun(run._id)}
            >
              View last run
            </Button>
          )}
          <Button
            size="sm"
            disabled={disabled || starting}
            onClick={() => onRun(serverName, pin)}
            aria-label={
              starting ? `Starting ${serverName}` : `Run ${serverName}`
            }
            aria-busy={starting || undefined}
          >
            {starting ? (
              <>
                <Loader2
                  className="mr-1.5 h-3.5 w-3.5 animate-spin"
                  aria-hidden
                />
                Starting...
              </>
            ) : (
              "Run"
            )}
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
  startingServerName,
}: {
  /** Each server's latest run, by server name. */
  runs: Array<{ serverName: string; run: ConformanceRunListItem }>;
  /** Each server's logo URL, by name; initials where there is none. */
  serverIcons?: Record<string, string>;
  onViewRun: (runId: string) => void;
  onRun: (serverName: string, version: ProtocolVersionPin) => void;
  /** A run is connecting, or the saved defaults are still loading. */
  disabled?: boolean;
  /** The server whose saved defaults could not be loaded. */
  disabledServerName?: string;
  /**
   * The server whose Run was pressed, while its run is set up. Every Run
   * stays off meanwhile (a second Run would replace this one), so this card
   * says which one is starting.
   */
  startingServerName?: string;
}) {
  return (
    <ul
      className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2"
      aria-label="Servers"
    >
      {runs.map(({ serverName, run }) => (
        <ServerCard
          key={`${run.projectId}/${run.targetKey}`}
          serverName={serverName}
          run={run}
          iconUrl={serverIcons?.[serverName]}
          onViewRun={onViewRun}
          onRun={onRun}
          disabled={disabled || disabledServerName === serverName}
          starting={startingServerName === serverName}
        />
      ))}
    </ul>
  );
}
