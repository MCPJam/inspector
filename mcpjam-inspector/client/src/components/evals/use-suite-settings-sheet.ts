import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type RefObject,
} from "react";
import { toast } from "sonner";
import { useScheduledEvalsEnabled } from "@/hooks/useScheduledEvalsEnabled";
import { useSandboxImagesEnabled } from "@/hooks/useSandboxImagesEnabled";
import { useEnvironmentCapabilities } from "@/hooks/use-environment-capabilities";
import {
  useUnsavedChangesGuard,
  type GuardLocation,
} from "@/hooks/use-unsaved-changes-guard";
import type { EvalSuiteSettingKey } from "@/shared/eval-suite-settings-manifest";
import { compareRunsBySequence, isSubsetRerunRun } from "./helpers";
import { isRubricValid } from "./judge-rubric-editor";
import { areRubricChecksValid } from "./rubric-checks-model";
import { areAllChecksValid } from "./checks-section";
import {
  canCommit,
  committedSuiteSettingsValues,
  describeDraft,
  dirtyKeys,
  environmentImageSaveBlock,
  initSuiteSettingsDraft,
  readSuiteSettingsValues,
  suiteSettingsReducer,
} from "./suite-settings-draft";
import {
  VISIBLE_SUITE_SETTINGS_GROUPS,
  NESTED_SETTING_KEYS,
} from "./suite-settings-groups";
import {
  subsectionForSettingKey,
  subsectionScrollTarget,
} from "./suite-settings-subsections";
import { useSuiteSettingsCommit } from "./use-suite-settings-draft";
import { useSelectedRun } from "./use-selected-run";
import { useGroundedness } from "./use-groundedness";
import type { SuiteConfigLock } from "./use-suite-config-lock";
import type { EvalSuite, EvalSuiteRunListItem } from "./types";
import { ROW_DRAFT_KEYS } from "./suite-settings-row-draft-keys";

type SuiteSettingsDraft = ReturnType<typeof initSuiteSettingsDraft>;
type SuiteSettingsAction = Parameters<typeof suiteSettingsReducer>[1];
type DraftChange = ReturnType<typeof describeDraft>[number];

/**
 * The suite's runs NEWEST FIRST. `compareRunsBySequence` sorts ascending by
 * run number, so a bare sort puts run #1 first — which is how a suite with
 * fifty runs once backtested a draft rubric against its very first run.
 */
export function sortRunsNewestFirst(
  runs: EvalSuiteRunListItem[],
): EvalSuiteRunListItem[] {
  return [...runs].sort((a, b) => compareRunsBySequence(b, a));
}

/**
 * Reproducible-evals image picker visibility.
 *
 * The row keeps its ORIGINAL flag gate as an additional condition, so a
 * deployment whose capabilities read fails behaves exactly as it did before.
 * What changes is what happens when capabilities ARE readable and say no: the
 * row renders disabled with the reason instead of disappearing. ONE condition
 * decides both whether the row renders and whether its images are fetched.
 */
export function useComputerEnvironmentRowVisible(
  lock: SuiteConfigLock,
  projectId: string | null,
): boolean {
  const sandboxImagesEnabled = useSandboxImagesEnabled();
  return lock.capabilities
    ? Boolean(projectId)
    : sandboxImagesEnabled && Boolean(projectId);
}

export interface SuiteSettingsSheet {
  draft: SuiteSettingsDraft;
  dispatchDraft: Dispatch<SuiteSettingsAction>;
  changes: DraftChange[];
  canCommit: boolean;
  isCommitting: boolean;
  editingDisabled: boolean;
  configLocked: boolean;
  nameError?: string;
  blockingErrors: { message: string; settingKey: "name" | "passOrFail" }[];
  rowIsDirty(key: EvalSuiteSettingKey): boolean;
  rowIsConflict(key: EvalSuiteSettingKey): boolean;
  commit(): Promise<void>;
  discard(): void;
  openSetting(key: EvalSuiteSettingKey): void;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Evidence for the groundedness row, read only while `active`. */
  groundedness: ReturnType<typeof useGroundedness>;
}

/**
 * The suite settings draft (S1) and everything that saves, guards and
 * navigates it. One piece of state for every drafted setting; nothing is
 * written until the person saves.
 */
