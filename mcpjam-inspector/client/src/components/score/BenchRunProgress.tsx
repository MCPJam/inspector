/**
 * A run in flight, drawn from the last `GET /runs/:runId` and nothing else.
 *
 * There is no browser-side execution behind this screen, so there is also no
 * browser-side truth to reconcile: closing the tab, refreshing, or opening the
 * run in a second window all land on the same state, because the state is the
 * server's. That is what the polling shape buys, and why nothing here caches a
 * derived phase.
 *
 * Cancelling is a REQUEST, not an outcome. The worker learns about it on its
 * next heartbeat and stops launching children; the run stays in flight until
 * it says otherwise, and this screen keeps polling through that window rather
 * than declaring a cancellation the backend has not confirmed.
 */

import { Button } from "@mcpjam/design-system/button";
import { Loader2 } from "lucide-react";
import type { BenchRun } from "@/lib/apis/bench-api";
import {
  benchProgressFraction,
  benchProgressLabel,
} from "./bench-run-phase";

function formatMicros(micros: number | undefined): string | null {
  if (typeof micros !== "number" || !Number.isFinite(micros)) return null;
  const dollars = micros / 1_000_000;
  return dollars >= 1 ? `$${dollars.toFixed(2)}` : `$${dollars.toFixed(3)}`;
}

export function BenchRunProgress({
  run,
  onCancel,
  cancelling = false,
  error,
}: {
  run: BenchRun;
  onCancel: () => void;
  cancelling?: boolean;
  error?: string | null;
}) {
  const fraction = benchProgressFraction(run);
  const label = benchProgressLabel(run);
  const spent = formatMicros(run.budget?.chargedMicros);
  const ceiling = formatMicros(run.budget?.quotedMaxMicros);
  const cancelRequested = Boolean(run.cancelRequested) || cancelling;

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm font-medium">{label}</span>
      </div>

      <div
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
        role="presentation"
      >
        {fraction === null ? null : (
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width]"
            style={{ width: `${fraction * 100}%` }}
          />
        )}
      </div>
      {fraction === null ? (
        // Not a bar at zero: "we don't know how far along this is" and "nothing
        // has happened" are different statements about the same run.
        <p className="text-[11px] text-muted-foreground">
          No progress detail yet.
        </p>
      ) : (
        <p className="text-[11px] tabular-nums text-muted-foreground">
          {Math.round(fraction * 100)}% of the matrix reported
        </p>
      )}

      {run.budget?.status === "exhausted" ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          This run has spent its whole budget. It will finish with the evidence
          it already has, and anything it wrote is still cleaned up.
        </p>
      ) : null}

      {spent ? (
        <p className="text-[11px] text-muted-foreground">
          Spent {spent}
          {ceiling ? ` of a ${ceiling} ceiling` : ""}.
        </p>
      ) : null}

      {run.cleanup?.status === "running" ? (
        <p className="text-[11px] text-muted-foreground">
          Removing everything this run created.
        </p>
      ) : null}

      {error ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-400">
          {error}
        </div>
      ) : null}

      <div className="space-y-1">
        <Button
          size="sm"
          variant="outline"
          onClick={onCancel}
          disabled={cancelRequested}
        >
          {cancelRequested ? "Cancelling…" : "Cancel this run"}
        </Button>
        {cancelRequested ? (
          <p className="text-[11px] text-muted-foreground">
            Asked. The run stops after the case it is on, and we still clean up
            anything it wrote.
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            You can close this page — the run keeps going, and this link brings
            you back to it.
          </p>
        )}
      </div>
    </section>
  );
}
