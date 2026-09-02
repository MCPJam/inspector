/**
 * Production-scoring config for one User Testing scenario: grade a sample of
 * REAL tester sessions against a rubric of deterministic checks, the same
 * `Predicate` vocabulary swarm rubrics and eval checks use. Verdicts land on
 * the session's Checks panel and the Insights scorecard — same surfaces the
 * synthetic twins already report to.
 *
 * Editing model mirrors `JourneyGradingEditor` (swarms/journey-list.tsx):
 * local draft seeded from the live-subscription prop ONCE per scenario (a
 * reseed mid-edit would discard unsaved checks), explicit Save, and Save
 * gated on `areAllChecksValid` so a half-finished row can't reach the backend
 * validator and lose the whole edit.
 *
 * Sampling is authored as a percentage but stored as a [0, 1] fraction —
 * convert at the wire, never store the percent.
 */

import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Switch } from "@mcpjam/design-system/switch";
import { areAllChecksValid } from "@/components/evals/checks-section";
import { JourneyRubricEditor } from "@/components/swarms/journey-rubric-editor";
import {
  serializeRubricForWire,
  type JourneyCriterion,
} from "@/shared/journey-rubric";
import {
  useScenarioMutations,
  type ScenarioSettings,
} from "@/hooks/useScenarios";
import { convexErrMessage } from "@/lib/convex-error";

const DEFAULT_SAMPLING_PERCENT = 100;

type Draft = {
  enabled: boolean;
  samplingPercent: string;
  rubric: JourneyCriterion[];
};

/**
 * Stored fraction → the percent shown in the field.
 *
 * NOT `Math.round`: the field accepts "12.5", so a fractional percent is a
 * rate this very editor can write. Rounding on the way back in would show 13
 * and silently persist 0.13 on the user's next unrelated edit.
 *
 * The `toFixed(4)` round-trip is what keeps that honest without printing
 * float noise — `0.07 * 100` is `7.000000000000001`, and a field reading
 * "7.000000000000001" is its own kind of wrong. Four decimals of a percent is
 * finer than any sampling rate anyone can author here.
 */
function percentFromRate(rate: number): string {
  return String(Number((rate * 100).toFixed(4)));
}

function draftFromSettings(scenario: ScenarioSettings): Draft {
  const stored = scenario.productionScoring;
  return {
    enabled: stored?.enabled ?? false,
    samplingPercent: stored
      ? percentFromRate(stored.samplingRate)
      : String(DEFAULT_SAMPLING_PERCENT),
    rubric: (stored?.rubric ?? []) as JourneyCriterion[],
  };
}

export function ScenarioGradingSection({
  scenario,
}: {
  scenario: ScenarioSettings;
}) {
  const { setProductionScoring } = useScenarioMutations();
  const [draft, setDraft] = useState<Draft>(() => draftFromSettings(scenario));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reseed only when the SCENARIO changes, never on subscription churn of the
  // same row — the draft is the user's unsaved work.
  const seededFor = useRef(scenario.scenarioId);
  if (seededFor.current !== scenario.scenarioId) {
    seededFor.current = scenario.scenarioId;
    setDraft(draftFromSettings(scenario));
    setDirty(false);
  }

  // The draft as of this render, readable from inside an in-flight save's
  // continuation (see `save`). Every `update` mints a NEW object, so identity
  // comparison against it answers "did the user touch anything since?".
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const update = (patch: Partial<Draft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  };

  // A blank field is UNSET, not zero. `Number("")` is 0, which would sail
  // through the range check below and persist "enabled, sampling 0%" — an
  // scenario that looks graded and silently grades nothing.
  const samplingPercent =
    draft.samplingPercent.trim() === ""
      ? Number.NaN
      : Number(draft.samplingPercent);
  const samplingValid =
    Number.isFinite(samplingPercent) &&
    samplingPercent >= 0 &&
    samplingPercent <= 100;
  const rubricValid = useMemo(
    () => areAllChecksValid(draft.rubric.map((entry) => entry.predicate)),
    [draft.rubric],
  );
  // An enabled config that can never grade anything is a misconfiguration the
  // backend rejects; gate the button on the same rule so the error is
  // impossible rather than toasted.
  const enabledButEmpty = draft.enabled && draft.rubric.length === 0;
  const canSave = dirty && samplingValid && rubricValid && !enabledButEmpty;

  const save = async () => {
    // What this save actually persists. Compared by identity after the await
    // so an edit made DURING the request keeps the form dirty — clearing it
    // unconditionally would disable Save over changes that were never sent.
    const submitted = draft;
    setSaving(true);
    try {
      await setProductionScoring({
        scenarioId: scenario.scenarioId,
        config: {
          enabled: submitted.enabled,
          samplingRate: samplingPercent / 100,
          rubric: serializeRubricForWire(submitted.rubric),
        },
      } as never);
      if (draftRef.current === submitted) setDirty(false);
      toast.success(
        submitted.enabled
          ? "Grading enabled — new sessions get checked once testers go quiet"
          : "Grading saved",
      );
    } catch (error) {
      toast.error(convexErrMessage(error, "Failed to save grading"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      data-testid="scenario-grading-section"
      className="space-y-4 border-t border-border/40 pt-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Grading</h3>
          <p className="text-xs text-muted-foreground">
            Grade a sample of real tester sessions against checks after they go
            quiet. Verdicts appear on each session and in Insights.
          </p>
        </div>
        <Switch
          checked={draft.enabled}
          onCheckedChange={(checked) => update({ enabled: checked })}
          aria-label="Enable grading of real sessions"
          data-testid="scenario-grading-enabled"
        />
      </div>

      <div className="flex items-center gap-2">
        <label
          htmlFor="scenario-grading-sampling"
          className="text-xs text-muted-foreground"
        >
          Sample
        </label>
        <Input
          id="scenario-grading-sampling"
          className="h-7 w-16 text-xs"
          inputMode="numeric"
          value={draft.samplingPercent}
          onChange={(event) =>
            update({ samplingPercent: event.target.value })
          }
          aria-invalid={!samplingValid}
        />
        <span className="text-xs text-muted-foreground">
          % of real sessions
        </span>
      </div>
      {!samplingValid ? (
        <p className="text-xs text-destructive">
          Sampling must be a number between 0 and 100.
        </p>
      ) : null}

      <JourneyRubricEditor
        value={draft.rubric}
        onChange={(next) => update({ rubric: next })}
      />
      {enabledButEmpty ? (
        <p className="text-xs text-destructive">
          Add at least one check to enable grading.
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={save}
          disabled={!canSave || saving}
          data-testid="scenario-grading-save"
        >
          {saving ? "Saving…" : "Save grading"}
        </Button>
      </div>
    </section>
  );
}
