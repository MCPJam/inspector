/**
 * Production-scoring config for one User Testing scenario: grade a sample of
 * REAL tester sessions against a rubric of deterministic checks, the same
 * `Predicate` vocabulary swarm rubrics and eval checks use. Verdicts land on
 * the session's Checks panel and the Insights scorecard — same surfaces the
 * synthetic twins already report to.
 *
 * Editing model mirrors `JourneyGradingEditor` (swarms/journey-list.tsx):
 * local draft seeded from the live-subscription prop ONCE per chatbox (a
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
  useChatboxMutations,
  type ChatboxSettings,
} from "@/hooks/useChatboxes";
import { convexErrMessage } from "@/lib/convex-error";

const DEFAULT_SAMPLING_PERCENT = 100;

type Draft = {
  enabled: boolean;
  samplingPercent: string;
  rubric: JourneyCriterion[];
};

function draftFromSettings(chatbox: ChatboxSettings): Draft {
  const stored = chatbox.productionScoring;
  return {
    enabled: stored?.enabled ?? false,
    samplingPercent: String(
      stored ? Math.round(stored.samplingRate * 100) : DEFAULT_SAMPLING_PERCENT,
    ),
    rubric: (stored?.rubric ?? []) as JourneyCriterion[],
  };
}

export function ChatboxGradingSection({
  chatbox,
}: {
  chatbox: ChatboxSettings;
}) {
  const { setProductionScoring } = useChatboxMutations();
  const [draft, setDraft] = useState<Draft>(() => draftFromSettings(chatbox));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reseed only when the SCENARIO changes, never on subscription churn of the
  // same row — the draft is the user's unsaved work.
  const seededFor = useRef(chatbox.chatboxId);
  if (seededFor.current !== chatbox.chatboxId) {
    seededFor.current = chatbox.chatboxId;
    setDraft(draftFromSettings(chatbox));
    setDirty(false);
  }

  const update = (patch: Partial<Draft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  };

  const samplingPercent = Number(draft.samplingPercent);
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
    setSaving(true);
    try {
      await setProductionScoring({
        chatboxId: chatbox.chatboxId,
        config: {
          enabled: draft.enabled,
          samplingRate: samplingPercent / 100,
          rubric: serializeRubricForWire(draft.rubric),
        },
      } as never);
      setDirty(false);
      toast.success(
        draft.enabled
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
      data-testid="chatbox-grading-section"
      className="mt-8 space-y-4 border-t border-border/40 pt-4"
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
          data-testid="chatbox-grading-enabled"
        />
      </div>

      <div className="flex items-center gap-2">
        <label
          htmlFor="chatbox-grading-sampling"
          className="text-xs text-muted-foreground"
        >
          Sample
        </label>
        <Input
          id="chatbox-grading-sampling"
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
          data-testid="chatbox-grading-save"
        >
          {saving ? "Saving…" : "Save grading"}
        </Button>
      </div>
    </section>
  );
}
