import {
  FEATURE_CARDS,
  FEATURE_FAMILIES,
  familiesForCard,
  type FeatureAssessment,
  type FeatureCardId,
  type FeatureDefinition,
  type FeatureFamilyDefinition,
  type FeatureFamilyId,
  type FeatureStateCounts,
  type FeatureUserState,
  type ServerFeatureEvaluation,
} from "@mcpjam/sdk/browser";
import { needsNewerCause, type NeedsNewerCause } from "./feature-states";

/*
 * The canvas and the list view read the same tree: cards, then families,
 * then every feature of a family in catalog order with its depth under its
 * parent. Search and the state filter narrow that tree; they never change a
 * family's counts, which describe the whole family.
 */

export interface FeatureRowModel {
  feature: FeatureDefinition;
  assessment: FeatureAssessment;
  /** 0 for a top-level feature, 1 for a child of it, and so on. */
  depth: number;
  /** For a needs-newer row: a newer version, or the client or host. */
  needsNewer?: NeedsNewerCause;
}

export interface FamilyModel {
  family: FeatureFamilyDefinition;
  counts: FeatureStateCounts;
  leafCount: number;
  rows: readonly FeatureRowModel[];
}

export interface CardModel {
  id: FeatureCardId;
  name: string;
  counts: FeatureStateCounts;
  leafCount: number;
  families: readonly FamilyModel[];
}

export const FEATURE_FILTERS = [
  { id: "all", label: "All" },
  { id: "could-add", label: "Could add" },
  { id: "not-checked", label: "Not checked" },
  { id: "supported", label: "Supported" },
  { id: "needs-newer", label: "Needs newer version or client" },
  { id: "check-failed", label: "Check failed" },
] as const satisfies ReadonlyArray<{
  id: "all" | FeatureUserState;
  label: string;
}>;
export type FeatureFilter = (typeof FEATURE_FILTERS)[number]["id"];

export function isFeatureFilter(value: string): value is FeatureFilter {
  return FEATURE_FILTERS.some((filter) => filter.id === value);
}

function depthOf(
  feature: FeatureDefinition,
  byId: ReadonlyMap<string, FeatureDefinition>,
): number {
  let depth = 0;
  let parent = feature.parent ? byId.get(feature.parent) : undefined;
  while (parent && depth < 8) {
    depth += 1;
    parent = parent.parent ? byId.get(parent.parent) : undefined;
  }
  return depth;
}

/**
 * Needs-newer causes for every row. A parent that only took its state from
 * its children (no evidence or reason of its own) takes their cause when
 * they agree, and none when they differ.
 */
function needsNewerCauses(
  catalog: readonly FeatureDefinition[],
  evaluation: ServerFeatureEvaluation,
): Map<string, NeedsNewerCause | undefined> {
  const childrenOf = new Map<string, string[]>();
  for (const feature of catalog) {
    if (!feature.parent) continue;
    childrenOf.set(feature.parent, [
      ...(childrenOf.get(feature.parent) ?? []),
      feature.id,
    ]);
  }
  const causes = new Map<string, NeedsNewerCause | undefined>();
  // Children follow their parent in the catalog, so walking backwards
  // settles them first.
  for (const feature of [...catalog].reverse()) {
    const assessment = evaluation.assessments[feature.id];
    if (assessment?.state !== "needs-newer") continue;
    const children = childrenOf.get(feature.id);
    const rolledUp =
      children !== undefined &&
      assessment.evidence.length === 0 &&
      assessment.reason === undefined;
    if (!rolledUp) {
      causes.set(feature.id, needsNewerCause(feature, assessment));
      continue;
    }
    const childCauses = new Set(
      children
        .filter((id) => evaluation.assessments[id]?.state === "needs-newer")
        .map((id) => causes.get(id)),
    );
    causes.set(
      feature.id,
      childCauses.size === 1 ? [...childCauses][0] : undefined,
    );
  }
  return causes;
}

