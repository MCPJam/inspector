/**
 * Confirm step of the New swarm create flow.
 *
 * Everything the swarm will do, before anything is written: the generated
 * personas (each with its journeys, both removable), any existing personas the
 * user folded in, and ONE grading section whose rubric + judge config is
 * stamped onto every journey this launch creates.
 *
 * Nothing here is persisted until "Create & launch" — the create flow holds
 * the proposal in memory, so removing a persona costs nothing and a cancelled
 * flow leaves no rows behind (unlike GenerateSwarmDialog, which commits the
 * persona before its journeys).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, Trash2 } from "lucide-react";
import { useQuery } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import { JudgesSection } from "@/components/evals/judges-section";
import { areAllChecksValid } from "@/components/evals/checks-section";
import { JourneyRubricEditor } from "@/components/swarms/journey-rubric-editor";
import { PersonaPixelAvatar } from "@/components/swarms/persona-pixel-avatar";
import type { SwarmIntensityPreset } from "@/components/swarms/swarm-intensity";
import { SWARM_QUERIES } from "@/lib/swarm-api";
import { useAvailableModels } from "@/hooks/use-available-models";
import type { GoalJudgeConfig } from "@/components/shared/session-quality/judge-config";
import type { JourneyCriterion } from "@/shared/journey-rubric";
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
  journeys: { key: string; name?: string; goal: string }[];
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

/** One journey to launch, with the label its run is shown under. */
export type LaunchTarget = { journeyId: string; label: string };

export type ConfirmLaunchPayload = {
  rubric: JourneyCriterion[];
  judgeConfig?: GoalJudgeConfig;
  /** Existing journeys to launch as-is (no writes). */
  reusedTargets: LaunchTarget[];
};

function journeyLabel(journey: { name?: string; goal: string }): string {
  const name = journey.name?.trim();
  if (name) return name;
  const goal = journey.goal.trim();
  return goal.length > 48 ? `${goal.slice(0, 47)}…` : goal;
}

/**
 * One reused persona's card. Each mounts its own `listJourneysByPersona`
 * subscription — a component per persona rather than a loop, so the hook count
 * stays fixed per card as the selection changes.
 */
