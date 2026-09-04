/**
 * Collapsed description-experiment card on the Evaluate run page.
 *
 * Progressive disclosure only. Flag-off callers must not mount this.
 * Never render a number when the report's `interval` is null.
 */
import { useState } from "react";
import { ChevronRight, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import { diffDescriptionWords } from "@mcpjam/sdk/contract";

import { copyToClipboard } from "@/lib/clipboard";
import type { EvalDescriptionExperiment } from "@/lib/apis/eval-description-experiment-api";
import {
  caseLabelFromAggregationKey,
  descriptionExperimentHeader,
  evidenceCaveat,
  hash8,
  intervalBoundPhrase,
  maxTrialsCapOf,
  plannedTrialsOf,
  regressionLine,
} from "./description-experiment-model";

function PassBar({
  label,
  passed,
  eligible,
}: {
  label: string;
  passed: number;
  eligible: number;
}) {
  const pct = eligible > 0 ? (passed / eligible) * 100 : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
        <span className="text-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {passed} of {eligible}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-success/70"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function FrozenPill({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

export function RunDescriptionExperimentCard({
  experiment,
  onStart,
  starting = false,
}: {
  experiment: EvalDescriptionExperiment;
  onStart: () => void;
  starting?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const report = experiment.report ?? null;
  const header = descriptionExperimentHeader(experiment);
  const plannedTrials = plannedTrialsOf(experiment);
  const maxTrials = maxTrialsCapOf(experiment);
  const originalText = experiment.originalDescription ?? "";
  const rewriteText = experiment.proposal?.description ?? "";
  const diff =
    originalText || rewriteText
      ? diffDescriptionWords(originalText, rewriteText)
      : null;
  const regression = regressionLine(experiment);
  const canStart = experiment.status === "proposed" && !starting;

  async function copyRewrite() {
    if (!rewriteText) return;
    const ok = await copyToClipboard(rewriteText);
    if (ok) toast.success("New description copied");
    else toast.error("Copy failed");
  }

  return (
    <section
      className="border-t border-border/40"
      data-testid="description-experiment-card"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-muted/40"
      >
        <ChevronRight
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 text-[13px] text-foreground">{header}</span>
      </button>

      {open ? (
        <div className="flex flex-col gap-4 px-5 pb-4">
          {diff ? (
            <div className="rounded-lg border border-border/40 bg-muted/20 px-3.5 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Word diff
                </span>
                {rewriteText ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[12px]"
                    onClick={() => void copyRewrite()}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Copy new description
                  </Button>
                ) : null}
              </div>
              <p className="mt-2 font-mono text-[12.5px] leading-relaxed text-foreground">
                {diff.tokens.map((token, index) =>
                  token.type === "eq" ? (
                    <span key={`${token.type}:${index}`}>{token.text} </span>
                  ) : token.type === "add" ? (
                    <ins
                      key={`${token.type}:${index}`}
                      className="bg-success/15 text-foreground no-underline"
                    >
                      {token.text}{" "}
                    </ins>
                  ) : (
                    <del
                      key={`${token.type}:${index}`}
                      className="bg-destructive/15 text-muted-foreground"
                    >
                      {token.text}{" "}
                    </del>
                  ),
                )}
              </p>
            </div>
          ) : null}

          {report ? (
            <>
              <div className="flex flex-col gap-2">
                <PassBar
                  label="Rewrite"
                  passed={report.primary.pooled.rewrite.passed}
                  eligible={report.primary.pooled.rewrite.eligible}
                />
                <PassBar
                  label="Original"
                  passed={report.primary.pooled.original.passed}
                  eligible={report.primary.pooled.original.eligible}
                />
              </div>

              {report.primary.perCase.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Per affected case
                  </span>
                  {report.primary.perCase.map((row) => (
                    <div key={row.aggregationKey} className="flex flex-col gap-1.5">
                      <span className="font-mono text-[12px] text-foreground">
                        {caseLabelFromAggregationKey(row.aggregationKey)}
                      </span>
                      <PassBar
                        label="Rewrite"
                        passed={row.rewrite.passed}
                        eligible={row.rewrite.eligible}
                      />
                      <PassBar
                        label="Original"
                        passed={row.original.passed}
                        eligible={row.original.eligible}
                      />
                    </div>
                  ))}
                </div>
              ) : null}

              <p className="text-[12.5px] text-foreground">
                {intervalBoundPhrase(report.primary.pooled.interval)}
              </p>

              {regression ? (
                <p className="text-[12.5px] text-foreground">{regression}</p>
              ) : null}

              <div className="flex flex-wrap gap-1.5">
                {report.frozen.model.map((model) => (
                  <FrozenPill key={model}>{model}</FrozenPill>
                ))}
                <FrozenPill>{report.frozen.engine}</FrozenPill>
                {report.frozen.hostConfigId ? (
                  <FrozenPill>
                    host {hash8(report.frozen.hostConfigId) ?? report.frozen.hostConfigId}
                  </FrozenPill>
                ) : null}
                {hash8(report.frozen.toolSnapshotHash) ? (
                  <FrozenPill>
                    catalog {hash8(report.frozen.toolSnapshotHash)}
                  </FrozenPill>
                ) : null}
                {hash8(report.frozen.judgeConfigHash) ? (
                  <FrozenPill>
                    judge {hash8(report.frozen.judgeConfigHash)}
                  </FrozenPill>
                ) : null}
                <FrozenPill>
                  {report.frozen.environmentReset === "per_trial_sandbox"
                    ? "fresh computer per trial"
                    : "no reset"}
                </FrozenPill>
                <FrozenPill>
                  {report.evidenceLabel === "controlled"
                    ? "Controlled"
                    : "Reproducible"}
                </FrozenPill>
              </div>
              <p className="text-[12px] text-muted-foreground">
                {evidenceCaveat(report.evidenceLabel)}
              </p>
            </>
          ) : null}

          {canStart ? (
            <div>
              <Button
                type="button"
                size="sm"
                className="h-8"
                data-testid="description-experiment-start"
                onClick={() => setConfirmOpen(true)}
              >
                {plannedTrials != null
                  ? `Run experiment (${plannedTrials} trials)`
                  : "Run experiment"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run this description experiment?</AlertDialogTitle>
            <AlertDialogDescription>
              This launches two replay runs — original catalog and rewritten
              description
              {plannedTrials != null
                ? ` — ${plannedTrials} trials in total`
                : ""}
              , refused over a cap of {maxTrials} (hard cap 400).
              {experiment.plan?.judgeAutoRun
                ? " The suite's judge will auto-run on both arms."
                : " The suite's judge will auto-run on both arms if it is enabled on the source run."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                onStart();
              }}
            >
              Run experiment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
