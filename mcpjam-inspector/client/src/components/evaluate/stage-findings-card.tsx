/**
 * The trial evidence behind one stage's failures.
 *
 * Rendered inside the stage detail card's `findings` slot, so the story
 * completes on one screen: see the verdict (D9's card), locate the degradation
 * (the stage cards), understand the scope (the population lines), inspect the
 * evidence (these rows), fix and rerun (each group's "Next:" line and the run
 * page's existing run-again affordance).
 *
 * ── Everything here is read off a document ───────────────────────────────────
 *
 * No sentence in this file diagnoses anything. Titles, failure strings and tool
 * names are fields the contract carries; the "Next:" line is the diagnostic's
 * own `nextAction`, already authored per failure category in the SDK. Untrusted
 * strings are bounded upstream and escaped by React here.
 */
import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  STAGE_FINDING_GROUP_CAP,
  STAGE_FINDING_TRIAL_CAP,
  type StageFindingGroup,
  type StageFindingTrial,
  type StageFindings,
  type StageFindingsState,
} from "./stage-findings-model";

export interface StageFindingsTraceTarget {
  runId: string;
  iterationId: string;
  testCaseId: string;
}

function TrialRow({
  trial,
  onOpenTrial,
  openLabel,
}: {
  trial: StageFindingTrial;
  onOpenTrial?: (target: StageFindingsTraceTarget) => void;
  openLabel: string;
}) {
  return (
    <li
      className="rounded border border-border/40 px-2 py-1.5"
      data-testid="stage-finding-trial"
      data-iteration={trial.iterationId}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[11px] font-medium text-foreground">
          {trial.title ?? "Untitled case"}
        </span>
        <span className="text-[10px] text-muted-foreground">
          iteration {trial.iterationNumber}
        </span>
        {trial.earlierStageAlsoFailed ? (
          // A non-primary appearance. A reader who takes this row for the
          // origin of the failure goes after the wrong link in the chain.
          <span className="text-[10px] text-muted-foreground/80">
            an earlier stage also failed
          </span>
        ) : null}
      </div>
      {trial.observedFailure ? (
        <p
          className="mt-0.5 break-words text-[10px] text-muted-foreground"
          data-testid="stage-finding-observed"
        >
          {trial.observedFailure}
        </p>
      ) : null}
      {trial.expectedTools || trial.observedTools ? (
        <p className="mt-0.5 text-[10px] text-muted-foreground/80">
          {trial.expectedTools
            ? `expected ${trial.expectedTools.join(", ")}`
            : null}
          {trial.expectedTools && trial.observedTools ? " · " : null}
          {trial.observedTools
            ? `observed ${trial.observedTools.join(", ")}`
            : null}
        </p>
      ) : null}
      {trial.traceable && onOpenTrial && trial.testCaseId ? (
        <Button
          size="sm"
          variant="ghost"
          className="mt-0.5 h-6 px-1.5 text-[10px]"
          data-testid="stage-finding-open"
          onClick={() =>
            onOpenTrial({
              runId: trial.runId,
              iterationId: trial.iterationId,
              testCaseId: trial.testCaseId as string,
            })
          }
        >
          {openLabel}
        </Button>
      ) : null}
    </li>
  );
}

