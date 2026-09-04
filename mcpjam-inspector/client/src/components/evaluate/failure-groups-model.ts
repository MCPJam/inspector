/**
 * Client adapter for the suite failure-groups row.
 *
 * One failed trial per ribbon. Columns are Case → Route → Reason. Adjacent
 * links only; no discordant counts. Fold at 12 per stage into SANKEY_OTHER.
 * Unjudged members land on SANKEY_UNLABELED ("Not judged").
 *
 * The Convex DTO is typed here because `evalFailureGroups` is not generated
 * in this repo — it lives in the backend and may not be deployed yet.
 */

import { NO_TOOL_PATH_KEY } from "@mcpjam/sdk/contract";

import type {
  InsightsSankey,
  InsightsSankeyLink,
  InsightsSankeyNode,
} from "@/hooks/useUsageInsights";
import {
  SANKEY_OTHER,
  SANKEY_UNLABELED,
} from "@/components/shared/usage-insights/insights-sankey";

export const FAILURE_SANKEY_STAGES = ["case", "route", "reason"] as const;
export type FailureSankeyStage = (typeof FAILURE_SANKEY_STAGES)[number];

export const FAILURE_STAGE_TITLES: Record<FailureSankeyStage, string> = {
  case: "Case",
  route: "Route",
  reason: "Reason",
};

/** Role tokens only — no literal hex / oklch. */
export const FAILURE_STAGE_COLORS: Record<
  FailureSankeyStage,
  { node: string; head: string }
> = {
  case: { node: "var(--diagram-view)", head: "var(--diagram-view)" },
  route: { node: "var(--diagram-server)", head: "var(--diagram-server)" },
  reason: { node: "var(--destructive)", head: "var(--destructive)" },
};

/** Mirrors the backend `SANKEY_MAX_THEMES` cap. */
export const FAILURE_FOLD_PER_STAGE = 12;

export const UNJUDGED_REASON_LABEL = "Not judged";
export const CALLED_NOTHING_LABEL = "called nothing";

export type FailureGroupMember = {
  runId: string;
  iterationId?: string;
  gradingKey: string;
  caseKey: string;
  caseTitle: string;
  pathKey: string;
  reasonHash?: string;
  /** Absent when the trial was not judged. */
  groupIndex?: number;
  novel?: boolean;
};

export type FailureGroup = {
  index: number;
  label: string;
  summary?: string;
  keywords?: string[];
  memberCount: number;
  representativeGradingKeys?: string[];
};

export type SuiteFailureGroupsRow = {
  _id?: string;
  suiteId: string;
  status: "queued" | "running" | "completed" | "failed";
  errorCode?: string;
  failedTrials: number;
  judgedFailedTrials: number;
  unjudgedFailedTrials: number;
  grouped: boolean;
  k: number;
  novelty: "measured" | "notMeasured";
  groups: FailureGroup[];
  members: FailureGroupMember[];
};

export type SuiteFailureGroupsQueryResult = {
  latest: SuiteFailureGroupsRow | null;
  inFlight: { status: "queued" | "running" } | null;
};

export type FailureSankey = InsightsSankey<FailureSankeyStage>;

export type FlatReason = {
  label: string;
  count: number;
};

type Counted = { label: string; count: number };

function routeLabel(pathKey: string): string {
  return pathKey === NO_TOOL_PATH_KEY ? CALLED_NOTHING_LABEL : pathKey;
}

function reasonOf(
  member: FailureGroupMember,
  groups: readonly FailureGroup[],
): { key: string; label: string } {
  if (member.groupIndex === undefined) {
    return { key: SANKEY_UNLABELED, label: UNJUDGED_REASON_LABEL };
  }
  const group = groups.find((entry) => entry.index === member.groupIndex);
  return {
    key: `group:${member.groupIndex}`,
    label: group?.label ?? `group:${member.groupIndex}`,
  };
}

function foldStage(
  counts: Map<string, Counted>,
): { keep: Map<string, Counted>; foldedKeys: Set<string> } {
  const ranked = [...counts.entries()].sort(
    (a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]),
  );
  if (ranked.length <= FAILURE_FOLD_PER_STAGE) {
    return { keep: new Map(counts), foldedKeys: new Set() };
  }
  const keep = new Map(ranked.slice(0, FAILURE_FOLD_PER_STAGE));
  const folded = ranked.slice(FAILURE_FOLD_PER_STAGE);
  const foldedKeys = new Set(folded.map(([key]) => key));
  keep.set(SANKEY_OTHER, {
    label: `Other (${folded.length})`,
    count: folded.reduce((sum, [, value]) => sum + value.count, 0),
  });
  return { keep, foldedKeys };
}

function remapKey(key: string, foldedKeys: Set<string>): string {
  return foldedKeys.has(key) ? SANKEY_OTHER : key;
}

function nodeFor(
  stage: FailureSankeyStage,
  key: string,
  counted: Counted,
): InsightsSankeyNode<FailureSankeyStage> {
  return {
    id: `${stage}:${key}`,
    stage,
    key,
    label: counted.label,
    count: counted.count,
    clickable: key !== SANKEY_OTHER && key !== SANKEY_UNLABELED,
  };
}

