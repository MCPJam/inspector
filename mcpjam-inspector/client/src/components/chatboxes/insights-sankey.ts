import type {
  InsightsSankey,
  InsightsSankeyNode,
  SankeyStage,
} from "@/hooks/useUsageInsights";
import type {
  InsightsSelection,
  PrimaryBehavior,
  SessionOutcome,
  SessionSentiment,
} from "@/hooks/chatbox-usage-filters";

/** Mirrors `SANKEY_UNLABELED` / `SANKEY_OTHER` in the backend's `breakdowns.ts`. */
export const SANKEY_UNLABELED = "__unlabeled__";
export const SANKEY_OTHER = "__other__";

export const STAGE_ORDER: readonly SankeyStage[] = [
  "goal",
  "behavior",
  "outcome",
  "sentiment",
];

export const STAGE_TITLES: Record<SankeyStage, string> = {
  goal: "Goal",
  behavior: "Behavior",
  outcome: "Outcome",
  sentiment: "Sentiment",
};

/** Enum values are stored snake_case; the axis reads better in prose. */
export function stageValueLabel(node: InsightsSankeyNode): string {
  if (node.key === SANKEY_UNLABELED) return "Not analyzed";
  if (node.stage === "goal") return node.label;
  return node.label.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function parseNodeId(id: string): { stage: SankeyStage; key: string } {
  const separator = id.indexOf(":");
  return {
    stage: id.slice(0, separator) as SankeyStage,
    key: id.slice(separator + 1),
  };
}

/**
 * Outcome / sentiment pairs that disagree.
 *
 * The two stages are strongly correlated, so the thick diagonal bands carry
 * almost no information — the sessions worth opening are the ones where the
 * task result and the user's reaction point in opposite directions. A user
 * frustrated by a completed task means the outcome extraction is wrong, or the
 * "completion" cost them more than it was worth; a user satisfied by an errored
 * one means the error was incidental. Both are findings; the diagonal is not.
 *
 * `unclear` and `neutral` are absent from every list on purpose: they are the
 * absence of a reaction, and disagreeing with an absence is not a finding.
 */
export const DISCORDANT_OUTCOME_SENTIMENT: Record<
  SessionOutcome,
  readonly SessionSentiment[]
> = {
  completed: ["frustrated", "gave_up"],
  partial: ["gave_up"],
  unresolved: ["satisfied"],
  errored: ["satisfied"],
  unclear: [],
};

/**
 * Whether a link joins an outcome to a sentiment that disagrees with it. False
 * for every other stage pair, and for any link touching an unlabeled node —
 * absence cannot disagree with anything.
 */
export function isDiscordantLink(sourceId: string, targetId: string): boolean {
  const source = parseNodeId(sourceId);
  const target = parseNodeId(targetId);
  if (source.stage !== "outcome" || target.stage !== "sentiment") return false;
  if (source.key === SANKEY_UNLABELED || target.key === SANKEY_UNLABELED) {
    return false;
  }
  const discordant =
    DISCORDANT_OUTCOME_SENTIMENT[source.key as SessionOutcome] ?? [];
  return discordant.includes(target.key as SessionSentiment);
}

/**
 * The filter selection a node click produces, or null when the node cannot be
 * expressed as one (the folded goal tail and the unlabeled goal node).
 *
 * A stage value of `null` is the unlabeled node — a real choice, distinct from
 * the key being absent, which means "this stage is not part of the selection".
 */
export function selectionForNode(
  node: InsightsSankeyNode,
): InsightsSelection | null {
  if (!node.clickable) return null;
  const unlabeled = node.key === SANKEY_UNLABELED;
  switch (node.stage) {
    case "goal":
      return { goal: { clusterId: node.key, label: node.label } };
    case "behavior":
      return { behavior: unlabeled ? null : (node.key as PrimaryBehavior) };
    case "outcome":
      return { outcome: unlabeled ? null : (node.key as SessionOutcome) };
    case "sentiment":
      return { sentiment: unlabeled ? null : (node.key as SessionSentiment) };
    default:
      return null;
  }
}

/**
 * The selection a link click produces: both endpoints at once, which ANDs
 * across the two dimensions. Null when either endpoint is unselectable, since a
 * half-expressible link would silently widen to the other endpoint alone.
 */
export function selectionForLink(
  source: InsightsSankeyNode,
  target: InsightsSankeyNode,
): InsightsSelection | null {
  const from = selectionForNode(source);
  const to = selectionForNode(target);
  if (!from || !to) return null;
  return { ...from, ...to };
}

export type RechartsSankeyDatum = {
  nodes: Array<{ name: string; node: InsightsSankeyNode }>;
  links: Array<{
    source: number;
    target: number;
    value: number;
    sourceId: string;
    targetId: string;
    discordant: boolean;
  }>;
};

/**
 * Convert the id-keyed payload to the index-keyed shape recharts wants, keeping
 * the original node on each entry so the renderers and click handlers never have
 * to look anything up by position.
 *
 * Links whose endpoints are not both present are dropped rather than emitted
 * with a -1 index, which recharts would render as a stray edge from nowhere.
 */
export function toRechartsSankey(sankey: InsightsSankey): RechartsSankeyDatum {
  const ordered = [...sankey.nodes].sort(
    (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage),
  );
  const indexById = new Map(ordered.map((node, index) => [node.id, index]));

  const links: RechartsSankeyDatum["links"] = [];
  for (const link of sankey.links) {
    const source = indexById.get(link.source);
    const target = indexById.get(link.target);
    if (source === undefined || target === undefined) continue;
    links.push({
      source,
      target,
      value: link.count,
      sourceId: link.source,
      targetId: link.target,
      discordant: isDiscordantLink(link.source, link.target),
    });
  }

  return {
    nodes: ordered.map((node) => ({ name: node.label, node })),
    links,
  };
}

/** Sessions in a stage. Every stage sums to the same total, so any one will do. */
export function stageTotal(sankey: InsightsSankey, stage: SankeyStage): number {
  return sankey.nodes
    .filter((node) => node.stage === stage)
    .reduce((sum, node) => sum + node.count, 0);
}

/** A node's share of its own stage, as a whole percentage. */
export function stageShare(
  sankey: InsightsSankey,
  node: InsightsSankeyNode,
): number {
  const total = stageTotal(sankey, node.stage);
  if (total === 0) return 0;
  return Math.round((node.count / total) * 100);
}
