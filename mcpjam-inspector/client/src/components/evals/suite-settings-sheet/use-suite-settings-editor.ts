import { useCallback, useEffect, useMemo, useReducer } from "react";
import { toast } from "sonner";
import { DEFAULT_SUITE_WIDE_THRESHOLD_PERCENT } from "@mcpjam/sdk/contract";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { splitPredicatesForMigration } from "@/shared/predicate-migration";
import type { EvalSuiteSettingKey } from "@/shared/eval-suite-settings-manifest";
import { useEnvironmentCapabilities } from "@/hooks/use-environment-capabilities";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import { areAllChecksValid } from "../checks-section";
import { isRubricValid } from "../judge-rubric-editor";
import { areRubricChecksValid } from "../rubric-checks-model";
import {
  canCommit,
  committedSuiteSettingsValues,
  describeDraft,
  dirtyKeys,
  environmentImageSaveBlock,
  initSuiteSettingsDraft,
  readSuiteSettingsValues,
  suiteSettingsReducer,
} from "../suite-settings-draft";
import { useSuiteSettingsCommit } from "../use-suite-settings-draft";
import type { EvalSuite } from "../types";
import { ROW_DRAFT_KEYS } from "./suite-settings-ledger";

/**
 * A suite's settings draft and its one save (`applySuiteSettings`), shared by
 * every surface that edits suite settings: the settings sheet and the Suite
 * settings page's Settings and Default evaluators tabs.
 */
