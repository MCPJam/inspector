/**
 * The offline unified-findings preview.
 *
 * Renders the app's OWN finding components from a backend replay artifact:
 * no Convex, no authentication, no production data, no model key. If a
 * reviewer can open a finding here and check its count against the iteration
 * it names, the deterministic half of the experiment has done its job.
 *
 * The state buttons are simulations of the LIVE lifecycle, not of the data:
 * they toggle the props the panel would receive while a build is running or
 * after one failed. The findings themselves are always the real miner's
 * output for the selected case — nothing here invents a finding.
 */
import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./preview.css";

import { UnifiedFindingsPanel } from "@/components/shared/actionable-insights/unified-findings-panel";
import type { UnifiedFindingsMode } from "@/components/shared/actionable-insights/unified-findings-panel";
import type { FindingEvidenceLocator } from "@/components/shared/actionable-insights/finding-evidence";
import {
  experimentFor,
  parseReplayArtifact,
  provenanceForView,
  ReplayArtifactError,
  type ReplayArtifact,
  type ReplayCase,
  type ReplayIteration,
} from "./replay-artifact";

type Simulated =
  | "live"
  | "no-snapshot"
  | "build-pending"
  | "build-error"
  | "enrich-pending"
  | "enrich-error"
  | "backend-missing";

const SIMULATIONS: Array<{ value: Simulated; label: string }> = [
  { value: "live", label: "Built" },
  { value: "no-snapshot", label: "Not built yet" },
  { value: "build-pending", label: "Building…" },
  { value: "build-error", label: "Build failed" },
  { value: "enrich-pending", label: "AI running…" },
  { value: "enrich-error", label: "AI failed" },
  { value: "backend-missing", label: "Older backend" },
];

function useTheme(): [boolean, (next: boolean) => void] {
  const [dark, setDark] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches === true,
  );
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return [dark, setDark];
}

