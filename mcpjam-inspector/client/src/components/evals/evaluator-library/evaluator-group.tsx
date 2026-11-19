import { Button } from "@mcpjam/design-system/button";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { CheckRow, type CheckRowConfigProps } from "./check-row";
import { EvaluatorKindBadge } from "./evaluator-kind-badge";
import type {
  EvaluatorMethod,
  EvaluatorOrigin,
} from "./evaluator-library-types";

export type EvaluatorGroupProps = {
  name: string;
  /** The pinned version, e.g. "v2". */
  version: string;
  origin: EvaluatorOrigin;
  method: EvaluatorMethod;
  checks: readonly (CheckRowConfigProps & { id: string })[];
  /** A newer library version the suite has not accepted yet. */
  updateAvailable?: string;
  onAcceptUpdate?: () => void;
  onRemove?: () => void;
  defaultCollapsed?: boolean;
};

/**
 * The checks that came from one evaluator, grouped inside a suite stage so
 * you can see where a check came from and remove it in one click. The
 * version is pinned: a library update changes nothing until it is accepted.
 */
export function EvaluatorGroup({
  name,
  version,
  origin,
  method,
  checks,
  updateAvailable,
  onAcceptUpdate,
  onRemove,
  defaultCollapsed = false,
}: EvaluatorGroupProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const listId = useId();
  return (
    <section
      aria-label={name}
      className="overflow-hidden rounded-lg border border-border bg-popover"
    >
      <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-2">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={listId}
          onClick={() => setCollapsed((v) => !v)}
          className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-card-foreground"
        >
          {collapsed ? (
            <ChevronRight aria-hidden className="size-4" />
          ) : (
            <ChevronDown aria-hidden className="size-4" />
          )}
          <span className="truncate">{name}</span>
        </button>
        <span className="font-mono text-xs text-muted-foreground">
          {version}
        </span>
        <EvaluatorKindBadge origin={origin} />
        <EvaluatorKindBadge method={method} />
        <span className="ml-auto flex items-center gap-1">
          {updateAvailable && onAcceptUpdate ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onAcceptUpdate}
            >
              Update to {updateAvailable}
            </Button>
          ) : null}
          {onRemove ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Remove ${name}`}
              onClick={onRemove}
            >
              <Trash2 aria-hidden />
            </Button>
          ) : null}
        </span>
      </div>
      {collapsed ? null : (
        <ul id={listId} className="divide-y divide-border">
          {checks.map(({ id, ...check }) => (
            <CheckRow key={id} {...check} />
          ))}
        </ul>
      )}
    </section>
  );
}
