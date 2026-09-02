/**
 * Confirm step of the New swarm create flow.
 *
 * Persona list stays compact; click a row to expand it in the shared confirm
 * column with use-cases and goals. Nothing is persisted until "Create & launch".
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown, Loader2, Trash2, X } from "lucide-react";
import { useQuery } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { PersonaPickerPopover } from "@/components/swarms/persona-picker-popover";
import { RequiredMark } from "@/components/shared/required-mark";
import { SectionLabel } from "@/components/shared/section-label";
import { JudgesSection } from "@/components/evals/judges-section";
import { areAllChecksValid } from "@/components/evals/checks-section";
import { JourneyRubricEditor } from "@/components/swarms/journey-rubric-editor";
import {
  PersonaPixelAvatar,
  mintPersonaAvatarLook,
} from "@/components/swarms/persona-pixel-avatar";
import {
  estimateLaunchSessions,
  SWARM_INTENSITY_ORDER,
  SWARM_INTENSITY_PRESETS,
  estimateSwarmSessions,
  type SwarmIntensityPreset,
  type SwarmPushIntensity,
} from "@/components/swarms/swarm-intensity";
import { SWARM_QUERIES } from "@/lib/swarm-api";
import { useAvailableModels } from "@/hooks/use-available-models";
import type { GoalJudgeConfig } from "@/components/shared/session-quality/judge-config";
import {
  formatCriterion,
  SWARM_LEVEL_PREDICATE_KINDS,
} from "@/shared/predicate-kinds";
import {
  MAX_RUBRIC_CRITERIA,
  mintCriterionId,
  type JourneyCriterion,
} from "@/shared/journey-rubric";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** A generated persona + journeys, still only in memory. */
export type ProposedPersona = {
  /** Stable local key — these rows have no `_id` until launch. */
  key: string;
  name: string;
  role: string;
  notes?: string;
  avatarShape: number;
  avatarPalette: number;
  journeys: {
    key: string;
    name?: string;
    goal: string;
    /** Generation-suggested checks, stamped onto THIS journey's rubric only —
     * ids minted at proposal time so the row shown here is the row stamped. */
    checks?: JourneyCriterion[];
  }[];
};

/** An existing persona the user folded into this swarm. */
export type ReusedPersona = {
  _id: string;
  name: string;
  role: string;
  notes: string;
  avatarShape?: number;
  avatarPalette?: number;
};

/** One journey to launch, with the persona it belongs to (for the Running matrix). */
export type LaunchTarget = {
  journeyId: string;
  label: string;
  personaId: string;
  personaName: string;
  personaRole: string;
  avatarShape?: number;
  avatarPalette?: number;
  /** Stored env fan-out of a REUSED journey (`null` = legacy client-based).
   * Launch compares this to the Describe selection to decide whether the
   * journey must be re-stamped before launching. Absent on created targets —
   * they are born with the selection. */
  environmentIds?: string[] | null;
  /** Stored sessions-per-target of a REUSED journey (`null` = the row carries
   * no config). Launch does not rewrite a shared journey's config, so this —
   * not the intensity preset — is what the run will execute. Absent on created
   * targets, which are born with the preset's config. */
  sessionsPerTarget?: number | null;
};

export type ConfirmLaunchPayload = {
  rubric: JourneyCriterion[];
  judgeConfig?: GoalJudgeConfig;
  /** Existing journeys to launch. When the Describe step carries an explicit
   * environment selection, launch stamps it onto any of these whose stored
   * environments differ — the picker's promise wins over the journey's past. */
  reusedTargets: LaunchTarget[];
  /** Per reused journey: its current rubric. Swarm-level grading is MERGED
   * into it at launch (additive, structural dedupe) — same "this screen's
   * promise wins" rule as environments, minus the overwrite. */
  reusedGrading: { journeyId: string; existingRubric: JourneyCriterion[] }[];
};

type SelectedPersona =
  | { kind: "proposed"; key: string }
  | { kind: "reused"; id: string };

/**
 * Checks a fresh slate starts with, honoring the Describe step's "we infer …
 * a scoring rubric" promise. Confirm is a prune screen, so these arrive
 * pre-filled the same way personas do — and they're limited to the universal
 * instruments that hold for ANY server: no tool names, no thresholds to
 * guess, free to grade. Journey-specific checks (naming actual tools) belong
 * to generation and land with the backend follow-up.
 */
function starterRubric(): JourneyCriterion[] {
  return [
    { id: mintCriterionId(), predicate: { type: "noToolErrors" } },
    {
      id: mintCriterionId(),
      predicate: { type: "finalAssistantMessageNonEmpty" },
    },
  ];
}

type ReusedGoal = {
  journeyId: string;
  label: string;
};

type ReusedResolved = {
  targets: LaunchTarget[] | null;
  goals: ReusedGoal[];
  graded: boolean;
  /** Each journey's CURRENT rubric, so launch can merge swarm-level criteria
   * into it instead of overwriting what its owner authored. */
  grading: { journeyId: string; rubric: JourneyCriterion[] }[];
};

/** Uncommitted edits to one EXISTING persona, held while its panel is open. */
export type ReusedPersonaDraft = {
  name: string;
  role: string;
  notes: string;
  goals: Record<string, string>;
};

/**
 * What a draft would actually write.
 *
 * One definition of "what moved", because two callers ask the same question for
 * opposite reasons: Save sends exactly this, and closing the panel uses it to
 * know whether anything is about to be thrown away. Deriving them separately is
 * how a discard warning starts disagreeing with what a save would have done.
 */
