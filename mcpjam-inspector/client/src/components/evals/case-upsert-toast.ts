import { toast } from "sonner";

/**
 * Structured result of the per-case upsert loop in
 * `runEvalsWithManager`. Cases are NOT rolled back on partial failure — the
 * point of this surface is visibility, not atomicity. The UI shows a single
 * status line summarizing committed vs. failed counts and exposes the raw
 * failure list via "View details" (console).
 */
export type CaseUpsertResult = {
  committed: Array<{ id?: string; name: string }>;
  failed: Array<{ id?: string; name: string; error: string }>;
};

export function isCaseUpsertResult(value: unknown): value is CaseUpsertResult {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as { committed?: unknown }).committed) &&
    Array.isArray((value as { failed?: unknown }).failed)
  );
}

/**
 * If the server reported per-case upsert failures, surface a non-error toast
 * (the run still started — partial state is intentional). Returns true when a
 * partial-failure toast was emitted.
 */
export function notifyCaseUpsertPartial(
  result: unknown,
  options?: { context?: string },
): boolean {
  if (!isCaseUpsertResult(result)) {
    return false;
  }
  const { committed, failed } = result;
  if (failed.length === 0) {
    return false;
  }
  const total = committed.length + failed.length;
  const context = options?.context ?? "Saved";
  toast.warning(
    `${context} ${committed.length}/${total} cases — ${failed.length} failed`,
    {
      description:
        "The run started with the cases that saved. Open the console for the failure list.",
      action: {
        label: "View details",
        onClick: () => {
          // Surface the structured failure list to the console so power users
          // can copy/paste it into a bug report. We deliberately don't render
          // a modal; this is a minimal escape hatch.
          // eslint-disable-next-line no-console
          console.warn("[evals] Per-case upsert failures", {
            committed,
            failed,
          });
        },
      },
    },
  );
  return true;
}