function addCount(
  into: Map<string, Counted>,
  key: string,
  label: string,
): void {
  const existing = into.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  into.set(key, { label, count: 1 });
}

function addLink(
  into: Map<string, InsightsSankeyLink<FailureSankeyStage>>,
  source: string,
  target: string,
): void {
  const id = `${source}→${target}`;
  const existing = into.get(id);
  if (existing) {
    existing.count += 1;
    return;
  }
  into.set(id, { source, target, count: 1 });
}

/**
 * Case → Route → Reason flow. Every member is one ribbon; columns conserve
 * that count. Adjacent-column links only.
 */
export function buildFailureSankey(row: SuiteFailureGroupsRow): FailureSankey {
  const caseCounts = new Map<string, Counted>();
  const routeCounts = new Map<string, Counted>();
  const reasonCounts = new Map<string, Counted>();

  const ribbons = row.members.map((member) => {
    const reason = reasonOf(member, row.groups);
    addCount(caseCounts, member.caseKey, member.caseTitle || member.caseKey);
    addCount(routeCounts, member.pathKey, routeLabel(member.pathKey));
    addCount(reasonCounts, reason.key, reason.label);
    return {
      caseKey: member.caseKey,
      pathKey: member.pathKey,
      reasonKey: reason.key,
    };
  });

  const caseFold = foldStage(caseCounts);
  const routeFold = foldStage(routeCounts);
  const reasonFold = foldStage(reasonCounts);

  const nodes: InsightsSankeyNode<FailureSankeyStage>[] = [
    ...[...caseFold.keep.entries()].map(([key, counted]) =>
      nodeFor("case", key, counted),
    ),
    ...[...routeFold.keep.entries()].map(([key, counted]) =>
      nodeFor("route", key, counted),
    ),
    ...[...reasonFold.keep.entries()].map(([key, counted]) =>
      nodeFor("reason", key, counted),
    ),
  ];

  const links = new Map<string, InsightsSankeyLink<FailureSankeyStage>>();
  for (const ribbon of ribbons) {
    const caseId = `case:${remapKey(ribbon.caseKey, caseFold.foldedKeys)}`;
    const routeId = `route:${remapKey(ribbon.pathKey, routeFold.foldedKeys)}`;
    const reasonId = `reason:${remapKey(ribbon.reasonKey, reasonFold.foldedKeys)}`;
    addLink(links, caseId, routeId);
    addLink(links, routeId, reasonId);
  }

  const foldedByStage: Partial<Record<FailureSankeyStage, number>> = {};
  if (caseFold.foldedKeys.size > 0) {
    foldedByStage.case = caseFold.foldedKeys.size;
  }
  if (routeFold.foldedKeys.size > 0) {
    foldedByStage.route = routeFold.foldedKeys.size;
  }
  if (reasonFold.foldedKeys.size > 0) {
    foldedByStage.reason = reasonFold.foldedKeys.size;
  }

  return {
    nodes,
    links: [...links.values()].sort(
      (a, b) => b.count - a.count || a.source.localeCompare(b.source),
    ),
    foldedGoalCount: 0,
    ...(Object.keys(foldedByStage).length > 0 ? { foldedByStage } : {}),
  };
}

/** Distinct reasons with counts — used when clustering did not split. */
export function flatReasonList(row: SuiteFailureGroupsRow): FlatReason[] {
  const counts = new Map<string, number>();
  for (const member of row.members) {
    const label = reasonOf(member, row.groups).label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => ({ label, count }));
}

export function novelMemberCount(row: SuiteFailureGroupsRow): number {
  return row.members.filter((member) => member.novel === true).length;
}

export function reasonCount(row: SuiteFailureGroupsRow): number {
  if (row.grouped) return row.groups.length;
  return flatReasonList(row).length;
}

/**
 * Collapsed header. Novelty chip text is appended only when measured and
 * there is at least one new member.
 */
export function failureGroupsHeader(row: SuiteFailureGroupsRow | null): {
  summary: string;
  noveltyLabel: string | null;
} {
  if (!row) {
    return { summary: "Failure groups", noveltyLabel: null };
  }
  const reasons = reasonCount(row);
  const summary = `${row.failedTrials} failed trial${
    row.failedTrials === 1 ? "" : "s"
  }, ${reasons} reason${reasons === 1 ? "" : "s"}`;
  if (row.novelty !== "measured") {
    return { summary, noveltyLabel: null };
  }
  const novel = novelMemberCount(row);
  if (novel <= 0) return { summary, noveltyLabel: null };
  return { summary, noveltyLabel: `${novel} new` };
}

export function failureGroupsBusy(
  row: SuiteFailureGroupsRow | null,
  inFlight: { status: "queued" | "running" } | null,
  requesting: boolean,
): boolean {
  if (requesting) return true;
  if (inFlight) return true;
  return row?.status === "queued" || row?.status === "running";
}