export function useSuiteSettingsEditor({
  suite,
  projectId,
  editingDisabled,
  keepsDraft,
}: {
  suite: EvalSuite;
  projectId: string | null;
  editingDisabled: boolean;
  /** Addresses that show this same draft; leaving for one never prompts. */
  keepsDraft?: (nextPathname: string) => boolean;
}) {
  // ── The settings draft (S1) ─────────────────────────────────────────────
  //
  // One piece of state for every drafted setting, replacing the per-control
  // local state each writer used to keep. The controls still fire on every
  // keystroke — `ChecksSection` inserts a blank template on `Add check` — but
  // now those keystrokes land in a draft that is saved deliberately rather
  // than in a debounce racing its own previous write.
  const [draft, dispatchDraft] = useReducer(
    suiteSettingsReducer,
    suite,
    // Lazy: this ran on every render and threw the result away, and it is not
    // free — it rebuilds the whole settings envelope for a suite document that
    // changes identity on every run-progress tick.
    (initial) =>
      initSuiteSettingsDraft({
        suiteId: initial._id,
        values: readSuiteSettingsValues(initial),
      }),
  );
  const { commit, isCommitting } = useSuiteSettingsCommit();
  const draftDefaultPredicates = draft.current.defaultPredicates;
  const setDraftDefaultPredicates = useCallback(
    // Both forms, matching the `useState` setter this replaced — `AddCheckMenu`
    // passes an updater, and the reducer resolves it against the authoritative
    // draft rather than whatever this render closed over.
    (next: Predicate[] | ((previous: Predicate[]) => Predicate[])) =>
      dispatchDraft({ type: "edit", key: "defaultPredicates", value: next }),
    [],
  );
  const suiteScenarioMigrationCount = useMemo(
    () =>
      splitPredicatesForMigration(draftDefaultPredicates).scenarioAsserts
        .length,
    [draftDefaultPredicates],
  );
  const defaultMinimumPassRate =
    draft.current.defaultPassCriteria?.minimumPassRate ??
    DEFAULT_SUITE_WIDE_THRESHOLD_PERCENT;
  const draftChanges = useMemo(() => describeDraft(draft), [draft]);
  // Memoized with the changes: `canCommit` re-runs `dirtyKeys` (a stringify per
  // key) and a zod parse over every default check, and this component re-renders
  // on every run-progress tick of every suite in the project.
  const draftCanCommit = useMemo(
    // A half-written rubric is refused HERE rather than by the backend, for the
    // same reason a half-written check is: the save is one batched mutation, so
    // a rubric the platform rejects takes the settings beside it down with it.
    () =>
      canCommit(draft, areAllChecksValid) &&
      isRubricValid(draft.current.judgeRubric) &&
      areRubricChecksValid(draft.current.judgeConfig?.rubricChecks),
    [draft],
  );
  const hasUnsavedSettings = draftChanges.length > 0;
  const dirtySettingKeys = useMemo(() => new Set(dirtyKeys(draft)), [draft]);
  const rowIsDirty = useCallback(
    (key: EvalSuiteSettingKey) =>
      (ROW_DRAFT_KEYS[key] ?? []).some((draftKey) =>
        dirtySettingKeys.has(draftKey),
      ),
    [dirtySettingKeys],
  );
  const rowIsConflict = useCallback(
    (key: EvalSuiteSettingKey) =>
      (ROW_DRAFT_KEYS[key] ?? []).some((draftKey) =>
        draft.conflicts.includes(draftKey),
      ),
    [draft.conflicts],
  );
  const nameRowError =
    draft.current.name.trim().length === 0
      ? {
          message: "Name is required",
          focusSelector: 'input[aria-label="Suite name"]',
        }
      : undefined;
  const passOrFailRowError = !isRubricValid(draft.current.judgeRubric)
    ? { message: "A criterion is missing a label" }
    : !areAllChecksValid(draftDefaultPredicates)
      ? { message: "An assertion is incomplete" }
      : !areRubricChecksValid(draft.current.judgeConfig?.rubricChecks)
        ? { message: "A rubric-check question is incomplete" }
        : undefined;
  // Which criterion SCOPE the sheet is editing, and therefore which field and
  // which units each grading row shows. Read from the DRAFT rather than the
  // suite so the rows follow a scope change the moment it is drafted; this
  // sheet no longer offers one, but a scope arriving from the API
  // still has to be reflected rather than leaving the page
  // describing a suite nobody has.
  const isVerdictPolicyV2 = draft.current.verdictPolicyVersion === 2;
  // Whether the backend carries an environment suite's settings onto its
  // environments (`environmentSettings`) instead of a legacy suite field.
  const environmentCapabilities = useEnvironmentCapabilities(projectId);
  // Discarding is what the person just agreed to when they confirmed the
  // prompt. Without it the draft outlives the sheet: the guard re-prompts on
  // every later navigation, ⌘S saves from the run list, and
  // the edits they were told they were leaving behind are still there.
  useUnsavedChangesGuard(
    hasUnsavedSettings,
    () => dispatchDraft({ type: "discard" }),
    undefined,
    false,
    keepsDraft,
  );

  // The suite moved under us. An untouched row simply refreshes; a row the
  // person has edited AND someone else changed is marked rather than merged,
  // because that is the one case an automatic answer would get wrong for one
  // of the two people involved. A different suite id resets the draft outright
  // — see the reducer.
  const liveSettingsKey = useMemo(
    () => `${suite._id}:${JSON.stringify(readSuiteSettingsValues(suite))}`,
    [suite],
  );
  useEffect(() => {
    dispatchDraft({
      type: "rebase",
      suiteId: suite._id,
      live: readSuiteSettingsValues(suite),
    });
    // Keyed on the serialized live values so this fires when the SUITE moves,
    // not on every render that produces a new object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSettingsKey]);

  const handleCommitSettings = useCallback(async () => {
    if (!draftCanCommit || isCommitting || editingDisabled) return;
    const runsEnvironments = Boolean(suite.environmentIds?.length);
    const imageBlock = environmentImageSaveBlock({
      runsEnvironments,
      dirtyKeys: dirtySettingKeys,
      capabilities: environmentCapabilities,
    });
    if (imageBlock) {
      toast.error(imageBlock);
      return;
    }
    const outcome = await commit({
      draft,
      suiteId: suite._id,
      // Keep the required gate-policy audit note without a blocking prompt.
      note: dirtySettingKeys.has("gatePolicy")
        ? `Updated suite settings: ${draftChanges
            .map((change) => change.label)
            .join(", ")}.`
        : undefined,
      expectedRevisionNumber: suite.revisionNumber,
      liveEnvironment: suite.environment,
      environmentSuite:
        runsEnvironments &&
        environmentCapabilities?.environmentSuiteSettings === true,
    });
    if (outcome.status === "saved") {
      // What the save actually WROTE: the normalized form of the keys it
      // carried, and the untouched keys exactly as they were. `toUpdateArgs`
      // trims a dirty name, so rebasing onto the raw draft would leave the
      // person looking at their own whitespace — and normalizing a name this
      // save never sent would make the draft disagree with the database.
      //
      // `retained` keeps the keys a legacy deployment could not carry dirty,
      // so the toast's promise that they are still there to save holds.
      // `suiteId` is the save's OWN suite, so a mutation that resolves after
      // the person navigated cannot land on the suite they moved to.
      dispatchDraft({
        type: "commitSucceeded",
        suiteId: suite._id,
        live: committedSuiteSettingsValues(draft),
        retained: outcome.droppedKeys,
      });
    } else if (outcome.status === "conflict") {
      // The draft SURVIVES. Throwing away someone's edits because a
      // colleague saved first is the outcome the precondition exists to
      // prevent, not one to implement on its refusal.
      toast.error(
        "This suite changed since you opened it. Your edits are still here — review them against the new values and save again.",
      );
      // No rebase here on purpose. `suite` is still the document we already
      // had — the one the server just told us is stale — so rebasing onto it
      // would compare the draft against the same values and mark nothing.
      // The subscription delivers the newer document a moment later, and the
      // rebase effect above does the real comparison then.
    }
  }, [
    commit,
    draft,
    suite,
    draftCanCommit,
    isCommitting,
    dirtySettingKeys,
    draftChanges,
    environmentCapabilities,
  ]);

  // Save the same validated draft from the button or keyboard shortcut.
  useEffect(() => {
    if (!hasUnsavedSettings) return;
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "s") return;
      event.preventDefault();
      void handleCommitSettings();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hasUnsavedSettings, handleCommitSettings]);

  return {
    draft,
    dispatchDraft,
    isCommitting,
    draftChanges,
    draftCanCommit,
    hasUnsavedSettings,
    dirtySettingKeys,
    rowIsDirty,
    rowIsConflict,
    nameRowError,
    passOrFailRowError,
    isVerdictPolicyV2,
    defaultMinimumPassRate,
    draftDefaultPredicates,
    setDraftDefaultPredicates,
    suiteScenarioMigrationCount,
    commitSettings: handleCommitSettings,
  };
}

export type SuiteSettingsEditor = ReturnType<typeof useSuiteSettingsEditor>;
