/**
 * The study's "what to try" list, edited after the fact — the same list create
 * step 2 authors, in the same editor, so the two surfaces cannot drift into
 * different ideas of what a task is.
 *
 * Editing model mirrors `ScenarioGradingSection`: a local draft seeded from
 * the live-subscription prop ONCE per scenario (a reseed mid-edit would
 * discard unsaved rows), and an explicit Save. Unlike the ratings toggle there
 * is no optimistic display — a list is not a switch, and echoing rows the
 * server has not accepted would make a failed save look like it worked.
 */

import { useMemo, useRef, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { ScenarioTaskListEditor } from "@/components/scenarios/ScenarioTaskListEditor";
import {
  emptyScenarioTaskDraft,
  scenarioTaskDraftsFromSettings,
  scenarioTasksEqual,
  scenarioTasksFromDrafts,
  type ScenarioTaskDraft,
} from "@/lib/scenario-tasks";
import {
  useScenarioMutations,
  type ScenarioSettings,
} from "@/hooks/useScenarios";
import { convexErrMessage } from "@/lib/convex-error";
import { toast } from "@/lib/toast";

/**
 * A study with no tasks still opens on one empty row: the section is an
 * editor, and a bare "Add a task" button would make an empty list look like a
 * feature that had not loaded. The row persists nothing until it has a title.
 */
function draftsFromScenario(scenario: ScenarioSettings): ScenarioTaskDraft[] {
  const stored = scenarioTaskDraftsFromSettings(
    scenario.chatUi?.surfaces?.tasks,
  );
  return stored.length > 0 ? stored : [emptyScenarioTaskDraft()];
}

export function ScenarioTasksSection({
  scenario,
}: {
  scenario: ScenarioSettings;
}) {
  const { updateScenario } = useScenarioMutations();
  const [drafts, setDrafts] = useState<ScenarioTaskDraft[]>(() =>
    draftsFromScenario(scenario),
  );
  const [saving, setSaving] = useState(false);

  // Reseed only when the SCENARIO changes, never on subscription churn of the
  // same row — the draft is the user's unsaved work.
  const seededFor = useRef(scenario.scenarioId);
  if (seededFor.current !== scenario.scenarioId) {
    seededFor.current = scenario.scenarioId;
    setDrafts(draftsFromScenario(scenario));
  }

  const storedItems = useMemo(
    () =>
      scenarioTasksFromDrafts(
        scenarioTaskDraftsFromSettings(scenario.chatUi?.surfaces?.tasks),
      ),
    [scenario.chatUi?.surfaces?.tasks],
  );
  const draftItems = useMemo(() => scenarioTasksFromDrafts(drafts), [drafts]);

  // Dirty is derived from what would PERSIST, not from whether the user
  // touched the form: adding an empty row and removing it again changes
  // nothing, and offering Save for it invites a write with no effect.
  const dirty = !scenarioTasksEqual(draftItems, storedItems);

  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  const save = async () => {
    const submitted = drafts;
    const items = scenarioTasksFromDrafts(submitted);
    setSaving(true);
    try {
      // `items` replaces the stored list wholesale — an empty array is how
      // the last task is removed, which is what hides the tester's control.
      await updateScenario({
        scenarioId: scenario.scenarioId,
        chatUi: { surfaces: { tasks: { items } } },
      } as never);
      // Normalization can drop or trim rows (a blank title, an over-long
      // one), so reseed from what was actually sent rather than leaving the
      // editor showing rows the study does not have. Only when the user has
      // not edited since — comparing by identity, as `update` mints a new
      // array each time.
      if (draftsRef.current === submitted) {
        setDrafts(
          items.length > 0
            ? items.map((item) => ({
                id: item.id,
                title: item.title,
                hint: item.hint ?? "",
              }))
            : [emptyScenarioTaskDraft()],
        );
      }
      toast.success(
        items.length > 0
          ? "Tasks saved — testers see them in their session"
          : "Tasks cleared — testers just get the chat",
      );
    } catch (error) {
      toast.error(convexErrMessage(error, "Failed to save tasks"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4" data-testid="user-testing-tasks-section">
      <div>
        <h2 className="text-lg font-medium tracking-tight text-foreground">
          Tasks
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Testers see this list in the top right of their session and check
          items off as they go. Leave it empty and they just get the chat —
          nothing here forces an order or reports back who finished what.
        </p>
      </div>

      <ScenarioTaskListEditor
        value={drafts}
        onChange={setDrafts}
        disabled={saving}
        testIdPrefix="user-testing-settings"
      />

      <div className="flex justify-end">
        <Button
          size="sm"
          className="rounded-lg"
          disabled={!dirty || saving}
          onClick={() => void save()}
          data-testid="user-testing-tasks-save"
        >
          {saving ? "Saving…" : "Save tasks"}
        </Button>
      </div>
    </section>
  );
}
