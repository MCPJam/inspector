/**
 * RunChecksModal — minimal Layer-C entry point for on-demand cross-surface
 * checks. Picks a project test suite, previews its `defaultPredicates`,
 * and POSTs to the Layer-B route (`/api/web/checks/run-predicates`) which
 * grades the stored chat session via `runPredicatesOnChatSession`.
 *
 * Scope gaps (intentional, deferred):
 *   - `setKind: "case_resolved"` (per-test-case predicate sets) — not
 *     exposed in the UI yet. Would need a case picker after the suite is
 *     chosen, plus the case-resolution view of `resolveCasePredicates`.
 *   - `setKind: "ad_hoc"` — no authoring UI in this modal; the eval
 *     `checks-section.tsx` already covers predicate authoring for
 *     iteration-level checks but is not yet wired into this surface.
 *   - Saved "check sets" library (`checkSets` table) — separate product
 *     decision; the plan explicitly defers it.
 *
 * Once a run succeeds, the modal closes; live verdicts re-render through
 * the `<ChatSessionVerdicts>` panel via the Convex subscription on
 * `chatSessionChecks`.
 */
import { useEffect, useMemo, useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { Loader2, Play } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { authFetch } from "@/lib/session-token";
import type { EvalSuiteOverviewEntry } from "@/components/evals/types";
import { summarizePredicate } from "@/components/evals/predicates-list";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chatSessionId: string;
  /** Convex project id to scope the suite picker. Required — checks are
   *  always run within a project. */
  projectId: string | null;
}

type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "error"; message: string };

export function RunChecksModal({
  open,
  onOpenChange,
  chatSessionId,
  projectId,
}: Props) {
  const { isAuthenticated } = useConvexAuth();
  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunState>({ kind: "idle" });

  const overview = useQuery(
    "testSuites:getTestSuitesOverview" as any,
    isAuthenticated && projectId ? ({ projectId } as any) : "skip",
  ) as EvalSuiteOverviewEntry[] | undefined;

  // Reset modal state on close so re-opening starts fresh — keeps the
  // "Run again" flow predictable instead of resurrecting a stale error.
  useEffect(() => {
    if (!open) {
      setRunState({ kind: "idle" });
    }
  }, [open]);

  const suites = useMemo(() => {
    if (!overview) return [];
    return [...overview].sort(
      (a, b) =>
        (b.suite.updatedAt ?? b.suite._creationTime ?? 0) -
        (a.suite.updatedAt ?? a.suite._creationTime ?? 0),
    );
  }, [overview]);

  // Default selection: the most recently-updated suite, if any. Re-runs
  // whenever the overview hydrates or the user re-opens the modal.
  useEffect(() => {
    if (!open) return;
    if (selectedSuiteId) return;
    if (suites.length === 0) return;
    setSelectedSuiteId(suites[0].suite._id);
  }, [open, selectedSuiteId, suites]);

  const selectedEntry = useMemo(
    () => suites.find((entry) => entry.suite._id === selectedSuiteId) ?? null,
    [suites, selectedSuiteId],
  );
  const predicates = selectedEntry?.suite.defaultPredicates ?? [];
  const canRun =
    runState.kind !== "running" &&
    !!selectedEntry &&
    predicates.length > 0 &&
    !!chatSessionId;

  const handleRun = async () => {
    if (!selectedEntry || predicates.length === 0) return;
    setRunState({ kind: "running" });
    try {
      const response = await authFetch("/api/web/checks/run-predicates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatSessionId,
          predicates,
          setKind: "suite_defaults",
          setRef: selectedEntry.suite._id,
          setVersion: selectedEntry.suite.configRevision,
        }),
      });
      if (!response.ok) {
        let detail = "";
        try {
          const body = (await response.json()) as { error?: string };
          detail = body?.error ?? "";
        } catch {
          /* ignore */
        }
        throw new Error(
          detail || `Run failed (${response.status} ${response.statusText})`,
        );
      }
      // Success: close the modal. The `<ChatSessionVerdicts>` panel
      // re-renders via its own Convex subscription on the new row.
      setRunState({ kind: "idle" });
      onOpenChange(false);
    } catch (err) {
      setRunState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] w-full max-w-xl overflow-y-auto"
        data-testid="run-checks-modal"
      >
        <DialogHeader>
          <DialogTitle>Run checks on this session</DialogTitle>
          <DialogDescription>
            Pick a test suite. Its default checks will be evaluated against
            this chat session's transcript.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <SuitePicker
            suites={suites}
            loading={overview === undefined}
            selectedSuiteId={selectedSuiteId}
            onSelect={setSelectedSuiteId}
            disabled={runState.kind === "running"}
          />

          <PredicatePreview
            suiteName={selectedEntry?.suite.name ?? null}
            predicates={predicates}
          />

          {runState.kind === "error" ? (
            <div
              role="alert"
              data-testid="run-checks-error"
              className="space-y-1 rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive"
            >
              <div className="font-semibold">Could not run checks</div>
              <div>{runState.message}</div>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={runState.kind === "running"}
          >
            Cancel
          </Button>
          <Button
            onClick={handleRun}
            disabled={!canRun}
            data-testid="run-checks-submit"
          >
            {runState.kind === "running" ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="mr-2 h-3.5 w-3.5" />
            )}
            {runState.kind === "error" ? "Retry" : "Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface SuitePickerProps {
  suites: EvalSuiteOverviewEntry[];
  loading: boolean;
  selectedSuiteId: string | null;
  onSelect: (suiteId: string) => void;
  disabled: boolean;
}

function SuitePicker({
  suites,
  loading,
  selectedSuiteId,
  onSelect,
  disabled,
}: SuitePickerProps) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading suites…
      </div>
    );
  }
  if (suites.length === 0) {
    return (
      <div
        data-testid="run-checks-no-suites"
        className="rounded border border-dashed border-border/40 bg-muted/10 p-3 text-xs text-muted-foreground"
      >
        No suites in this project yet. Create one in the Evals tab to author
        default checks.
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <label
        htmlFor="run-checks-suite-select"
        className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
      >
        Suite
      </label>
      <select
        id="run-checks-suite-select"
        data-testid="run-checks-suite-select"
        value={selectedSuiteId ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        disabled={disabled}
        className="w-full rounded border border-border bg-background p-2 text-sm"
      >
        {suites.map((entry) => (
          <option key={entry.suite._id} value={entry.suite._id}>
            {entry.suite.name}
            {entry.suite.defaultPredicates?.length
              ? ` (${entry.suite.defaultPredicates.length} checks)`
              : " (no checks)"}
          </option>
        ))}
      </select>
    </div>
  );
}

interface PredicatePreviewProps {
  suiteName: string | null;
  predicates: ReadonlyArray<{ type: string } & Record<string, unknown>>;
}

function PredicatePreview({ suiteName, predicates }: PredicatePreviewProps) {
  if (!suiteName) return null;
  if (predicates.length === 0) {
    return (
      <div
        data-testid="run-checks-no-predicates"
        className="rounded border border-dashed border-border/40 bg-muted/10 p-3 text-xs text-muted-foreground"
      >
        <span className="font-semibold">{suiteName}</span> has no default
        checks. Edit the suite in the Evals tab to add some.
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-border/40 bg-muted/10 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Checks to run ({predicates.length})
      </div>
      <ul className="space-y-1">
        {predicates.map((p, i) => (
          <li
            key={i}
            className="flex flex-wrap items-baseline gap-x-2 text-[11px]"
          >
            <span className="font-mono font-medium">{p.type}</span>
            <span className="truncate text-muted-foreground">
              {summarizePredicate(p as never)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