function ReusedPersonaCard({
  persona,
  onJourneysChange,
  onRemove,
}: {
  persona: ReusedPersona;
  /** `null` = still loading. Distinguished from `[]` so the parent can hold
   * Launch instead of silently launching without this persona's journeys. */
  onJourneysChange: (personaId: string, targets: LaunchTarget[] | null) => void;
  onRemove: () => void;
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
      }[]
    | undefined;

  const targets = useMemo(
    () =>
      journeys === undefined
        ? null
        : journeys.map((journey) => ({
            journeyId: journey._id,
            label: `${persona.name} · ${journeyLabel(journey)}`,
          })),
    [journeys, persona.name]
  );

  // Report upward whenever the resolved set changes so the launch payload
  // always reflects what this card is actually showing. In an effect, never
  // during render — this writes state in the parent.
  useEffect(() => {
    onJourneysChange(persona._id, targets);
  }, [onJourneysChange, persona._id, targets]);

  const graded = (journeys ?? []).some(
    (journey) =>
      (journey.rubric && journey.rubric.length > 0) || journey.judgeConfig
  );

  return (
    <li className="rounded-xl border border-border/60 bg-card/40 p-3">
      <div className="flex items-start gap-3">
        <PersonaPixelAvatar
          seed={persona._id}
          shapeIndex={persona.avatarShape}
          paletteIndex={persona.avatarPalette}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">
              {persona.name}
            </span>
            <Badge variant="outline" className="shrink-0 text-[10px]">
              Existing
            </Badge>
          </div>
          <p className="truncate text-sm text-muted-foreground">
            {persona.role}
          </p>
          {journeys === undefined ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Loading journeys…
            </p>
          ) : journeys.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              No journeys yet — this persona has nothing to run.
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {journeys.map((journey) => (
                <li
                  key={journey._id}
                  className="truncate text-sm text-muted-foreground"
                >
                  {journeyLabel(journey)}
                </li>
              ))}
            </ul>
          )}
          {graded ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Keeps its own grading and environments.
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Remove ${persona.name} from this swarm`}
          onClick={onRemove}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}

export function NewSwarmConfirmStep({
  projectId,
  proposed,
  onProposedChange,
  reusedPersonas,
  onRemoveReused,
  preset,
  environmentCount,
  launching,
  errorMessage,
  onBack,
  onLaunch,
}: {
  projectId: string;
  proposed: ProposedPersona[];
  onProposedChange: (next: ProposedPersona[]) => void;
  reusedPersonas: ReusedPersona[];
  onRemoveReused: (personaId: string) => void;
  preset: SwarmIntensityPreset;
  environmentCount: number;
  launching: boolean;
  errorMessage: string | null;
  onBack: () => void;
  onLaunch: (payload: ConfirmLaunchPayload) => void;
}) {
  const [judgeConfig, setJudgeConfig] = useState<GoalJudgeConfig | undefined>(
    undefined
  );
  const [rubric, setRubric] = useState<JourneyCriterion[]>([]);
  const [gradingOpen, setGradingOpen] = useState(false);
  const [reusedTargets, setReusedTargets] = useState<
    Record<string, LaunchTarget[] | null>
  >({});
  const { availableModels } = useAvailableModels({ projectId });

  const handleReusedJourneys = useCallback(
    (personaId: string, targets: LaunchTarget[] | null) => {
      setReusedTargets((current) => {
        const previous = current[personaId];
        if (previous === targets) return current;
        if (
          previous &&
          targets &&
          previous.length === targets.length &&
          previous.every(
            (entry, index) => entry.journeyId === targets[index].journeyId
          )
        ) {
          return current;
        }
        return { ...current, [personaId]: targets };
      });
    },
    []
  );

  const removePersona = (key: string) => {
    onProposedChange(proposed.filter((persona) => persona.key !== key));
  };
  const removeJourney = (personaKey: string, journeyKey: string) => {
    onProposedChange(
      proposed
        .map((persona) =>
          persona.key === personaKey
            ? {
                ...persona,
                journeys: persona.journeys.filter(
                  (journey) => journey.key !== journeyKey
                ),
              }
            : persona
        )
        // A persona with no journeys left has nothing to run: drop it rather
        // than creating a row that produces no sessions.
        .filter((persona) => persona.journeys.length > 0)
    );
  };

  // A reused persona whose journeys haven't resolved yet holds Launch: firing
  // now would quietly launch the swarm WITHOUT that persona's journeys, and
  // the user would have no way to tell that's what happened.
  const reusedPending = reusedPersonas.some(
    (persona) => (reusedTargets[persona._id] ?? null) === null
  );
  const activeReusedTargets = reusedPersonas.flatMap(
    (persona) => reusedTargets[persona._id] ?? []
  );
  const newJourneyCount = proposed.reduce(
    (sum, persona) => sum + persona.journeys.length,
    0
  );
  const personaCount = proposed.length + reusedPersonas.length;
  const journeyCount = newJourneyCount + activeReusedTargets.length;
  // New journeys run `sessionsPerHost` sessions per environment; reused ones
  // carry their own config, so they are counted as journeys but not folded
  // into this estimate.
  const sessionEstimate =
    newJourneyCount * preset.sessionsPerHost * Math.max(1, environmentCount);
  const rubricValid = areAllChecksValid(rubric.map((entry) => entry.predicate));
  const canLaunch =
    journeyCount > 0 && rubricValid && !launching && !reusedPending;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8 sm:px-8">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
          Here&rsquo;s who we&rsquo;ll send in.
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {personaCount} {personaCount === 1 ? "persona" : "personas"} ·{" "}
          {journeyCount} {journeyCount === 1 ? "journey" : "journeys"}
          {/* A reuse-only swarm creates nothing new, so quoting "0 new
              sessions" would read as a problem rather than as the point. */}
          {sessionEstimate > 0
            ? ` · ${sessionEstimate} new ${
                sessionEstimate === 1 ? "session" : "sessions"
              }`
            : ""}
          . Remove anything that doesn&rsquo;t fit.
        </p>
      </div>

      {proposed.length > 0 ? (
        <ul className="space-y-2" data-testid="new-swarm-proposed-personas">
          {proposed.map((persona) => (
            <li
              key={persona.key}
              className="rounded-xl border border-border/60 bg-card/40 p-3"
            >
              <div className="flex items-start gap-3">
                <PersonaPixelAvatar
                  seed={persona.key}
                  shapeIndex={persona.avatarShape}
                  paletteIndex={persona.avatarPalette}
                  size="md"
                />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-foreground">
                    {persona.name}
                  </span>
                  <p className="truncate text-sm text-muted-foreground">
                    {persona.role}
                  </p>
                  <ul className="mt-2 space-y-1">
                    {persona.journeys.map((journey) => (
                      <li
                        key={journey.key}
                        className="group flex items-start gap-2"
                      >
                        <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                          {journeyLabel(journey)}
                        </span>
                        <button
                          type="button"
                          aria-label={`Remove journey ${journeyLabel(journey)}`}
                          className="shrink-0 text-sm text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                          onClick={() =>
                            removeJourney(persona.key, journey.key)
                          }
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove persona ${persona.name}`}
                  onClick={() => removePersona(persona.key)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {reusedPersonas.length > 0 ? (
        <ul className="space-y-2" data-testid="new-swarm-reused-personas">
          {reusedPersonas.map((persona) => (
            <ReusedPersonaCard
              key={persona._id}
              persona={persona}
              onJourneysChange={handleReusedJourneys}
              onRemove={() => onRemoveReused(persona._id)}
            />
          ))}
        </ul>
      ) : null}

      {/* Grading is authored ONCE for the swarm and stamped onto every journey
          this launch creates — sharing criterion ids across journeys is what
          lets Findings roll a criterion up across the whole swarm. Collapsed
          by default: an ungraded swarm is a valid swarm. */}
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
          Scoring rubric
          {rubric.length > 0 ? (
            <Badge variant="outline" className="ml-1 text-[10px]">
              {rubric.length}
            </Badge>
          ) : null}
        </button>
        {gradingOpen ? (
          <div className="mt-2">
            <JudgesSection
              chrome="bare"
              value={judgeConfig}
              onChange={setJudgeConfig}
              availableModels={availableModels}
              bareAutoGradeBlurb="Grade every session in this swarm automatically against its journey goal. Uses credits. You can also judge any session on demand from its detail view."
              bareAutoGradeAriaLabel="Auto-grade every session with LLM as Judge"
            />
            <div className="mt-3 border-t border-border/40 pt-3">
              <JourneyRubricEditor value={rubric} onChange={setRubric} />
            </div>
          </div>
        ) : null}
      </div>

      {errorMessage ? (
        <p role="alert" className="text-sm leading-relaxed text-destructive">
          {errorMessage}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          disabled={!canLaunch}
          data-testid="new-swarm-launch"
          onClick={() =>
            onLaunch({
              rubric,
              ...(judgeConfig ? { judgeConfig } : {}),
              reusedTargets: activeReusedTargets,
            })
          }
        >
          {launching ? (
            <>
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              Creating &amp; launching…
            </>
          ) : (
            "Create & launch"
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={launching}
          onClick={onBack}
        >
          Back
        </Button>
      </div>
    </div>
  );
}