function Group({
  group,
  onOpenTrial,
  openLabel,
}: {
  group: StageFindingGroup;
  onOpenTrial?: (target: StageFindingsTraceTarget) => void;
  openLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded
    ? group.trials
    : group.trials.slice(0, STAGE_FINDING_TRIAL_CAP);
  const hidden = group.trials.length - shown.length;

  return (
    <div
      className="mt-1.5"
      data-testid="stage-finding-group"
      data-reason={group.reason}
    >
      <p className="text-[11px] text-foreground">
        {/* The count first, then the reason — the same shape the tally line
            above uses, so the two can be checked against each other. */}
        {group.count} — {group.label}
      </p>
      <ul className="mt-1 space-y-1">
        {shown.map((trial) => (
          <TrialRow
            key={trial.iterationId}
            trial={trial}
            openLabel={openLabel}
            {...(onOpenTrial ? { onOpenTrial } : {})}
          />
        ))}
      </ul>
      {hidden > 0 ? (
        <Button
          size="sm"
          variant="ghost"
          className="mt-1 h-6 px-1.5 text-[10px]"
          data-testid="stage-finding-more-trials"
          onClick={() => setExpanded(true)}
        >
          Show {hidden} more
        </Button>
      ) : null}
      {group.nextAction ? (
        // The loop closes here. The action is the diagnostic's own field,
        // authored per failure category in the contract — no new vocabulary.
        <p
          className="mt-1 text-[10px] text-muted-foreground"
          data-testid="stage-finding-next-action"
        >
          Next: {group.nextAction}
        </p>
      ) : null}
    </div>
  );
}

function ReadyStage({
  findings,
  onOpenTrial,
  openLabel,
}: {
  findings: StageFindings;
  onOpenTrial?: (target: StageFindingsTraceTarget) => void;
  openLabel: string;
}) {
  const [allGroups, setAllGroups] = useState(false);
  const groups = allGroups
    ? findings.groups
    : findings.groups.slice(0, STAGE_FINDING_GROUP_CAP);
  const hiddenGroups = findings.groups.length - groups.length;

  return (
    <div
      className="mt-2 border-t border-border/40 pt-2"
      data-testid="stage-findings"
    >
      {/* Population, then scope, then the evidence. Never a percentage before
          the reader knows what it is over. */}
      <p className="text-[11px] text-foreground">{findings.headline}</p>
      <p className="text-[10px] text-muted-foreground/80">
        {findings.scopeLine}
      </p>
      {findings.unattributedNote ? (
        <p
          className="mt-0.5 text-[10px] text-muted-foreground/80"
          data-testid="stage-findings-unattributed"
        >
          {findings.unattributedNote}
        </p>
      ) : null}
      {findings.reconciliationNote ? (
        <p
          className="mt-0.5 text-[10px] text-amber-700 dark:text-amber-400"
          data-testid="stage-findings-reconciliation"
        >
          {findings.reconciliationNote}
        </p>
      ) : null}
      {groups.map((group) => (
        <Group
          key={group.reason}
          group={group}
          openLabel={openLabel}
          {...(onOpenTrial ? { onOpenTrial } : {})}
        />
      ))}
      {hiddenGroups > 0 ? (
        <Button
          size="sm"
          variant="ghost"
          className="mt-1 h-6 px-1.5 text-[10px]"
          data-testid="stage-findings-more-groups"
          onClick={() => setAllGroups(true)}
        >
          Show {hiddenGroups} more {hiddenGroups === 1 ? "reason" : "reasons"}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The findings for one stage, or the honest reason there are none.
 *
 * Rendered under the selected stage's rates, which stay on screen through
 * every degraded state below: a stage's measured rates are true whether or not
 * a diagnostics page arrived.
 */
export function StageFindingsCard({
  state,
  stage,
  onOpenTrial,
  openLabel = "View trace",
}: {
  state: StageFindingsState;
  stage: string;
  onOpenTrial?: (target: StageFindingsTraceTarget) => void;
  /** "View trace" on the run page; "Open run" where no deep focus exists. */
  openLabel?: string;
}) {
  // Four states render NOTHING, each for its own reason: the read is off, it
  // is mid-flight, the run has not finished, or the two documents describe
  // different runs (a mid-navigation frame that resolves itself).
  if (
    state.kind === "disabled" ||
    state.kind === "loading" ||
    state.kind === "runNotTerminal" ||
    state.kind === "identityMismatch"
  ) {
    return null;
  }

  if (state.kind === "unavailable") {
    return (
      <div
        className="mt-2 border-t border-border/40 pt-2"
        data-testid="stage-findings-unavailable"
      >
        <p className="text-[11px] text-foreground">{state.title}</p>
        <p className="text-[10px] text-muted-foreground">{state.detail}</p>
      </div>
    );
  }

  if (state.kind === "noDecisionDiagnostics") {
    return (
      <div
        className="mt-2 border-t border-border/40 pt-2"
        data-testid="stage-findings-no-diagnostics"
      >
        <p className="text-[10px] text-muted-foreground">
          {/* NOT "no failures". This run has no per-trial diagnostics to join,
              which is a fact about the contract that produced it. */}
          Per-trial diagnostics are unavailable for this run, so the trials
          behind these stage counts are not listed here.
        </p>
      </div>
    );
  }

  const findings = state.byStage[stage];
  if (!findings) return null;

  return (
    <>
      {state.provisionalNote ? (
        <p
          className="mt-2 text-[10px] text-amber-700 dark:text-amber-400"
          data-testid="stage-findings-provisional"
        >
          {state.provisionalNote}
        </p>
      ) : null}
      <ReadyStage
        findings={findings}
        openLabel={openLabel}
        {...(onOpenTrial ? { onOpenTrial } : {})}
      />
    </>
  );
}

/**
 * The trials no stage accounts for, as ONE collapsed line under the cards.
 *
 * Separate from the per-stage sections because it is a different claim: these
 * trials did not pass and the chain does not say where. Attaching them to a
 * stage would be the invention this whole join exists to avoid.
 */
export function RunLevelFindingsLine({ state }: { state: StageFindingsState }) {
  if (state.kind !== "ready" || !state.runLevel) return null;
  return (
    <p
      className="mt-1.5 text-[10px] text-muted-foreground/80"
      data-testid="stage-findings-run-level"
    >
      {state.runLevel.line}
    </p>
  );
}
