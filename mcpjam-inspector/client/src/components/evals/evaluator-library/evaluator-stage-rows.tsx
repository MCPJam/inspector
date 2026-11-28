import { Button } from "@mcpjam/design-system/button";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { EvaluatorKindBadge } from "./evaluator-kind-badge";
import { EvaluatorPresetIcon } from "./evaluator-preset-icon";
import { useEvaluatorLibraryEnabled } from "./evaluator-library-flag";
import { findLibraryEvaluator } from "./library-catalog";

type Cluster<Row> = { evaluatorId: string; version: number; rows: Row[] };

/** A library evaluator's card; each check that did not come from one gets the same. */
const EVALUATOR_CARD_CLASS = "rounded-lg border border-border bg-muted/20 p-3";

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
 * evaluator version, in first-appearance order.
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
    const cluster = clusters.find(
      (c) => c.evaluatorId === origin.id && c.version === origin.version,
    );
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
 * Reuses the suite table's check rows so editing stays available in a group.
 * With the evaluator library on, every check that did not come from the
 * library gets a card of its own, so the stage reads as a list of evaluators
 * whichever way each one was added.
 */
export function EvaluatorStageRows<Row extends { id: string }>({
  rows,
  stageLabel,
  predicateOf,
  renderRow,
  modelRows = [],
  onRemoveEvaluator,
  onUpdateEvaluator,
  updateRefusal,
}: {
  rows: readonly Row[];
  stageLabel: string;
  predicateOf: (row: Row) => Predicate | undefined;
  renderRow: (row: Row) => ReactNode;
  /** Library questions and judges to show under their evaluator here. */
  modelRows?: readonly LibraryModelRow[];
  /** Omitted where the rows are inherited and cannot be edited here. */
  onRemoveEvaluator?: (evaluatorId: string) => void;
  onUpdateEvaluator?: (evaluatorId: string) => void;
  /** Why Update cannot apply; shown in its place, so it is never a no-op. */
  updateRefusal?: (evaluatorId: string) => string | undefined;
}) {
  const enabled = useEvaluatorLibraryEnabled();
  if (!enabled) return <ul className="space-y-3">{rows.map(renderRow)}</ul>;
  const { loose, clusters } = clusterByEvaluator(rows, predicateOf);
  const inCluster = (m: LibraryModelRow, c: Cluster<Row>) =>
    m.evaluator.id === c.evaluatorId && m.evaluator.version === c.version;
  for (const m of modelRows) {
    if (!clusters.some((c) => inCluster(m, c))) {
      clusters.push({
        evaluatorId: m.evaluator.id,
        version: m.evaluator.version,
        rows: [],
      });
    }
  }
  return (
    <div className="space-y-3">
      {loose.map((row) => (
        <ul key={row.id} className={EVALUATOR_CARD_CLASS}>
          {renderRow(row)}
        </ul>
      ))}
      {clusters.map((cluster) => {
        const entry = findLibraryEvaluator(cluster.evaluatorId);
        const name = entry?.name ?? cluster.evaluatorId;
        const newer =
          entry && entry.version > cluster.version ? entry.version : undefined;
        const refusal =
          newer && onUpdateEvaluator
            ? updateRefusal?.(cluster.evaluatorId)
            : undefined;
        return (
          <section
            key={`${cluster.evaluatorId}:${cluster.version}`}
            aria-label={`${name} in ${stageLabel}, version ${cluster.version}`}
            data-evaluator-group={cluster.evaluatorId}
            className={EVALUATOR_CARD_CLASS}
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
                {refusal ? (
                  <span className="text-xs text-muted-foreground">
                    v{newer} available. {refusal}
                  </span>
                ) : newer && onUpdateEvaluator ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={`Update ${name} to v${newer} across all stages`}
                    title="Update across all stages"
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
                    aria-label={`Remove ${name} from all stages`}
                    title="Remove from all stages"
                    onClick={() => onRemoveEvaluator(cluster.evaluatorId)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                ) : null}
              </span>
            </div>
            <ul className="space-y-3">
              {cluster.rows.map(renderRow)}
              {modelRows
                .filter((m) => inCluster(m, cluster))
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