export function useSuiteSettingsSheet(args: {
  suite: EvalSuite;
  runs: EvalSuiteRunListItem[];
  projectId: string | null;
  lock: SuiteConfigLock;
  /** Reads the latest completed run for groundedness evidence only when true. */
  active: boolean;
  /** Feeds the settings jump-link options exactly as the sheet did. */
  canDeleteSuite?: boolean;
  /** Passed to useUnsavedChangesGuard; tab switches on the new page. */
  allowNavigation?: (current: GuardLocation, next: GuardLocation) => boolean;
}): SuiteSettingsSheet {
  const { suite, runs, projectId, lock, active, allowNavigation } = args;
  const { editingDisabled, configLocked } = lock;
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
  const changes = useMemo(() => describeDraft(draft), [draft]);
  // Memoized with the changes: `canCommit` re-runs `dirtyKeys` (a stringify per
  // key) and a zod parse over every default check, and the owner re-renders
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
  const hasUnsavedSettings = changes.length > 0;
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
  const nameError =
    draft.current.name.trim().length === 0 ? "Name is required" : undefined;
  const passOrFailError = !isRubricValid(draft.current.judgeRubric)
    ? "A criterion is missing a label"
    : !areAllChecksValid(draft.current.defaultPredicates)
      ? "An assertion is incomplete"
      : !areRubricChecksValid(draft.current.judgeConfig?.rubricChecks)
        ? "A rubric-check question is incomplete"
        : undefined;
  const blockingErrors: SuiteSettingsSheet["blockingErrors"] = [
    ...(nameError ? [{ message: nameError, settingKey: "name" as const }] : []),
    ...(passOrFailError
      ? [{ message: passOrFailError, settingKey: "passOrFail" as const }]
      : []),
  ];
  const isVerdictPolicyV2 = draft.current.verdictPolicyVersion === 2;
  const scheduledEvalsEnabled = useScheduledEvalsEnabled();
  // Whether the backend carries an environment suite's settings onto its
  // environments (`environmentSettings`) instead of a legacy suite field.
  const environmentCapabilities = useEnvironmentCapabilities(projectId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const discard = useCallback(() => dispatchDraft({ type: "discard" }), []);
  // Discarding is what the person just agreed to when they confirmed the
  // prompt. Without it the draft outlives the sheet: the guard re-prompts on
  // every later navigation, ⌘S saves from the run list, and
  // the edits they were told they were leaving behind are still there.
  useUnsavedChangesGuard(
    hasUnsavedSettings,
    discard,
    undefined,
    undefined,
    allowNavigation,
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
        ? `Updated suite settings: ${changes
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
        "This suite changed since you opened it. Your edits are still here. Review them against the new values and save again.",
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
    editingDisabled,
    dirtySettingKeys,
    changes,
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

  const latestCompletedRun = useMemo(
    () =>
      sortRunsNewestFirst(runs).find(
        (run) => run.status === "completed" && !isSubsetRerunRun(run),
      ) ?? null,
    [runs],
  );
  const latestGroundednessRun = useSelectedRun(
    suite._id,
    active ? (latestCompletedRun?._id ?? null) : null,
  );
  const groundedness = useGroundedness(latestGroundednessRun.run);

  const computerEnvironmentRowVisible = useComputerEnvironmentRowVisible(
    lock,
    projectId,
  );
  const canDeleteSuite = args.canDeleteSuite ?? false;
  const subsectionOptions = useMemo(
    () => ({
      isVerdictPolicyV2,
      showComputerEnvironment: computerEnvironmentRowVisible,
      showSchedule: scheduledEvalsEnabled,
      showDelete: canDeleteSuite,
    }),
    [
      isVerdictPolicyV2,
      computerEnvironmentRowVisible,
      scheduledEvalsEnabled,
      canDeleteSuite,
    ],
  );
  // Scope changes are API-only until an explicit operation ships in a follow-up.
  const openSetting = useCallback(
    (key: EvalSuiteSettingKey) => {
      if (key === "name") {
        scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      const group = VISIBLE_SUITE_SETTINGS_GROUPS.find((candidate) => {
        if ((candidate.rows as readonly string[]).includes(key)) return true;
        return candidate.rows.some((row) =>
          NESTED_SETTING_KEYS[row]?.includes(key),
        );
      });
      if (group) {
        const subsection = subsectionForSettingKey(
          key,
          group.id,
          subsectionOptions,
        );
        if (subsection) {
          requestAnimationFrame(() => {
            const root = scrollRef.current;
            root
              ?.querySelector(subsectionScrollTarget(subsection))
              ?.scrollIntoView({ behavior: "smooth", block: "start" });
          });
        }
      }
    },
    [subsectionOptions],
  );

  return {
    draft,
    dispatchDraft,
    changes,
    canCommit: draftCanCommit,
    isCommitting,
    editingDisabled,
    configLocked,
    nameError,
    blockingErrors,
    rowIsDirty,
    rowIsConflict,
    commit: handleCommitSettings,
    discard,
    openSetting,
    scrollRef,
    groundedness,
  };
}
