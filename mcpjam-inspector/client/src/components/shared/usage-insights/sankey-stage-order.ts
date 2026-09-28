import { useCallback, useEffect, useState } from "react";

import type { InsightsScope } from "@/hooks/useUsageInsights";

/** One localStorage blob, keyed by surface so swarms do not share a bench order. */
export const STAGE_ORDER_STORAGE_KEY = "sankey-stage-order";

export type SankeyStageLayout = {
  order: string[];
  hidden: string[];
};

/**
 * Replay a saved permutation onto the live stage list. Unknown ids (a removed
 * question) drop out; new ids append so a freshly added column is not lost.
 */
export function applyStageOrder<S extends string>(
  stages: readonly S[],
  saved: readonly string[] | null | undefined,
): S[] {
  if (!saved?.length) return [...stages];
  const known = new Set(stages);
  const ordered = saved.filter((id): id is S => known.has(id as S));
  for (const stage of stages) {
    if (!ordered.includes(stage)) ordered.push(stage);
  }
  return ordered;
}

/** Drop hidden ids. Keep one column if the hide list would empty the chart. */
export function applyStageVisibility<S extends string>(
  stages: readonly S[],
  hidden: readonly string[] | null | undefined,
): S[] {
  if (!hidden?.length) return [...stages];
  const hide = new Set(hidden);
  const visible = stages.filter((stage) => !hide.has(stage));
  return visible.length > 0 ? visible : [stages[0]];
}

/**
 * Write a visible drag back onto the full list so hidden columns keep their
 * slots instead of jumping to the end when restored.
 */
export function mergeVisibleOrder<S extends string>(
  full: readonly S[],
  visibleNext: readonly S[],
  hidden: readonly string[],
): S[] {
  const hide = new Set(hidden);
  const next = [...visibleNext];
  const merged = full.map((stage) =>
    hide.has(stage) ? stage : (next.shift() ?? stage),
  );
  return merged.concat(next.filter((stage) => !merged.includes(stage)));
}

export function parseStageLayout(value: unknown): SankeyStageLayout | null {
  if (Array.isArray(value) && value.every((id) => typeof id === "string")) {
    return { order: value, hidden: [] };
  }
  if (!value || typeof value !== "object") return null;
  const record = value as { order?: unknown; hidden?: unknown };
  if (
    !Array.isArray(record.order) ||
    !record.order.every((id) => typeof id === "string")
  ) {
    return null;
  }
  return {
    order: record.order,
    hidden: Array.isArray(record.hidden)
      ? record.hidden.filter((id): id is string => typeof id === "string")
      : [],
  };
}

export function stageOrderStorageKey(scope: InsightsScope): string {
  switch (scope.kind) {
    case "scenario":
      return `${scope.kind}:${scope.scenarioId}`;
    case "swarm":
      return `${scope.kind}:${scope.projectId}`;
    case "benchmark":
      return `${scope.kind}:${scope.benchmarkRunId}`;
  }
}

function loadStageLayout(scopeKey: string): SankeyStageLayout | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STAGE_ORDER_STORAGE_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as Record<string, unknown>;
    return parseStageLayout(all[scopeKey]);
  } catch {
    return null;
  }
}

function saveStageLayout(scopeKey: string, layout: SankeyStageLayout): void {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(STAGE_ORDER_STORAGE_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    all[scopeKey] = layout;
    localStorage.setItem(STAGE_ORDER_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // quota / private mode — keep the in-memory order for this session
  }
}

function emptyLayout(): SankeyStageLayout {
  return { order: [], hidden: [] };
}

/**
 * Display order and hide-list for Sankey columns. The catalog has no sequence
 * mutation, so both live in localStorage (same pattern as the Servers tab).
 */
export function useSankeyStageOrder<S extends string>(
  stages: readonly S[],
  scopeKey?: string,
): {
  stages: S[];
  hidden: S[];
  onReorder: (next: readonly S[]) => void;
  onHide: (stage: S) => void;
  onRestore: (stage: S) => void;
} {
  const [saved, setSaved] = useState<SankeyStageLayout | null>(() =>
    scopeKey ? loadStageLayout(scopeKey) : null,
  );

  useEffect(() => {
    setSaved(scopeKey ? loadStageLayout(scopeKey) : null);
  }, [scopeKey]);

  const persist = useCallback(
    (next: SankeyStageLayout) => {
      setSaved(next);
      if (scopeKey) saveStageLayout(scopeKey, next);
    },
    [scopeKey],
  );

  const full = applyStageOrder(stages, saved?.order);
  const hiddenSet = new Set(saved?.hidden ?? []);
  const hidden = full.filter((stage) => hiddenSet.has(stage));
  const visible = applyStageVisibility(full, saved?.hidden);

  const onReorder = useCallback(
    (next: readonly S[]) => {
      const current = saved ?? emptyLayout();
      const ordered = applyStageOrder(stages, current.order);
      persist({
        order: mergeVisibleOrder(ordered, next, current.hidden),
        hidden: current.hidden,
      });
    },
    [persist, saved, stages],
  );

  const onHide = useCallback(
    (stage: S) => {
      const current = saved ?? emptyLayout();
      const ordered = applyStageOrder(stages, current.order);
      const nextHidden = current.hidden.includes(stage)
        ? current.hidden
        : [...current.hidden, stage];
      if (ordered.every((id) => nextHidden.includes(id))) return;
      persist({ order: ordered, hidden: nextHidden });
    },
    [persist, saved, stages],
  );

  const onRestore = useCallback(
    (stage: S) => {
      const current = saved ?? emptyLayout();
      persist({
        order: applyStageOrder(stages, current.order),
        hidden: current.hidden.filter((id) => id !== stage),
      });
    },
    [persist, saved, stages],
  );

  return { stages: visible, hidden, onReorder, onHide, onRestore };
}