export function diffReusedDraft(
  draft: ReusedPersonaDraft | undefined,
  persona: ReusedPersona,
  goals: readonly ReusedGoal[]
): {
  patch: { name?: string; role?: string; notes?: string };
  goalEdits: { journeyId: string; goal: string }[];
  dirty: boolean;
} {
  const patch: { name?: string; role?: string; notes?: string } = {};
  const goalEdits: { journeyId: string; goal: string }[] = [];
  if (!draft) return { patch, goalEdits, dirty: false };

  if (draft.name !== persona.name) patch.name = draft.name;
  if (draft.role !== persona.role) patch.role = draft.role;
  if (draft.notes !== (persona.notes ?? "")) patch.notes = draft.notes;

  for (const goal of goals) {
    const next = draft.goals[goal.journeyId];
    // A journey needs a goal — the backend throws on an empty one, so an
    // emptied field is dropped rather than sent and surfaced as an error the
    // user cannot act on from here. It is not a pending edit either: there is
    // nothing this panel could save, so closing loses nothing.
    if (next === undefined || next.trim().length === 0) continue;
    if (next === goal.label) continue;
    goalEdits.push({ journeyId: goal.journeyId, goal: next });
  }

  return {
    patch,
    goalEdits,
    dirty: Object.keys(patch).length > 0 || goalEdits.length > 0,
  };
}

function journeyLabel(journey: { name?: string; goal: string }): string {
  const name = journey.name?.trim();
  if (name) return name;
  const goal = journey.goal.trim();
  return goal.length > 48 ? `${goal.slice(0, 47)}…` : goal;
}

function personaContext(notes?: string, role?: string): string {
  return notes?.trim() || role?.trim() || "No use cases or context yet.";
}

/**
 * Collapsed persona card.
 *
 * `Edit` and `Remove` are always-visible buttons rather than a hover-only
 * overflow menu (BB-122): the whole point of this step is that the slate is
 * editable, and an affordance you have to hover to discover does not say so.
 * The card body stays clickable as a second route into the same expand.
 */
function CompactPersonaCard({
  seed,
  name,
  role,
  description,
  meta,
  muted,
  onSelect,
  onRemove,
  removeLabel,
  editLabel,
  avatarShape,
  avatarPalette,
}: {
  seed: string;
  name: string;
  role: string;
  description: string;
  meta: string;
  /** Another card is expanded — this one recedes rather than competing. */
  muted?: boolean;
  onSelect: () => void;
  onRemove: () => void;
  removeLabel: string;
  editLabel: string;
  avatarShape?: number;
  avatarPalette?: number;
}) {
  return (
    <li>
      {/* A plain div, not `role="button"`: it holds the real Edit and Remove
          buttons, and a widget that contains other widgets is exactly the
          nesting assistive tech cannot describe — the row announced itself as
          one button whose content was two more. The click handler stays, so
          clicking anywhere on the card still expands it for pointer users;
          keyboard users reach the same thing through Edit, which is a real
          focusable control and names its persona. */}
      <div
        data-testid="new-swarm-persona-compact"
        onClick={onSelect}
        className={cn(
          "flex w-full cursor-pointer items-start gap-4 rounded-xl border border-border/50 bg-muted/15 p-4 text-left transition-colors hover:bg-muted/25",
          muted && "opacity-70"
        )}
      >
        <PersonaPixelAvatar
          seed={seed}
          shapeIndex={avatarShape}
          paletteIndex={avatarPalette}
          size="lg"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p
            className={cn(
              "min-w-0 truncate text-sm font-semibold",
              muted ? "text-muted-foreground" : "text-foreground"
            )}
          >
            {name}
            {role ? (
              <span className="font-normal text-muted-foreground"> — {role}</span>
            ) : null}
          </p>
          <p
            className={cn(
              "line-clamp-2 text-sm leading-snug",
              muted ? "text-muted-foreground" : "text-foreground"
            )}
          >
            {description}
          </p>
          <p className="text-xs leading-snug text-muted-foreground">{meta}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7.5 px-2.5 text-xs"
            aria-label={editLabel}
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
          >
            Edit
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7.5 bg-background px-2.5 text-xs"
            aria-label={removeLabel}
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
          >
            Remove
          </Button>
        </div>
      </div>
    </li>
  );
}

/**
 * Expanded persona card — every field editable in place.
 *
 * The header carries Save changes and nothing else: Remove belongs to the
 * collapsed card, which is the list row, while this is the editor.
 *
 * That one button always shows and is always live — it means "done here" and
 * always collapses the panel. A header with no button reads as broken, and a
 * disabled one leaves the panel with no visible way out; Escape still works
 * but nobody guesses it.
 *
 * Focus moves into the panel on mount, which is what makes Escape reachable at
 * all: the Edit button that opened it unmounts on the same commit, so focus
 * would otherwise fall to `<body>` and the keydown handler would never see it.
 * The container takes focus rather than the first field — landing in a text
 * input announces the field instead of the editor.
 *
 * What it does before collapsing differs, because the two kinds of persona are
 * not the same thing.
 * A proposed persona only exists in memory: its edits already landed as they
 * were typed, so Save just closes. A reused persona is a database row shared
 * with every other swarm that pulled it in, so its edits are held in a local
 * draft and this is what commits them — mirroring keystrokes into a shared row
 * would rewrite other people's swarms as you type. A failed save keeps the
 * panel open with the draft intact.
 *
 * The two exits therefore mean two different things for a reused persona, and
 * both are honest about it: Save commits and collapses, Escape discards and
 * collapses. Neither leaves an edit that the collapsed card doesn't show and
 * the launch wouldn't use.
 */
