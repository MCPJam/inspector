/**
 * Which checks fail a run: the submission's gate, which the CLI and CI read
 * too. By default it holds the directory's blocking checks; a check can move
 * to warn only, and any check can move in. The page still shows every result
 * whatever the gate holds.
 *
 * SAVED LIKE AN ANSWER. The gate goes out with the revision it was read at,
 * and the backend refuses it when someone changed the gate since. The page
 * then shows their gate and holds this one until the person chooses.
 */
import { useState } from "react";
import {
  directoryVerdict,
  type DirectoryCheckGate,
  type DirectoryFlow,
  type DirectoryVerdict,
} from "@mcpjam/sdk/browser";
import { directorySubmissionConflict } from "@mcpjam/sdk/platform";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { cn } from "@mcpjam/design-system/cn";
import {
  updateDirectorySubmission,
  type SubmissionView,
} from "@/lib/apis/directory-submissions-api";
import { sentenceOf } from "./error-sentence";
import { McpjamBlock } from "./McpjamChecks";

interface Lists {
  failOn: string[];
  warnOnly: string[];
}

/** This tab's changes to the gate, not saved yet. */
interface Edits {
  /** Start from the directory's default instead of the saved gate. */
  fresh: boolean;
  /** Check id to whether it fails a run. */
  ticks: Record<string, boolean>;
  /** The revision the first change was made on. */
  base: number;
}

interface Row {
  id: string;
  title: string;
  step: string;
  /** In the gate when neither list names it. */
  byDefault: boolean;
  violated: boolean;
  /** Why a hosted run cannot check it. */
  limit?: string;
}

const listsOf = (gate?: DirectoryCheckGate | null): Lists => ({
  failOn: [...(gate?.failOn ?? [])].sort(),
  warnOnly: [...(gate?.warnOnly ?? [])].sort(),
});
const same = (a: Lists, b: Lists) => JSON.stringify(a) === JSON.stringify(b);
const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/** The lists after one tick. They name only checks that leave their default. */
function moved(lists: Lists, row: Row, fails: boolean): Lists {
  const others = (list: string[]) => list.filter((id) => id !== row.id);
  return listsOf({
    failOn: [
      ...others(lists.failOn),
      ...(fails && !row.byDefault ? [row.id] : []),
    ],
    warnOnly: [
      ...others(lists.warnOnly),
      ...(!fails && row.byDefault ? [row.id] : []),
    ],
  });
}

/** Where a check stands by default, and where this gate moved it. */
function rowNote(row: Row, ticked: boolean): string {
  const usual = row.limit
    ? `Not checked on hosted runs: ${row.limit}.`
    : row.byDefault
      ? "Fails a run by default."
      : "Warns only by default.";
  if (ticked === row.byDefault) return usual;
  return `${usual} ${ticked ? "Set to fail a run." : "Set to warn only."}`;
}

function headline({ verdict, failing, undetermined }: DirectoryVerdict) {
  if (verdict === "ready") {
    return "Ready under this gate. Every check in it passed, and checks outside it can still be flagged in review.";
  }
  if (verdict === "not-ready") {
    return `Not ready. ${plural(failing.length, "check")} in the gate failed.`;
  }
  return undetermined.length > 0
    ? `Incomplete. ${plural(undetermined.length, "check")} in the gate ${undetermined.length === 1 ? "has" : "have"} no current result. Run checks again, or take them out of the gate.`
    : "Incomplete. No check in the gate has a result. Run checks again.";
}

