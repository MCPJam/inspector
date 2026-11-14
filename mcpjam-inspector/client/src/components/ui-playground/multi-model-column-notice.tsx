import { AlertTriangle, Info } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";

/**
 * Shown above the composer while one column of a multi-model session is open
 * alone. Sending from here starts a new chat, so the session keeps every
 * column on the same turns.
 */
export function MultiModelColumnNotice({
  onOpenSession,
  opening,
}: {
  onOpenSession: () => void;
  opening: boolean;
}) {
  return (
    <div
      className="mx-2 mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-foreground"
      role="status"
      data-testid="multi-model-column-notice"
    >
      <Info className="size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        This is one column of a multi-model session. Sending starts a new chat
        and leaves the session as it was.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={opening}
        onClick={onOpenSession}
      >
        Open multi-model session
      </Button>
    </div>
  );
}

export interface MissingColumn {
  label: string;
  reason: "model" | "client";
  open: () => void;
}

/**
 * A reopened session with columns that could not come back: their model is no
 * longer offered, or their client left the project. Their chats are intact and
 * open on their own.
 */
export function MultiModelMissingColumnsNotice({
  columns,
}: {
  columns: readonly MissingColumn[];
}) {
  return (
    <div
      className="mx-2 mb-2 flex flex-col gap-1.5 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-[11px] leading-relaxed text-foreground"
      role="status"
      data-testid="multi-model-missing-columns-notice"
    >
      {columns.map((column) => (
        <div key={column.label} className="flex items-center gap-2">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1">
            {column.reason === "model"
              ? `${column.label} isn't available anymore, so its column didn't reopen.`
              : `The ${column.label} column's client isn't in this project anymore, so the column didn't reopen.`}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={column.open}>
            Open it alone
          </Button>
        </div>
      ))}
    </div>
  );
}

export function multiModelBranchToast(columnLabel: string | null): string {
  const column = columnLabel ? `the ${columnLabel} column` : "this column";
  return `Started a new chat from ${column}. The multi-model session didn't change.`;
}