function PersonaDetailPanel({
  seed,
  name,
  role,
  context,
  goals,
  graded,
  loadingGoals,
  draftEditable,
  onClose,
  onRemoveGoal,
  onRemoveCheck,
  onChangeName,
  onChangeRole,
  onChangeContext,
  onChangeGoal,
  onAddGoal,
  onSave,
  saving,
  avatarShape,
  avatarPalette,
}: {
  seed: string;
  name: string;
  role: string;
  context: string;
  goals: {
    key: string;
    label: string;
    /** Suggested deterministic checks scoped to this goal's journey. */
    checks?: { id: string; label: string }[];
  }[];
  graded?: boolean;
  loadingGoals?: boolean;
  /** In-memory row: edits apply immediately, no Save. */
  draftEditable?: boolean;
  /**
   * Leave the editor WITHOUT saving. Reached by Escape — the design shows no
   * close button. For a persisted persona the caller discards the draft, so
   * what the collapsed card shows is always what launches.
   */
  onClose: () => void;
  onRemoveGoal?: (goalKey: string) => void;
  onRemoveCheck?: (goalKey: string, checkId: string) => void;
  onChangeName?: (name: string) => void;
  onChangeRole?: (role: string) => void;
  onChangeContext?: (notes: string) => void;
  onChangeGoal?: (goalKey: string, goal: string) => void;
  onAddGoal?: () => void;
  /**
   * "Done here". Always offered: it commits a persisted row's draft (a no-op
   * for an unchanged one) and collapses the panel either way.
   */
  onSave: () => void;
  saving?: boolean;
  avatarShape?: number;
  avatarPalette?: number;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // An `useEffect`, not an inline ref callback: an inline callback is a new
  // function every render, so React would re-run it on each keystroke and yank
  // focus out of the field being typed in.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="rounded-xl border border-primary/50 bg-muted/30 outline-none ring-1 ring-primary/25"
      data-testid="new-swarm-persona-detail"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <PersonaPixelAvatar
          seed={seed}
          shapeIndex={avatarShape}
          paletteIndex={avatarPalette}
          size="lg"
        />
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 bg-background px-3 text-[13px]"
            disabled={saving}
            data-testid="new-swarm-persona-save"
            onClick={onSave}
          >
            {saving ? (
              <>
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              "Save changes"
            )}
          </Button>
        </div>
      </div>

      <div className="space-y-4 px-4 pb-4 pt-3">
        <div className="space-y-1.5">
          <SectionLabel>Name</SectionLabel>
          <Input
            value={name}
            onChange={(event) => onChangeName?.(event.target.value)}
            placeholder="Name"
            aria-label="Persona name"
            className="h-9 bg-background"
          />
        </div>

        <div className="space-y-1.5">
          <SectionLabel>Role</SectionLabel>
          <Input
            value={role}
            onChange={(event) => onChangeRole?.(event.target.value)}
            placeholder="Role"
            aria-label="Persona role"
            className="h-9 bg-background"
          />
        </div>

        <div className="space-y-1.5">
          <SectionLabel>Use cases &amp; context</SectionLabel>
          <textarea
            value={context}
            onChange={(event) => onChangeContext?.(event.target.value)}
            placeholder="Who they are and how they show up…"
            aria-label="Use cases and context"
            rows={4}
            className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2.5 text-sm leading-relaxed text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <SectionLabel>Goals</SectionLabel>
            {onAddGoal ? (
              <button
                type="button"
                onClick={onAddGoal}
                data-testid="new-swarm-add-goal"
                className="text-xs font-medium text-primary hover:text-primary/80"
              >
                + Add goal
              </button>
            ) : null}
          </div>
          {loadingGoals ? (
            <p className="text-sm text-muted-foreground">Loading goals…</p>
          ) : goals.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border/60 px-3 py-2.5 text-sm text-muted-foreground">
              No goals yet — this persona has nothing to run.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {goals.map((goal) => (
                <li key={goal.key}>
                  <div className="flex items-center gap-2.5 rounded-lg border border-input bg-background px-3 py-2">
                    <span
                      className="size-2 shrink-0 rounded-full bg-primary"
                      aria-hidden
                    />
                    {onChangeGoal ? (
                      <Input
                        value={goal.label}
                        onChange={(event) =>
                          onChangeGoal(goal.key, event.target.value)
                        }
                        placeholder="What should they try to do?"
                        aria-label="Goal"
                        className="h-7 min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                      />
                    ) : (
                      <span className="min-w-0 flex-1 text-sm leading-snug text-foreground">
                        {goal.label}
                      </span>
                    )}
                    {onRemoveGoal ? (
                      <button
                        type="button"
                        aria-label={`Remove goal ${goal.label}`}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={() => onRemoveGoal(goal.key)}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    ) : null}
                  </div>
                  {/* Journey-scoped checks live with the journey they grade,
                      not in the swarm-level rubric below the persona list —
                      stamping them there would drag down pass rates on
                      journeys that never touch the tool. */}
                  {goal.checks && goal.checks.length > 0 ? (
                    <ul
                      className="mt-1.5 flex flex-wrap gap-1.5 pl-4"
                      aria-label={`Suggested checks for ${goal.label}`}
                    >
                      {goal.checks.map((check) => (
                        <li
                          key={check.id}
                          data-testid="new-swarm-journey-check"
                          className="flex items-center gap-1 rounded-full border border-border/50 bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground"
                        >
                          {check.label}
                          {onRemoveCheck ? (
                            <button
                              type="button"
                              aria-label={`Remove check ${check.label}`}
                              className="text-muted-foreground hover:text-foreground"
                              onClick={() => onRemoveCheck(goal.key, check.id)}
                            >
                              <X className="size-3" />
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {graded ? (
            <p className="text-xs text-muted-foreground">
              Has its own grading — swarm-level checks are merged in at launch,
              never replacing it.
            </p>
          ) : null}
          {draftEditable ? null : (
            <p className="text-xs text-muted-foreground">
              This persona is saved in your project. Edits here update it
              everywhere it is reused.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Keeps journeys for one reused persona subscribed and reports them upward.
 * Mounted for every reused row so expand/collapse never drops the query.
 */
function ReusedPersonaJourneyLoader({
  persona,
  onResolved,
}: {
  persona: ReusedPersona;
  onResolved: (personaId: string, data: ReusedResolved) => void;
}) {
  const journeys = useQuery(
    SWARM_QUERIES.listJourneysByPersona as any,
    { personaRefId: persona._id } as any
  ) as
    | {
        _id: string;
        name?: string;
        goal: string;
        rubric?: JourneyCriterion[] | null;
        judgeConfig?: GoalJudgeConfig;
        environmentIds?: string[] | null;
        config?: { sessionsPerTarget?: number; maxTurns?: number } | null;
      }[]
    | undefined;

  const resolved = useMemo((): ReusedResolved => {
    if (journeys === undefined) {
      return { targets: null, goals: [], graded: false, grading: [] };
    }
    return {
      grading: journeys.map((journey) => ({
        journeyId: journey._id,
        rubric: journey.rubric ?? [],
      })),
      targets: journeys.map((journey) => ({
        journeyId: journey._id,
        label: `${persona.name} · ${journeyLabel(journey)}`,
        personaId: persona._id,
        personaName: persona.name,
        personaRole: persona.role,
        environmentIds: journey.environmentIds ?? null,
        sessionsPerTarget: journey.config?.sessionsPerTarget ?? null,
        ...(persona.avatarShape !== undefined
          ? { avatarShape: persona.avatarShape }
          : {}),
        ...(persona.avatarPalette !== undefined
          ? { avatarPalette: persona.avatarPalette }
          : {}),
      })),
      goals: journeys.map((journey) => ({
        journeyId: journey._id,
        label: journeyLabel(journey),
      })),
      graded: journeys.some(
        (journey) =>
          (journey.rubric && journey.rubric.length > 0) || journey.judgeConfig
      ),
    };
  }, [
    journeys,
    persona._id,
    persona.name,
    persona.role,
    persona.avatarShape,
    persona.avatarPalette,
  ]);

  useEffect(() => {
    onResolved(persona._id, resolved);
  }, [onResolved, persona._id, resolved]);

  return null;
}

/**
 * Compact selectable row for an existing persona folded into this swarm.
 */
function ReusedPersonaCard({
  persona,
  muted,
  onSelect,
  onRemove,
  resolved,
}: {
  persona: ReusedPersona;
  muted?: boolean;
  onSelect: () => void;
  onRemove: () => void;
  resolved: ReusedResolved | undefined;
}) {
  const goalCount = resolved?.goals.length;
  const meta =
    resolved == null || resolved.targets === null
      ? "Loading goals…"
      : [
          `${goalCount} ${goalCount === 1 ? "goal" : "goals"}`,
          "existing",
          resolved.graded ? "own grading" : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <CompactPersonaCard
      seed={persona._id}
      name={persona.name}
      role={persona.role}
      description={personaContext(persona.notes, persona.role)}
      meta={meta}
      muted={muted}
      onSelect={onSelect}
      onRemove={onRemove}
      editLabel={`Edit ${persona.name}`}
      removeLabel={`Remove ${persona.name} from this swarm`}
      avatarShape={persona.avatarShape}
      avatarPalette={persona.avatarPalette}
    />
  );
}

export function NewSwarmConfirmStep({
  projectId,
  proposed,
  onProposedChange,
  reusedPersonas,
  onRemoveReused,
  preset,
  pushIntensity,
  onPushIntensityChange,
  environmentCount,
  environmentLabels,
  launching,
  errorMessage,
  onBack,
  onLaunch,
  header,
  availablePersonas,
  onAddReused,
  onSaveReusedPersona,
  onSaveReusedGoal,
}: {
  projectId: string;
  proposed: ProposedPersona[];
  onProposedChange: (next: ProposedPersona[]) => void;
  reusedPersonas: ReusedPersona[];
  onRemoveReused: (personaId: string) => void;
  preset: SwarmIntensityPreset;
  pushIntensity: SwarmPushIntensity;
  onPushIntensityChange: (value: SwarmPushIntensity) => void;
  environmentCount: number;
  /** Display names of the environments this launch will fan out across. */
  environmentLabels: string[];
  launching: boolean;
  errorMessage: string | null;
  onBack: () => void;
  onLaunch: (payload: ConfirmLaunchPayload) => void;
  /** Leave the create flow and open Personas for an existing persona. */
  /** Back link + stepper, built by the flow so both steps show the same one. */
  header?: ReactNode;
  /** Every persona in the project, for "Add existing personas". */
  availablePersonas: readonly ReusedPersona[];
  onAddReused: (personaRefId: string) => void;
  /**
   * Persist an edit to an existing persona. Called from the explicit Save —
   * the row is shared, so keystrokes must not reach it.
   */
  onSaveReusedPersona: (
    personaRefId: string,
    patch: { name?: string; role?: string; notes?: string }
  ) => Promise<void>;
  /** Persist an edit to an existing journey's goal text. */
  onSaveReusedGoal: (journeyRefId: string, goal: string) => Promise<void>;
}) {
  const [judgeConfig, setJudgeConfig] = useState<GoalJudgeConfig | undefined>(
    undefined
  );
  // Always seeded: swarm-level grading applies to every journey this swarm
  // launches — created ones get it stamped, reused ones get it MERGED into
  // their own rubric (existing rows survive; structural dupes are skipped).
  // Lazy init on purpose: Back discards all grading state anyway.
  const [rubric, setRubric] = useState<JourneyCriterion[]>(() =>
    starterRubric()
  );
  const [gradingOpen, setGradingOpen] = useState(false);
  const [selected, setSelected] = useState<SelectedPersona | null>(null);
  const [reusedResolved, setReusedResolved] = useState<
    Record<string, ReusedResolved>
  >({});
  const { availableModels } = useAvailableModels({ projectId });

  const handleReusedResolved = useCallback(
    (personaId: string, data: ReusedResolved) => {
      setReusedResolved((current) => {
        const previous = current[personaId];
        const prevTargets = previous?.targets;
        const nextTargets = data.targets;
        const targetsMatch =
          prevTargets === nextTargets ||
          (prevTargets != null &&
            nextTargets != null &&
            prevTargets.length === nextTargets.length &&
            prevTargets.every(
              (entry, index) =>
                entry.journeyId === nextTargets[index]?.journeyId &&
                // The stored sessions ride the target and drive the estimate,
                // so an id-only comparison would keep quoting a stale number
                // after someone edits that goal's sessions mid-flow.
                entry.sessionsPerTarget ===
                  nextTargets[index]?.sessionsPerTarget
            ));
        const goalsMatch =
          previous != null &&
          previous.goals.length === data.goals.length &&
          previous.goals.every(
            (goal, index) =>
              goal.journeyId === data.goals[index]?.journeyId &&
              goal.label === data.goals[index]?.label
          );
        if (
          previous &&
          previous.graded === data.graded &&
          targetsMatch &&
          goalsMatch
        ) {
          return current;
        }
        return { ...current, [personaId]: data };
      });
    },
    []
  );

  const newLocalKey = (prefix: string) =>
    `${prefix}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

  const patchProposed = (
    key: string,
    patch: (persona: ProposedPersona) => ProposedPersona
  ) => {
    onProposedChange(
      proposed.map((persona) => (persona.key === key ? patch(persona) : persona))
    );
  };

  const removePersona = (key: string) => {
    onProposedChange(proposed.filter((persona) => persona.key !== key));
    setSelected((current) =>
      current?.kind === "proposed" && current.key === key ? null : current
    );
  };
  const removeJourney = (personaKey: string, journeyKey: string) => {
    // Keep an empty draft persona on the board — the user may still be
    // authoring goals. Launch simply skips personas with no journeys.
    patchProposed(personaKey, (persona) => ({
      ...persona,
      journeys: persona.journeys.filter((journey) => journey.key !== journeyKey),
    }));
  };
  const removeJourneyCheck = (
    personaKey: string,
    journeyKey: string,
    checkId: string
  ) => {
    patchProposed(personaKey, (persona) => ({
      ...persona,
      journeys: persona.journeys.map((journey) =>
        journey.key === journeyKey
          ? {
              ...journey,
              checks: (journey.checks ?? []).filter(
                (check) => check.id !== checkId
              ),
            }
          : journey
      ),
    }));
  };
  const addPersona = () => {
    const key = newLocalKey("persona");
    const next: ProposedPersona = {
      key,
      name: "New persona",
      role: "Role",
      ...mintPersonaAvatarLook(),
      journeys: [
        {
          key: newLocalKey("journey"),
          goal: "",
        },
      ],
    };
    onProposedChange([...proposed, next]);
    setSelected({ kind: "proposed", key });
  };
  const addGoal = (personaKey: string) => {
    patchProposed(personaKey, (persona) => ({
      ...persona,
      journeys: [
        ...persona.journeys,
        { key: newLocalKey("journey"), goal: "" },
      ],
    }));
  };
  const removeReused = (personaId: string) => {
    onRemoveReused(personaId);
    setSelected((current) =>
      current?.kind === "reused" && current.id === personaId ? null : current
    );
  };

  const reusedPending = reusedPersonas.some(
    (persona) => (reusedResolved[persona._id]?.targets ?? null) === null
  );
  const activeReusedTargets = reusedPersonas.flatMap(
    (persona) => reusedResolved[persona._id]?.targets ?? []
  );
  // Empty draft goals stay visible for authoring but don't count toward
  // launch readiness — Create & launch only persists trimmed goals.
  const newJourneyCount = proposed.reduce(
    (sum, persona) =>
      sum + persona.journeys.filter((journey) => journey.goal.trim()).length,
    0
  );
  const journeyCount = newJourneyCount + activeReusedTargets.length;
  // Every journey this launch fans out, not just the newly authored ones —
  // a reuse-heavy swarm was under-reporting its own session count. Reused
  // journeys are counted at THEIR OWN sessions, which is what launch runs
  // them at; the preset only sizes the journeys this swarm creates.
  const launchSessionEstimate = estimateLaunchSessions({
    preset,
    newJourneyCount,
    reusedSessionsPerTarget: activeReusedTargets.map(
      (target) => target.sessionsPerTarget ?? null
    ),
    environmentCount,
  });
  /**
   * Rubric budget held back for per-journey suggested checks. Launch stamps
   * the swarm rubric FIRST and appends each journey's own checks after, then
   * hard-slices at the cap — so without this reserve a full swarm rubric is
   * exactly what silently drops the tool-specific checks generation produced.
   * Reserve the worst case (the journey carrying the most checks), since the
   * cap applies per journey, not across the swarm.
   */
  const reservedCheckSlots = proposed.reduce(
    (worst, persona) =>
      persona.journeys.reduce(
        (inner, journey) => Math.max(inner, journey.checks?.length ?? 0),
        worst
      ),
    0
  );
  const rubricValid = areAllChecksValid(rubric.map((entry) => entry.predicate));
  const canLaunch =
    journeyCount > 0 && rubricValid && !launching && !reusedPending;

  const selectedProposed =
    selected?.kind === "proposed"
      ? proposed.find((persona) => persona.key === selected.key) ?? null
      : null;
  const selectedReused =
    selected?.kind === "reused"
      ? reusedPersonas.find((persona) => persona._id === selected.id) ?? null
      : null;

  /**
   * Uncommitted edits to EXISTING personas, keyed by persona id.
   *
   * Held locally instead of written through because the row is shared: typing
   * in this panel must not rewrite another swarm's persona until the user says
   * so. Cleared on a successful save, so the panel falls back to the live query
   * and cannot show a stale "saved" value.
   */
  const [reusedDrafts, setReusedDrafts] = useState<
    Record<string, ReusedPersonaDraft>
  >({});
  const [savingReusedId, setSavingReusedId] = useState<string | null>(null);
  const [addExistingOpen, setAddExistingOpen] = useState(false);

  const patchReusedDraft = useCallback(
    (
      persona: ReusedPersona,
      goals: ReusedGoal[],
      patch: Partial<{ name: string; role: string; notes: string }> & {
        goal?: { journeyId: string; text: string };
      }
    ) => {
      setReusedDrafts((drafts) => {
        const current =
          drafts[persona._id] ??
          {
            name: persona.name,
            role: persona.role,
            notes: persona.notes ?? "",
            goals: Object.fromEntries(
              goals.map((goal) => [goal.journeyId, goal.label])
            ),
          };
        const next = {
          ...current,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.role === undefined ? {} : { role: patch.role }),
          ...(patch.notes === undefined ? {} : { notes: patch.notes }),
          goals: patch.goal
            ? { ...current.goals, [patch.goal.journeyId]: patch.goal.text }
            : current.goals,
        };
        return { ...drafts, [persona._id]: next };
      });
    },
    []
  );

  const saveReused = useCallback(
    async (persona: ReusedPersona, goals: ReusedGoal[]) => {
      const draft = reusedDrafts[persona._id];
      // Nothing typed: Save still means "done", so just collapse.
      if (!draft) {
        setSelected(null);
        return;
      }
      setSavingReusedId(persona._id);
      try {
        // Only what actually moved. A no-op patch would still bump the row's
        // `updatedAt` for every other swarm reusing it.
        const { patch, goalEdits } = diffReusedDraft(draft, persona, goals);
        if (Object.keys(patch).length > 0) {
          await onSaveReusedPersona(persona._id, patch);
        }
        for (const edit of goalEdits) {
          await onSaveReusedGoal(edit.journeyId, edit.goal);
        }
        setReusedDrafts((drafts) => {
          const { [persona._id]: _saved, ...rest } = drafts;
          return rest;
        });
        // Only on the way out of a clean save — a throw leaves the panel open
        // with the draft still in it, so the edit is not silently lost.
        setSelected(null);
      } catch (error) {
        // The call site invokes this with `void`, so without this the rejection
        // was an unhandled promise and the user saw nothing at all. The draft
        // and the open panel are deliberately left alone: the edit is still on
        // screen to retry, which is the whole reason it is held locally.
        toast.error(
          error instanceof Error
            ? error.message
            : "Couldn't save this persona. Your changes are still here."
        );
      } finally {
        setSavingReusedId(null);
      }
    },
    [onSaveReusedGoal, onSaveReusedPersona, reusedDrafts]
  );

  /**
   * Close WITHOUT saving — the Escape route out of a reused persona's editor.
   *
   * It discards, rather than keeping the draft around: this row is never
   * launched from the draft, so a kept-but-uncommitted edit is one the collapsed
   * card doesn't show and the launch doesn't use, and the user only finds out
   * their typing did nothing after the swarm has run. Whatever the collapsed
   * card shows is what launches, on both exits.
   *
   * A toast, and only when something was actually lost: silently dropping text
   * somebody typed is the other half of the same problem.
   */
  const discardReused = useCallback(
    (persona: ReusedPersona, goals: ReusedGoal[]) => {
      const { dirty } = diffReusedDraft(reusedDrafts[persona._id], persona, goals);
      if (dirty) {
        setReusedDrafts((drafts) => {
          const { [persona._id]: _discarded, ...rest } = drafts;
          return rest;
        });
        toast.info(`Discarded unsaved changes to ${persona.name}.`);
      }
      setSelected(null);
    },
    [reusedDrafts]
  );

  const personasAvailableToAdd = useMemo(
    () =>
      availablePersonas.filter(
        (persona) =>
          !reusedPersonas.some((chosen) => chosen._id === persona._id)
      ),
    [availablePersonas, reusedPersonas]
  );

  // Drop stale selection if the persona was removed elsewhere.
  useEffect(() => {
    if (selected?.kind === "proposed" && !selectedProposed) {
      setSelected(null);
    }
    if (selected?.kind === "reused" && !selectedReused) {
      setSelected(null);
    }
  }, [selected, selectedProposed, selectedReused]);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-y-auto"
      data-testid="new-swarm-confirm-step"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
        {header}
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
            Review your users and what they&rsquo;ll accomplish
          </h2>
          <p className="text-sm leading-relaxed text-foreground">
            Select a user persona for details, or remove anything that
            doesn&rsquo;t fit.
          </p>
          <p className="sr-only" data-testid="new-swarm-launch-session-estimate">
            This launch will run {launchSessionEstimate}{" "}
            {launchSessionEstimate === 1 ? "session" : "sessions"} total across{" "}
            {journeyCount} {journeyCount === 1 ? "goal" : "goals"}.
          </p>
          {environmentLabels.length > 0 && proposed.length > 0 ? (
            <p
              className="text-sm leading-relaxed text-muted-foreground"
              data-testid="new-swarm-confirm-clients"
            >
              New goals run on{" "}
              <span className="font-medium text-foreground">
                {environmentLabels.join(" · ")}
              </span>
              {environmentLabels.length === 1
                ? " — pick more environments on Describe to compare clients."
                : "."}
            </p>
          ) : null}
        </div>

        {proposed.length > 0 ? (
          <ul className="space-y-2" data-testid="new-swarm-proposed-personas">
            {proposed.map((persona) => {
              const isSelected =
                selected?.kind === "proposed" && selected.key === persona.key;
              if (isSelected) {
                return (
                  <li key={persona.key}>
                    <PersonaDetailPanel
                      seed={persona.key}
                      name={persona.name}
                      role={persona.role}
                      context={persona.notes ?? ""}
                      goals={persona.journeys.map((journey) => ({
                        key: journey.key,
                        label: journey.goal,
                        ...(journey.checks && journey.checks.length > 0
                          ? {
                              checks: journey.checks.map((check) => ({
                                id: check.id,
                                label: formatCriterion(check),
                              })),
                            }
                          : {}),
                      }))}
                      draftEditable
                      avatarShape={persona.avatarShape}
                      avatarPalette={persona.avatarPalette}
                      onClose={() => setSelected(null)}
                      onRemoveGoal={(goalKey) =>
                        removeJourney(persona.key, goalKey)
                      }
                      onRemoveCheck={(goalKey, checkId) =>
                        removeJourneyCheck(persona.key, goalKey, checkId)
                      }
                      onChangeName={(nextName) =>
                        patchProposed(persona.key, (current) => ({
                          ...current,
                          name: nextName,
                        }))
                      }
                      onChangeRole={(nextRole) =>
                        patchProposed(persona.key, (current) => ({
                          ...current,
                          role: nextRole,
                        }))
                      }
                      onChangeContext={(notes) =>
                        patchProposed(persona.key, (current) => ({
                          ...current,
                          notes,
                        }))
                      }
                      onChangeGoal={(goalKey, goal) =>
                        patchProposed(persona.key, (current) => ({
                          ...current,
                          journeys: current.journeys.map((journey) =>
                            journey.key === goalKey
                              ? { ...journey, goal }
                              : journey
                          ),
                        }))
                      }
                      onAddGoal={() => addGoal(persona.key)}
                      // In-memory edits already landed as they were typed, so
                      // this only collapses the editor.
                      onSave={() => setSelected(null)}
                    />
                  </li>
                );
              }
              const goalCount = persona.journeys.length;
              return (
                <CompactPersonaCard
                  key={persona.key}
                  seed={persona.key}
                  name={persona.name}
                  role={persona.role}
                  description={personaContext(persona.notes, persona.role)}
                  meta={`${goalCount} ${
                    goalCount === 1 ? "goal" : "goals"
                  } · new`}
                  muted={selected !== null}
                  onSelect={() =>
                    setSelected({ kind: "proposed", key: persona.key })
                  }
                  onRemove={() => removePersona(persona.key)}
                  editLabel={`Edit persona ${persona.name}`}
                  removeLabel={`Remove persona ${persona.name}`}
                  avatarShape={persona.avatarShape}
                  avatarPalette={persona.avatarPalette}
                />
              );
            })}
          </ul>
        ) : null}

        {reusedPersonas.length > 0 ? (
          <>
            {reusedPersonas.map((persona) => (
              <ReusedPersonaJourneyLoader
                key={`load-${persona._id}`}
                persona={persona}
                onResolved={handleReusedResolved}
              />
            ))}
            <ul className="space-y-2" data-testid="new-swarm-reused-personas">
              {reusedPersonas.map((persona) => {
                const isSelected =
                  selected?.kind === "reused" && selected.id === persona._id;
                if (isSelected) {
                  return (
                    <li key={persona._id}>
                      {(() => {
                        const goals =
                          reusedResolved[persona._id]?.goals ?? [];
                        const draft = reusedDrafts[persona._id];
                        const goalText = (goal: ReusedGoal) =>
                          draft?.goals[goal.journeyId] ?? goal.label;
                        return (
                          <PersonaDetailPanel
                            seed={persona._id}
                            name={draft?.name ?? persona.name}
                            role={draft?.role ?? persona.role}
                            context={draft?.notes ?? persona.notes ?? ""}
                            goals={goals.map((goal) => ({
                              key: goal.journeyId,
                              label: goalText(goal),
                            }))}
                            graded={reusedResolved[persona._id]?.graded}
                            loadingGoals={
                              (reusedResolved[persona._id]?.targets ??
                                null) === null
                            }
                            avatarShape={persona.avatarShape}
                            avatarPalette={persona.avatarPalette}
                            onClose={() => discardReused(persona, goals)}
                            onChangeName={(name) =>
                              patchReusedDraft(persona, goals, { name })
                            }
                            onChangeRole={(role) =>
                              patchReusedDraft(persona, goals, { role })
                            }
                            onChangeContext={(notes) =>
                              patchReusedDraft(persona, goals, { notes })
                            }
                            onChangeGoal={(journeyId, text) =>
                              patchReusedDraft(persona, goals, {
                                goal: { journeyId, text },
                              })
                            }
                            onSave={() => void saveReused(persona, goals)}
                            saving={savingReusedId === persona._id}
                          />
                        );
                      })()}
                    </li>
                  );
                }
                return (
                  <ReusedPersonaCard
                    key={persona._id}
                    persona={persona}
                    muted={selected !== null}
                    onSelect={() =>
                      setSelected({ kind: "reused", id: persona._id })
                    }
                    onRemove={() => removeReused(persona._id)}
                    resolved={reusedResolved[persona._id]}
                  />
                );
              })}
            </ul>
          </>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            onClick={addPersona}
            data-testid="new-swarm-add-persona"
          >
            Add new persona
          </Button>
          {personasAvailableToAdd.length > 0 ? (
            // Add-only: what is already attached is dropped from the list, and
            // detaching is the card's own Remove.
            <PersonaPickerPopover
              personas={personasAvailableToAdd}
              open={addExistingOpen}
              onOpenChange={setAddExistingOpen}
              groupLabel="Add existing persona"
              triggerLabel="Add existing persona"
              triggerSize="sm"
              triggerTestId="new-swarm-confirm-add-existing"
              showTriggerIcon={false}
              mode={{ kind: "add", onAdd: onAddReused }}
            />
          ) : null}
        </div>

        <div className="space-y-2">
          <div className="space-y-1">
            <div
              id="new-swarm-session-scope-label"
              className="text-sm font-medium text-foreground"
            >
              Select the total number of sessions for the swarm.
              <RequiredMark />
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              We will distribute your user personas equally across the total
              number of sessions.
            </p>
          </div>
          <div
            role="radiogroup"
            aria-labelledby="new-swarm-session-scope-label"
            data-testid="new-swarm-push-intensity"
            className="grid grid-cols-1 gap-1 rounded-xl bg-muted/50 p-1 sm:grid-cols-3"
          >
            {SWARM_INTENSITY_ORDER.map((value) => {
              const option = SWARM_INTENSITY_PRESETS[value];
              const selected = pushIntensity === value;
              const sessions = estimateSwarmSessions(option, environmentCount);
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onPushIntensityChange(value)}
                  className={cn(
                    "rounded-lg px-3 py-2.5 text-left transition-colors",
                    selected
                      ? "bg-background shadow-sm ring-1 ring-border/60"
                      : "hover:bg-background/60"
                  )}
                >
                  <span className="block text-sm font-semibold text-foreground">
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-sm leading-relaxed text-muted-foreground">
                    {sessions} sessions
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Scoring applies to EVERY journey this swarm launches: stamped
            onto created journeys, merged additively into reused ones (their
            own rows survive with their ids). Always visible for the same
            reason the environment picker is — this screen's promise wins. */}
        <div className="border-t border-border/40 pt-3">
          <button
            type="button"
            onClick={() => setGradingOpen((open) => !open)}
            className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={gradingOpen}
            data-testid="new-swarm-grading-toggle"
          >
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform",
                gradingOpen && "rotate-180"
              )}
            />
            Grading
            {(() => {
              // Same invitation the header line makes with "2 personas ·
              // 10 journeys": say what's inside before it's opened.
              const journeyCheckCount = proposed.reduce(
                (sum, persona) =>
                  sum +
                  persona.journeys.reduce(
                    (inner, journey) =>
                      inner + (journey.checks?.length ?? 0),
                    0
                  ),
                0
              );
              const summary = [
                judgeConfig ? "judge on" : null,
                rubric.length > 0
                  ? `${rubric.length} ${
                      rubric.length === 1 ? "check" : "checks"
                    }`
                  : null,
                journeyCheckCount > 0
                  ? `${journeyCheckCount} goal-specific`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return summary ? (
                <span className="font-normal text-muted-foreground/80">
                  · {summary}
                </span>
              ) : null;
            })()}
          </button>
          {gradingOpen ? (
            <div className="mt-2">
              <JudgesSection
                chrome="bare"
                value={judgeConfig}
                onChange={setJudgeConfig}
                availableModels={availableModels}
                bareAutoGradeBlurb="Grade every session in this swarm automatically against its goal. Uses credits. You can also judge any session on demand from its detail view."
                bareAutoGradeAriaLabel="Auto-grade every session with LLM as Judge"
              />
              <div className="mt-3 border-t border-border/40 pt-3">
                <JourneyRubricEditor
                  value={rubric}
                  onChange={setRubric}
                  allowedKinds={SWARM_LEVEL_PREDICATE_KINDS}
                  maxCriteria={MAX_RUBRIC_CRITERIA - reservedCheckSlots}
                />
                {reservedCheckSlots > 0 ? (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Goal-specific checks were also suggested — they
                    appear with each persona&rsquo;s goals, and grade only
                    their own goal. {reservedCheckSlots}{" "}
                    {reservedCheckSlots === 1 ? "slot is" : "slots are"}{" "}
                    reserved for them.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        {errorMessage ? (
          <p role="alert" className="text-sm leading-relaxed text-destructive">
            {errorMessage}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-5 pt-2">
          <Button
            type="button"
            variant="ghost"
            disabled={launching}
            onClick={onBack}
          >
            Back
          </Button>
          <Button
            type="button"
            disabled={!canLaunch}
            data-testid="new-swarm-launch"
            onClick={() =>
              onLaunch({
                rubric,
                ...(judgeConfig ? { judgeConfig } : {}),
                reusedTargets: activeReusedTargets,
                reusedGrading: reusedPersonas.flatMap((persona) =>
                  (reusedResolved[persona._id]?.grading ?? []).map(
                    (entry) => ({
                      journeyId: entry.journeyId,
                      existingRubric: entry.rubric,
                    })
                  )
                ),
              })
            }
          >
            {launching ? (
              <>
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                Launching…
              </>
            ) : (
              "Continue"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