function Badge({
  tone,
  children,
}: {
  tone: "synthetic" | "recorded" | "mocked" | "real";
  children: React.ReactNode;
}) {
  const className =
    tone === "recorded" || tone === "real"
      ? "border-success/40 bg-success/10 text-foreground"
      : "border-warning/40 bg-warning/10 text-foreground";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${className}`}
      data-testid={`preview-badge-${tone}`}
    >
      {children}
    </span>
  );
}

function IterationDrawer({
  iteration,
  onClose,
}: {
  iteration: ReplayIteration;
  onClose: () => void;
}) {
  return (
    <aside
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col overflow-y-auto border-l border-border bg-card p-4 shadow-lg sm:max-w-lg"
      data-testid="preview-iteration-drawer"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">
            {iteration.title ?? iteration.iterationId}
          </h2>
          <p className="font-code text-[11px] text-muted-foreground">
            {iteration.iterationId}
            {iteration.caseKey ? ` · ${iteration.caseKey}` : ""}
          </p>
        </div>
        <button
          type="button"
          className="ml-auto rounded border border-border/60 px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted"
          onClick={onClose}
          data-testid="preview-iteration-close"
        >
          Close
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
        <div>
          <dt className="text-muted-foreground">Status</dt>
          <dd className="text-foreground">{iteration.status}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Result</dt>
          <dd className="text-foreground">{iteration.result}</dd>
        </div>
      </dl>

      <section className="mt-4">
        <h3 className="text-[12px] font-semibold text-foreground/80">
          Contract chain
        </h3>
        <ul className="mt-1 space-y-0.5 font-code text-[11.5px] text-muted-foreground">
          {iteration.stageLines.map((line, index) => (
            <li key={`${line}-${index}`}>{line}</li>
          ))}
        </ul>
      </section>

      {iteration.judgeLines.length > 0 ? (
        <section className="mt-4">
          <h3 className="text-[12px] font-semibold text-foreground/80">
            Recorded judge evidence
          </h3>
          <ul className="mt-1 space-y-0.5 text-[11.5px] text-muted-foreground">
            {iteration.judgeLines.map((line, index) => (
              <li key={`${line}-${index}`} className="break-words">
                {line}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {iteration.errorExcerpt ? (
        <section className="mt-4">
          <h3 className="text-[12px] font-semibold text-foreground/80">
            Recorded error
          </h3>
          <p className="mt-1 break-words text-[11.5px] text-muted-foreground">
            {iteration.errorExcerpt}
          </p>
        </section>
      ) : null}
    </aside>
  );
}

function Preview({ artifact }: { artifact: ReplayArtifact }) {
  const [dark, setDark] = useTheme();
  const [caseIndex, setCaseIndex] = useState(0);
  const [mode, setMode] = useState<UnifiedFindingsMode>("deterministic");
  const [simulated, setSimulated] = useState<Simulated>("live");
  const [openIteration, setOpenIteration] = useState<ReplayIteration | null>(
    null,
  );

  const replayCase: ReplayCase | undefined = artifact.cases[caseIndex];

  const onOpenEvidence = useCallback(
    (locator: FindingEvidenceLocator) => {
      if (!replayCase) return;
      // Typed locator: the preview knows what an `iteration` is and looks it
      // up. It never inspects the id's shape to decide.
      if (locator.kind !== "iteration") {
        window.alert(
          `This preview only carries eval iterations; the finding pointed at a ${locator.kind}.`,
        );
        return;
      }
      const found = replayCase.iterations.find(
        (iteration) => iteration.iterationId === locator.id,
      );
      setOpenIteration(
        found ?? {
          iterationId: locator.id,
          caseKey: null,
          title: null,
          status: "unknown",
          result: "unknown",
          stageLines: [
            "This iteration is not in the replay artifact. In the app it would open through the run's own routing.",
          ],
          judgeLines: [],
          errorExcerpt: null,
        },
      );
    },
    [replayCase],
  );

  const findings = useMemo(() => {
    if (!replayCase) return [];
    if (mode === "ai" && replayCase.enrichedFindings) {
      return replayCase.enrichedFindings;
    }
    return replayCase.deterministicFindings;
  }, [replayCase, mode]);

  if (!replayCase) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <p className="text-sm text-muted-foreground">
          The replay artifact carries no cases.
        </p>
      </main>
    );
  }

  const experiment = experimentFor(replayCase, artifact.generatedAt);
  const snapshot = simulated === "no-snapshot" ? null : experiment.snapshot;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/60 bg-card/40">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <h1 className="text-sm font-semibold text-foreground">
            Unified findings — offline preview
          </h1>
          <span className="text-[11.5px] text-muted-foreground">
            {artifact.producedBy}
          </span>
          <button
            type="button"
            className="ml-auto rounded border border-border/60 px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted"
            onClick={() => setDark(!dark)}
            data-testid="preview-theme-toggle"
          >
            {dark ? "Light" : "Dark"}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-4 px-4 py-5">
        <section className="space-y-2 rounded-lg border border-border/60 bg-card/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <label
              className="text-[12px] text-muted-foreground"
              htmlFor="preview-case"
            >
              Case
            </label>
            <select
              id="preview-case"
              className="rounded border border-border/60 bg-background px-2 py-1 text-[12.5px] text-foreground"
              value={caseIndex}
              onChange={(event) => {
                setCaseIndex(Number(event.target.value));
                setMode("deterministic");
                setOpenIteration(null);
              }}
              data-testid="preview-case-select"
            >
              {artifact.cases.map((item, index) => (
                <option key={item.label} value={index}>
                  {item.label} ({item.deterministicFindings.length} findings)
                </option>
              ))}
            </select>
            <Badge tone={replayCase.inputSource}>
              {replayCase.inputSource === "synthetic"
                ? "Synthetic inputs"
                : "Real recorded evidence"}
            </Badge>
            {replayCase.enrichment ? (
              <Badge tone={replayCase.enrichment.source}>
                {replayCase.enrichment.source === "mocked"
                  ? "Mocked AI output — plumbing only"
                  : "Real model output"}
              </Badge>
            ) : null}
          </div>
          {replayCase.note ? (
            <p className="text-[12.5px] text-muted-foreground">
              {replayCase.note}
            </p>
          ) : null}
          <p className="font-code text-[11px] text-muted-foreground">
            run {replayCase.run.runId} · suite {replayCase.run.suiteId} ·
            snapshot {(replayCase.snapshotBytes / 1024).toFixed(1)} KiB
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] text-muted-foreground">
              Simulate state
            </span>
            {SIMULATIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`rounded border px-2 py-0.5 text-[11.5px] ${
                  simulated === item.value
                    ? "border-border bg-background text-foreground"
                    : "border-border/50 text-muted-foreground hover:bg-muted"
                }`}
                onClick={() => setSimulated(item.value)}
                data-testid={`preview-sim-${item.value}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </section>

        <UnifiedFindingsPanel
          snapshot={snapshot}
          findings={findings}
          provenance={provenanceForView(
            replayCase,
            mode === "ai" ? "ai" : "deterministic",
          )}
          observationState={replayCase.observationState}
          observationCoverage={replayCase.coverage}
          mode={mode}
          onModeChange={setMode}
          build={{
            available: simulated !== "backend-missing",
            pending: simulated === "build-pending",
            error:
              simulated === "build-error"
                ? "Evidence changed; rebuild findings."
                : null,
            onRun: () =>
              window.alert(
                "Offline preview: Build findings runs against a live backend. Use the replay command to change what is shown here.",
              ),
          }}
          enrich={{
            available: simulated !== "backend-missing",
            pending: simulated === "enrich-pending",
            error:
              simulated === "enrich-error"
                ? "The model provider returned 503 after 3 attempts."
                : null,
            onRun: () =>
              window.alert(
                "Offline preview: Add AI explanation is metered and needs a live backend.",
              ),
          }}
          backendUnavailableNote={
            simulated === "backend-missing"
              ? "This Inspector build has the unified-findings experiment, but the connected backend does not serve it. Deploy the paired backend branch to build findings."
              : null
          }
          context={{ rerunLabel: "this eval suite" }}
          onOpenEvidence={onOpenEvidence}
        />

        <section className="rounded-lg border border-border/60 bg-card/30 p-3">
          <h2 className="text-[12px] font-semibold text-foreground/80">
            What this preview is
          </h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
            Every finding on this page came out of the backend&apos;s real
            miner and the shared finalizer, replayed from an evidence bundle.
            Nothing here was written by hand, and nothing here called a model.
            Rows marked <em>Mocked AI output</em> exercise the enrichment join
            only — they are not evidence that a model improves anything.
          </p>
        </section>
      </main>

      {openIteration ? (
        <IterationDrawer
          iteration={openIteration}
          onClose={() => setOpenIteration(null)}
        />
      ) : null}
    </div>
  );
}

function Root() {
  const [artifact, setArtifact] = useState<ReplayArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("./replay.json")
      .then(async (response) => {
        if (!response.ok) {
          throw new ReplayArtifactError(
            `no replay artifact was loaded (HTTP ${response.status}). Run npm run findings:replay in the backend checkout, then pass --replay <path>.`,
          );
        }
        return parseReplayArtifact(await response.json());
      })
      .then((parsed) => {
        if (!cancelled) setArtifact(parsed);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <h1 className="text-sm font-semibold text-foreground">
          Could not load the replay artifact
        </h1>
        <p className="mt-2 text-[13px] text-muted-foreground">{error}</p>
      </main>
    );
  }
  if (!artifact) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <p className="text-[13px] text-muted-foreground">Loading…</p>
      </main>
    );
  }
  return <Preview artifact={artifact} />;
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
