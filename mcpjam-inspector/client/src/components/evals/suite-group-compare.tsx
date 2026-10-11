/**
 * Compare two run groups, host by host. Within a group there is exactly one
 * run per host, so "group A vs group B for host H" is precisely the existing
 * per-run diff (`getTestSuiteRunDiff` → {@link RunDiffView}) between A's and B's
 * run for that host. This component is just the pickers (base group, compare
 * group, host) that resolve to the two run ids `RunDiffView` needs.
 *
 * Defaults to the two most recent groups and their first shared host.
 */
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EvalSuiteRunListItem } from "./types";
import { formatRunId } from "./helpers";
import { RunDiffView } from "./run-diff-view";

export type CompareGroup = {
  key: string;
  label: string;
  runs: EvalSuiteRunListItem[];
};

interface SuiteGroupCompareProps {
  /** Newest-first. */
  groups: CompareGroup[];
  loadGroup?: (runGroupId: string) => Promise<EvalSuiteRunListItem[]>;
  hostNamesById: Map<string, string | null>;
  onBack: () => void;
  onOpenRun: (runId: string) => void;
}

const hostIdsOf = (group: CompareGroup | undefined): string[] =>
  group
    ? [
        ...new Set(
          group.runs.map((r) => r.namedHostId).filter(Boolean) as string[],
        ),
      ]
    : [];

function selectClass(): string {
  return cn(
    "rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
  );
}

export function SuiteGroupCompare({
  groups,
  loadGroup,
  hostNamesById,
  onBack,
  onOpenRun,
}: SuiteGroupCompareProps) {
  // Default: compare newest (groups[0]) against the next-newest (groups[1]).
  const [compareKey, setCompareKey] = useState(groups[0]?.key ?? "");
  const [baseKey, setBaseKey] = useState(
    groups[1]?.key ?? groups[0]?.key ?? "",
  );
  const [hostId, setHostId] = useState<string | null>(null);

  const baseSource =
    groups.find((g) => g.key === baseKey) ?? groups[1] ?? groups[0];
  const compareSource = groups.find((g) => g.key === compareKey) ?? groups[0];
  const [loaded, setLoaded] = useState<{
    key: string;
    base: EvalSuiteRunListItem[];
    compare: EvalSuiteRunListItem[];
    error?: boolean;
  } | null>(null);
  const selectionKey = `${baseSource?.key}:${compareSource?.key}`;
  useEffect(() => {
    if (!loadGroup || !baseSource || !compareSource) return;
    let cancelled = false;
    const read = (group: CompareGroup) =>
      group.runs[0]?.runGroupId
        ? loadGroup(group.runs[0].runGroupId)
        : Promise.resolve(group.runs);
    void Promise.all([read(baseSource), read(compareSource)])
      .then(([base, compare]) => {
        if (!cancelled) setLoaded({ key: selectionKey, base, compare });
      })
      .catch(() => {
        if (!cancelled)
          setLoaded({ key: selectionKey, base: [], compare: [], error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [loadGroup, selectionKey]);

  const hostName = (id: string): string =>
    hostNamesById.get(id) ?? formatRunId(id);

  if (groups.length < 2) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-muted-foreground">
          You need at least two run groups to compare.
        </p>
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-primary hover:underline"
        >
          Back to results
        </button>
      </div>
    );
  }

  const groupLoading = Boolean(loadGroup) && loaded?.key !== selectionKey;
  const groupError =
    Boolean(loadGroup) && loaded?.key === selectionKey && loaded.error;
  const baseGroup = {
    ...baseSource,
    runs:
      loadGroup && loaded?.key === selectionKey ? loaded.base : baseSource.runs,
  };
  const compareGroup = {
    ...compareSource,
    runs:
      loadGroup && loaded?.key === selectionKey
        ? loaded.compare
        : compareSource.runs,
  };

  // Hosts present in BOTH groups — only those can be diffed.
  const baseHosts = new Set(hostIdsOf(baseGroup));
  const commonHosts = hostIdsOf(compareGroup).filter((h) => baseHosts.has(h));
  const effectiveHostId =
    hostId && commonHosts.includes(hostId) ? hostId : (commonHosts[0] ?? null);

  const baseRun = effectiveHostId
    ? baseGroup.runs.find((r) => r.namedHostId === effectiveHostId)
    : undefined;
  const compareRun = effectiveHostId
    ? compareGroup.runs.find((r) => r.namedHostId === effectiveHostId)
    : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Pickers */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-2.5">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Base
          </span>
          <select
            className={selectClass()}
            value={baseGroup.key}
            onChange={(e) => setBaseKey(e.target.value)}
          >
            {groups.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
        <span className="text-xs text-muted-foreground">→</span>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Compare
          </span>
          <select
            className={selectClass()}
            value={compareGroup.key}
            onChange={(e) => setCompareKey(e.target.value)}
          >
            {groups.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
        {commonHosts.length > 0 ? (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Client
            </span>
            <select
              className={selectClass()}
              value={effectiveHostId ?? ""}
              onChange={(e) => setHostId(e.target.value)}
            >
              {commonHosts.map((h) => (
                <option key={h} value={h}>
                  {hostName(h)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {/* Diff */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {groupLoading ? (
          <div className="p-8 text-sm text-muted-foreground">
            Loading run groups…
          </div>
        ) : groupError ? (
          <div className="p-8 text-sm text-muted-foreground">
            Could not load the complete run groups.
          </div>
        ) : baseRun && compareRun ? (
          baseRun._id === compareRun._id ? (
            <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
              Base and compare resolve to the same run — pick different groups.
            </div>
          ) : (
            <RunDiffView
              baseRunId={baseRun._id}
              compareRunId={compareRun._id}
              previewChars={160}
              hideHeader
              onOpenIteration={(runId) => onOpenRun(runId)}
            />
          )
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
            These two groups share no common client to compare.
            {commonHosts.length === 0
              ? " Pick groups that ran the same client."
              : null}
          </div>
        )}
      </div>
    </div>
  );
}
