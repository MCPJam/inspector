import { useEffect, useRef, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { authFetch } from "@/lib/session-token";
import type { Predicate } from "@mcpjam/sdk/predicates";
import type { EvalBacktestReport } from "@mcpjam/sdk/contract";

/** Explicit, non-billed preview of draft assertions; never commits suite settings. */
export function AssertionBacktestPanel({
  projectId,
  runId,
  assertions,
}: {
  projectId?: string;
  runId?: string;
  assertions: Predicate[];
}) {
  const [report, setReport] = useState<EvalBacktestReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [coolingDown, setCoolingDown] = useState(false);
  useEffect(() => {
    const remaining = cooldownUntil - Date.now();
    setCoolingDown(remaining > 0);
    if (remaining > 0) {
      const timer = setTimeout(() => setCoolingDown(false), remaining);
      return () => clearTimeout(timer);
    }
  }, [cooldownUntil]);
  useEffect(() => setCooldownUntil(0), [projectId, runId]);
  const request = useRef<AbortController | null>(null);
  const fingerprint = JSON.stringify({ projectId, runId, assertions });
  useEffect(() => {
    request.current?.abort();
    setReport(null);
    setError(null);
    setPending(false);
    return () => request.current?.abort();
  }, [fingerprint]);
  async function preview(more = false) {
    if (!projectId || !runId) return;
    const previous = more ? report : null;
    if (more && !previous?.continuation) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setPending(true);
    if (!more) setReport(null);
    setError(null);
    try {
      const response = await authFetch(
        `/api/v1/projects/${encodeURIComponent(
          projectId,
        )}/eval-runs/${encodeURIComponent(runId)}/backtest`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assertions: { mode: "replace", list: assertions },
            ...(previous?.continuation
              ? { continuation: previous.continuation }
              : {}),
          }),
          signal: controller.signal,
        },
      );
      const body = await response.json();
      if (controller.signal.aborted) return;
      if (response.status === 429) {
        const seconds = Number(response.headers?.get("Retry-After") ?? 60);
        setCooldownUntil(
          Date.now() +
            1000 *
              (Number.isFinite(seconds)
                ? Math.max(0, Math.min(seconds, 600))
                : 60),
        );
      }
      if (!response.ok)
        throw new Error(
          body.message ?? body.error?.message ?? "The preview could not run",
        );
      const result = body as EvalBacktestReport;
      if (
        result?.schemaVersion !== 1 ||
        result.sourceRunId !== runId ||
        !result.counts ||
        !Array.isArray(result.differences)
      )
        throw new Error("The preview returned an unsupported response");
      if (controller.signal.aborted) return;
      if (!more) setCooldownUntil(Date.now() + 60_000);
      if (previous) {
        if (
          previous.sourceHash !== result.sourceHash ||
          previous.draftHash !== result.draftHash
        )
          throw new Error("Preview source changed; start a new preview");
        const seen = new Set(
          previous.differences.map(
            (row) => `${row.iterationId}:${row.evaluatorId}`,
          ),
        );
        if (
          result.differences.some((row) =>
            seen.has(`${row.iterationId}:${row.evaluatorId}`),
          )
        )
          throw new Error("Preview returned duplicate evidence");
        const counts = {
          iterations: previous.counts.iterations + result.counts.iterations,
          comparable: previous.counts.comparable + result.counts.comparable,
          ungradable: previous.counts.ungradable + result.counts.ungradable,
          flipped: previous.counts.flipped + result.counts.flipped,
        };
        setReport({
          ...result,
          counts,
          complete:
            !result.continuationAvailable &&
            counts.ungradable === 0 &&
            counts.comparable > 0,
          differences: [...previous.differences, ...result.differences],
        });
      } else setReport(result);
    } catch (caught) {
      if (!controller.signal.aborted)
        setError(
          caught instanceof Error
            ? caught.message
            : "The preview could not run",
        );
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }
  return (
    <section
      className="space-y-3 rounded-md border border-border p-3"
      aria-label="Assertion preview"
      data-setting-key="assertionBacktest"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Assertion preview</p>
          <p className="text-xs text-muted-foreground">
            Apply this assertion list to captured iterations from the latest
            finished run. Existing case overrides are replaced for this preview.
            No model credits are used.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={
            pending ||
            coolingDown ||
            !projectId ||
            !runId ||
            assertions.length === 0
          }
          onClick={() => void preview()}
        >
          {pending ? "Previewing…" : "Preview assertions"}
        </Button>
      </div>
      {coolingDown ? (
        <p className="text-xs text-muted-foreground">
          Wait one minute before starting another assertion preview. You can
          continue this preview below; judge previews have a separate cooldown.
        </p>
      ) : null}
      {!runId ? (
        <p className="text-xs text-muted-foreground">
          Finish a run to preview these assertions against captured evidence.
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {report ? (
        <div className="space-y-2" aria-live="polite">
          <p className="text-sm">
            {report.complete ? "Complete comparison" : "Partial comparison"} ·{" "}
            {report.counts.flipped} changed outcomes ·{" "}
            {report.counts.comparable} comparable observations ·{" "}
            {report.counts.ungradable} ungradable
          </p>
          {report.continuationAvailable ? (
            <p className="text-xs text-muted-foreground">
              The preview reached its iteration limit. It does not describe the
              full run.{" "}
              {report.continuation ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => void preview(true)}
                >
                  Load more evidence
                </Button>
              ) : null}
            </p>
          ) : null}
          <ul className="max-h-60 overflow-auto space-y-1 text-xs">
            {report.differences.map((row, index) => (
              <li key={`${row.iterationId}:${row.evaluatorId}:${index}`}>
                <span className="font-mono">{row.evaluatorId}</span>
                {" · "}
                {row.comparable
                  ? row.flipped
                    ? "outcome changed"
                    : "same outcome"
                  : row.reason ?? row.change}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Stored results and suite settings are unchanged.
          </p>
        </div>
      ) : null}
    </section>
  );
}
