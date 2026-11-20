import { Button } from "@mcpjam/design-system/button";
import type { Predicate } from "@mcpjam/sdk/predicates";
import type { RubricCheckQuestion } from "@/components/shared/session-quality/judge-config";
import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { EvaluatorKindBadge } from "./evaluator-kind-badge";
import { useEvaluatorLibraryEnabled } from "./evaluator-library-flag";
import { findLibraryEvaluator } from "./library-catalog";

type Cluster<Row> = { evaluatorId: string; version: number; rows: Row[] };

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
 * the table's own row, so editing it works exactly as it does today.
 */
export function EvaluatorStageRows<Row extends { id: string }>({
  rows,
  predicateOf,
  renderRow,
  questions = [],
  onRemoveEvaluator,
  onUpdateEvaluator,
}: {
  rows: readonly Row[];
  predicateOf: (row: Row) => Predicate | undefined;
  renderRow: (row: Row) => ReactNode;
  /** Rubric-check questions to show under their evaluator in this stage. */
  questions?: readonly RubricCheckQuestion[];
  /** Omitted where the rows are inherited and cannot be edited here. */
  onRemoveEvaluator?: (evaluatorId: string) => void;
  onUpdateEvaluator?: (evaluatorId: string) => void;
}) {
  const enabled = useEvaluatorLibraryEnabled();
  if (!enabled) return <ul className="space-y-3">{rows.map(renderRow)}</ul>;
  const { loose, clusters } = clusterByEvaluator(rows, predicateOf);
  for (const q of questions) {
    if (
      q.evaluator &&
      !clusters.some((c) => c.evaluatorId === q.evaluator?.id)
    ) {
      clusters.push({
        evaluatorId: q.evaluator.id,
        version: q.evaluator.version,
        rows: [],
      });
    }
  }
  return (
    <div className="space-y-3">
      {loose.length ? (
        <ul className="space-y-3">{loose.map(renderRow)}</ul>
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
              {cluster.rows.map(renderRow)}
              {questions
                .filter((q) => q.evaluator?.id === cluster.evaluatorId)
                .map((q) => (
                  <li
                    key={q.id}
                    className="flex items-start justify-between gap-3 text-sm"
                  >
                    <span>
                      <span className="text-foreground">{q.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        Yes/no question, passes on{" "}
                        {q.pass.answer === "no" ? "No" : "Yes"}
                      </span>
                    </span>
                    <span className="rounded-sm border border-border/60 px-1.5 py-px text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                      Advisory
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
