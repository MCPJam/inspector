import { Button } from "@mcpjam/design-system/button";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { EvaluatorKindBadge } from "./evaluator-kind-badge";
import { EvaluatorPresetIcon } from "./evaluator-preset-icon";
import { useEvaluatorLibraryEnabled } from "./evaluator-library-flag";
import { findLibraryEvaluator } from "./library-catalog";

type Cluster<Row> = { evaluatorId: string; version: number; rows: Row[] };

/** A library question or judge, shown under its evaluator; graded by a model. */
export type LibraryModelRow = {
  key: string;
  label: string;
  /** "Yes/no question, passes on Yes", "Judge prompt, pass or fail". */
  detail: string;
  evaluator: { id: string; version: number };
  /** Library judges: replace with an editable copy. */
  onCustomize?: () => void;
};

/**
 * Splits a stage's rows into hand-written ones and one cluster per library
 * evaluator, in first-appearance order.
 */
export function clusterByEvaluator<Row>(
  rows: readonly Row[],
  predicateOf: (row: Row) => Predicate | undefined,
): { loose: Row[]; clusters: Cluster<Row>[] } {
  const loose: Row[] = [];
  const clusters: Cluster<Row>[] = [];
  for (const row of rows) {
    const origin = predicateOf(row)?.evaluator;
    if (!origin) {
      loose.push(row);
      continue;
    }
    const cluster = clusters.find((c) => c.evaluatorId === origin.id);
    if (cluster) cluster.rows.push(row);
    else
      clusters.push({
        evaluatorId: origin.id,
        version: origin.version,
        rows: [row],
      });
  }
  return { loose, clusters };
}

/**
 * A stage's rows in the suite table. With the evaluator library on, checks
 * added from the library sit together under their evaluator, with its pinned
 * version, a newer version to accept, and one-click removal. Each check keeps
 * the table's own row, so editing it works exactly as it does today. Every
 * other check gets a card of its own, so the stage reads as a list of
 * evaluators whichever way each one was added.
 */
export function EvaluatorStageRows<Row extends { id: string }>({
  rows,
  predicateOf,
  renderRow,
  modelRows = [],
  onRemoveEvaluator,
  onUpdateEvaluator,
}: {
  rows: readonly Row[];
  predicateOf: (row: Row) => Predicate | undefined;
  /** `isDefault`: the row did not come from the library and gets its own card. */
  renderRow: (row: Row, isDefault: boolean) => ReactNode;
  /** Library questions and judges to show under their evaluator here. */
  modelRows?: readonly LibraryModelRow[];
  /** Omitted where the rows are inherited and cannot be edited here. */
  onRemoveEvaluator?: (evaluatorId: string) => void;
  onUpdateEvaluator?: (evaluatorId: string) => void;
}) {
  const enabled = useEvaluatorLibraryEnabled();
  if (!enabled) {
    return (
      <ul className="space-y-3">{rows.map((row) => renderRow(row, false))}</ul>
    );
  }
  const { loose, clusters } = clusterByEvaluator(rows, predicateOf);
  for (const m of modelRows) {
    if (!clusters.some((c) => c.evaluatorId === m.evaluator.id)) {
      clusters.push({
        evaluatorId: m.evaluator.id,
        version: m.evaluator.version,
        rows: [],
      });
    }
  }
  return (
    <div className="space-y-3">
      {loose.length ? (
        // One card per default check, shaped like a library evaluator's card.
        <ul className="space-y-3 [&>li]:rounded-lg [&>li]:border [&>li]:border-border [&>li]:bg-muted/20 [&>li]:p-3">
          {loose.map((row) => renderRow(row, true))}
        </ul>
      ) : null}
      {clusters.map((cluster) => {
        const entry = findLibraryEvaluator(cluster.evaluatorId);
        const name = entry?.name ?? cluster.evaluatorId;
        const newer =
          entry && entry.version > cluster.version ? entry.version : undefined;
        return (
          <section
            key={cluster.evaluatorId}
            aria-label={name}
            data-evaluator-group={cluster.evaluatorId}
            className="rounded-lg border border-border bg-muted/20 p-3"
          >
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {entry ? (
                <EvaluatorPresetIcon
                  icon={entry.icon}
                  tone={entry.tone}
                  className="size-7"
                />
              ) : null}
              <span className="text-sm font-medium text-foreground">
                {name}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                v{cluster.version}
              </span>
              <EvaluatorKindBadge origin="library" />
              <span className="ml-auto flex items-center gap-1">
                {newer && onUpdateEvaluator ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onUpdateEvaluator(cluster.evaluatorId)}
                  >
                    Update to v{newer}
                  </Button>
                ) : null}
                {onRemoveEvaluator ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${name}`}
                    onClick={() => onRemoveEvaluator(cluster.evaluatorId)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                ) : null}
              </span>
            </div>
            <ul className="space-y-3">
              {cluster.rows.map((row) => renderRow(row, false))}
              {modelRows
                .filter((m) => m.evaluator.id === cluster.evaluatorId)
                .map((m) => (
                  <li
                    key={m.key}
                    className="flex items-start justify-between gap-3 text-sm"
                  >
                    <span>
                      <span className="text-foreground">{m.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {m.detail}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      {m.onCustomize ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={m.onCustomize}
                        >
                          Customize
                        </Button>
                      ) : null}
                      <span className="rounded-sm border border-border/60 px-1.5 py-px text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                        Advisory
                      </span>
                    </span>
                  </li>
                ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