export function buildFeatureCards(
  catalog: readonly FeatureDefinition[],
  evaluation: ServerFeatureEvaluation,
): CardModel[] {
  const byId = new Map(catalog.map((feature) => [feature.id, feature]));
  const causes = needsNewerCauses(catalog, evaluation);
  const rowsByFamily = new Map<FeatureFamilyId, FeatureRowModel[]>();
  for (const feature of catalog) {
    const assessment = evaluation.assessments[feature.id];
    if (!assessment) continue;
    const rows = rowsByFamily.get(feature.family) ?? [];
    rows.push({
      feature,
      assessment,
      depth: depthOf(feature, byId),
      needsNewer: causes.get(feature.id),
    });
    rowsByFamily.set(feature.family, rows);
  }
  const familySummary = new Map(
    evaluation.families.map((summary) => [summary.id, summary]),
  );
  const cardSummary = new Map(
    evaluation.cards.map((summary) => [summary.id, summary]),
  );
  return FEATURE_CARDS.flatMap((card) => {
    const summary = cardSummary.get(card.id);
    if (!summary) return [];
    const families = familiesForCard(card.id).flatMap((family) => {
      const familyCounts = familySummary.get(family.id);
      if (!familyCounts) return [];
      return [
        {
          family,
          counts: familyCounts.counts,
          leafCount: familyCounts.leafCount,
          rows: rowsByFamily.get(family.id) ?? [],
        },
      ];
    });
    return [
      {
        id: card.id,
        name: card.name,
        counts: summary.counts,
        leafCount: summary.leafCount,
        families,
      },
    ];
  });
}

function matchesQuery(text: string, query: string): boolean {
  return text.toLowerCase().includes(query);
}

export interface FilteredFeatureCards {
  cards: CardModel[];
  /** Search or a state filter is narrowing the tree. */
  active: boolean;
  /**
   * Leaf features that match, the unit the card and family counts use.
   * Parents shown for context are not counted.
   */
  matchCount: number;
}

function leafRowCount(cards: readonly CardModel[]): number {
  let count = 0;
  for (const card of cards) {
    for (const family of card.families) {
      const parents = new Set(family.rows.map((row) => row.feature.parent));
      count += family.rows.filter((row) => !parents.has(row.feature.id)).length;
    }
  }
  return count;
}

/**
 * Keep the leaf rows whose state passes `filter` and whose official name or
 * id contains `query`, plus their parents so a child never shows without its
 * group. A family or parent whose name or id matches counts as a match for
 * every leaf under it.
 */
export function filterFeatureCards(
  cards: readonly CardModel[],
  { query, filter }: { query: string; filter: FeatureFilter },
): FilteredFeatureCards {
  const needle = query.trim().toLowerCase();
  if (!needle && filter === "all") {
    return { cards: [...cards], active: false, matchCount: leafRowCount(cards) };
  }
  let matchCount = 0;
  const filtered = cards.flatMap((card) => {
    const families = card.families.flatMap((family) => {
      const familyMatches = needle
        ? matchesQuery(family.family.name, needle) ||
          matchesQuery(family.family.id, needle)
        : true;
      const parentOf = new Map(
        family.rows.map((row) => [row.feature.id, row.feature.parent]),
      );
      const parents = new Set(parentOf.values());
      // Rows come in catalog order, so a parent is settled before its children.
      const textOk = new Map<string, boolean>();
      const keep = new Set<string>();
      for (const row of family.rows) {
        const id = row.feature.id;
        const parent = row.feature.parent;
        const matched =
          familyMatches ||
          matchesQuery(row.feature.name, needle) ||
          matchesQuery(id, needle) ||
          (parent !== undefined && textOk.get(parent) === true);
        textOk.set(id, matched);
        if (parents.has(id)) continue;
        const stateOk = filter === "all" || row.assessment.state === filter;
        if (!stateOk || !matched) continue;
        matchCount += 1;
        keep.add(id);
      }
      if (keep.size === 0) return [];
      for (const id of [...keep]) {
        let parent = parentOf.get(id);
        while (parent && !keep.has(parent)) {
          keep.add(parent);
          parent = parentOf.get(parent);
        }
      }
      return [
        { ...family, rows: family.rows.filter((row) => keep.has(row.feature.id)) },
      ];
    });
    return families.length > 0 ? [{ ...card, families }] : [];
  });
  return { cards: filtered, active: true, matchCount };
}

export type FeatureSelection =
  | { kind: "feature"; feature: FeatureDefinition; family: FeatureFamilyDefinition }
  | { kind: "family"; family: FeatureFamilyDefinition };

/**
 * A `?feature=` value: a feature id, or a family id for the whole family.
 * Anything else is ignored.
 */
export function resolveFeatureSelection(
  id: string | null | undefined,
  catalog: readonly FeatureDefinition[],
): FeatureSelection | null {
  if (!id) return null;
  const feature = catalog.find((entry) => entry.id === id);
  if (feature) {
    const family = FEATURE_FAMILIES.find((entry) => entry.id === feature.family);
    return family ? { kind: "feature", feature, family } : null;
  }
  const family = FEATURE_FAMILIES.find((entry) => entry.id === id);
  return family ? { kind: "family", family } : null;
}