export function GateChecklist({
  flow,
  view,
  directory,
  onSaved,
}: {
  flow: DirectoryFlow;
  view: SubmissionView;
  directory: string;
  /** Shows the submission a save or a refusal returned. */
  onSaved: (view: SubmissionView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [edits, setEdits] = useState<Edits | null>(null);
  /** This tab's changes, held after someone else changed the gate. */
  const [held, setHeld] = useState<{ edits: Edits; revision: number } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const findings = view.steps.flatMap((step) => step.findings);
  const limits = directoryVerdict(findings, {
    path: "hosted",
  }).notCheckedReasons;
  const rows = findings.map(({ finding, step, evidenceStatus }): Row => {
    const required =
      finding.class === "required" || finding.class === "runtime-blocker";
    return {
      id: finding.id,
      title: finding.title,
      step,
      byDefault: required && !limits[finding.id],
      violated:
        finding.status === "violated" && evidenceStatus === "established",
      limit: limits[finding.id],
    };
  });
  const saved = listsOf(view.checkGate);
  // This tab's changes go on top of the gate saved now, so reapplying them
  // after a refusal keeps the other person's changes to other checks.
  const applied = ({ fresh, ticks }: Edits) =>
    rows.reduce(
      (lists, row) =>
        row.id in ticks ? moved(lists, row, ticks[row.id]) : lists,
      fresh ? listsOf() : saved,
    );
  const shown = edits ? applied(edits) : saved;
  const dirty = !same(shown, saved);
  const verdict = directoryVerdict(findings, {
    checkGate: shown,
    path: "hosted",
  });
  const fails = (row: Row) =>
    shown.failOn.includes(row.id) ||
    (row.byDefault && !shown.warnOnly.includes(row.id));
  const named = (ids: string[]) =>
    ids.map((id) => rows.find((row) => row.id === id)?.title ?? id).join(", ");
  /** A tick adds to this tab's changes; starting fresh drops the earlier ticks. */
  const edit = (change: { fresh?: true; ticks?: Edits["ticks"] }) =>
    setEdits((current) => ({
      fresh: change.fresh ?? current?.fresh ?? false,
      base: current?.base ?? view.revision,
      ticks: change.fresh ? {} : { ...current?.ticks, ...change.ticks },
    }));

  async function save(
    changes: Edits,
    expectedRevision: number,
    retried = false,
  ) {
    setSaving(true);
    setError(null);
    const lists = applied(changes);
    const empty = lists.failOn.length + lists.warnOnly.length === 0;
    try {
      const scope = { projectId: view.projectId, submissionId: view.id };
      // `null` restores the directory's default.
      const checkGate = empty ? null : lists;
      const result = await updateDirectorySubmission(scope, {
        expectedRevision,
        checkGate,
      });
      setEdits(null);
      setHeld(null);
      onSaved(result);
    } catch (failure) {
      const conflict = directorySubmissionConflict(failure);
      if (!conflict) {
        setError(
          `The gate was not saved. ${sentenceOf(failure)} Try saving it again.`,
        );
      } else if (!conflict.conflictingKeys.includes("checkGate") && !retried) {
        // Only other fields changed since: this gate overwrites nobody's.
        await save(changes, conflict.currentRevision, true);
        return;
      } else {
        setHeld({ edits: changes, revision: conflict.currentRevision });
        setEdits(null);
        if (conflict.current) onSaved(conflict.current);
      }
    } finally {
      setSaving(false);
    }
  }

  const gate = verdict.gate;
  return (
    <McpjamBlock
      title="What fails a run"
      note="The CLI and CI read this gate. Every result still shows on the page."
    >
      <p className="text-sm">
        {view.resultsRunId
          ? headline(verdict)
          : "Not checked yet. Run checks to see whether this rehearsal passes its gate."}
      </p>
      <div className="text-sm text-muted-foreground">
        <p>Gate: {directory}&apos;s blocking checks.</p>
        {gate.failOn.length > 0 ? (
          <p>Also fails on: {named(gate.failOn)}.</p>
        ) : null}
        {gate.warnOnly.length > 0 ? (
          <p>Warns only on: {named(gate.warnOnly)}.</p>
        ) : null}
      </div>
      {held ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-border px-3 py-2 text-sm"
        >
          <span className="min-w-0 flex-1">
            The gate changed while you were editing, so your change was not
            saved. Apply yours again, or keep the saved gate.
          </span>
          <Button
            type="button"
            size="sm"
            onClick={() => void save(held.edits, held.revision)}
          >
            Apply my changes again
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setHeld(null)}
          >
            Keep the saved gate
          </Button>
        </div>
      ) : null}
      {dirty ? null : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="px-0"
        >
          {open ? "Hide the checks" : "Choose the checks"}
        </Button>
      )}
      {open || dirty ? (
        <div className="space-y-4">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Run checks to list them here.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              A ticked check fails a run. The others only warn.
            </p>
          )}
          {flow.steps.map((step) => {
            const group = rows.filter((row) => row.step === step.id);
            if (group.length === 0) return null;
            return (
              <div key={step.id} className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {step.title}
                </p>
                {group.map((row) => {
                  const ticked = fails(row);
                  const mark = verdict.failing.includes(row.id)
                    ? "Fails the run"
                    : verdict.undetermined.includes(row.id)
                      ? "No current result"
                      : row.violated
                        ? "Failed, warns only"
                        : undefined;
                  return (
                    <label
                      key={row.id}
                      className="flex items-start gap-3 py-1 text-sm"
                    >
                      <Checkbox
                        checked={ticked}
                        onCheckedChange={(checked) =>
                          edit({ ticks: { [row.id]: checked === true } })
                        }
                        className="mt-0.5"
                      />
                      <span className="min-w-0 flex-1">
                        {row.title}
                        <span className="block text-xs text-muted-foreground">
                          {rowNote(row, ticked)}{" "}
                          <code className="font-code">{row.id}</code>
                        </span>
                      </span>
                      <span
                        className={cn(
                          "text-xs text-muted-foreground",
                          mark === "Fails the run" && "text-destructive",
                        )}
                      >
                        {mark}
                      </span>
                    </label>
                  );
                })}
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!edits || !dirty || saving}
              onClick={() => {
                if (edits) void save(edits, edits.base);
              }}
            >
              Save the gate
            </Button>
            {dirty ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setEdits(null)}
              >
                Discard changes
              </Button>
            ) : null}
            {shown.failOn.length + shown.warnOnly.length > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => edit({ fresh: true })}
              >
                Use {directory}&apos;s default
              </Button>
            ) : null}
            <span role="status" className="text-xs text-muted-foreground">
              {saving ? "Saving the gate…" : dirty ? "Not saved yet." : ""}
            </span>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </McpjamBlock>
  );
}
