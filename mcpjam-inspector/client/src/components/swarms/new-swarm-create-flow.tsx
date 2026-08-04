/**
 * Full-page New swarm create flow: Describe → Confirm personas.
 *
 * Describe offers TWO independent doors into Confirm, side by side and live at
 * the same time:
 *
 *   - Reuse — personas the project already has. They bring their own journeys,
 *     environments and grading, so this path needs no description, no
 *     environment, and spends nothing.
 *   - Generate — a description of who actually shows up. The tool inventory is
 *     already known server-side (prompts are grounded in the environment's
 *     captured inspections), so the box asks only for the part we can't infer.
 *
 * They compose: using both generates a fresh slate AND carries the selected
 * personas. Keeping generation off the critical path matters — when it was the
 * only door, a returning user had to write a description and pay for a slate
 * they never wanted just to reach the launch screen.
 *
 * Nothing is written until Create & launch on the next step.
 */
import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@mcpjam/design-system/breadcrumb";
import { Label } from "@mcpjam/design-system/label";
import { Loader2 } from "lucide-react";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { McpjamAgentComposer } from "@/components/mcpjam-agent/McpjamAgentComposer";
import { EnvironmentPicker } from "@/components/project-environments/environment-picker";
import {
  buildEnvJourneyPayload,
  MAX_ENVIRONMENTS_PER_JOURNEY,
} from "@/components/swarms/journey-environments";
import { MAX_PERSONAS_PER_PROJECT } from "@/components/swarms/GenerateSwarmDialog";
import {
  PersonaPixelAvatar,
  mintPersonaAvatarLook,
} from "@/components/swarms/persona-pixel-avatar";
import {
  NewSwarmConfirmStep,
  type ConfirmLaunchPayload,
  type LaunchTarget,
  type ProposedPersona,
  type ReusedPersona,
} from "@/components/swarms/new-swarm-confirm-step";
import {
  DEFAULT_SWARM_INTENSITY,
  SWARM_INTENSITY_ORDER,
  SWARM_INTENSITY_PRESETS,
  estimateSwarmSessions,
  type SwarmPushIntensity,
} from "@/components/swarms/swarm-intensity";
import {
  SWARM_QUERIES,
  SwarmGenerateError,
  generateSwarmPersonaBatch,
} from "@/lib/swarm-api";
import { serializeRubricForWire } from "@/shared/journey-rubric";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import type { GoalJudgeConfig } from "@/components/shared/session-quality/judge-config";
import { track } from "@/lib/analytics";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const CREATE_STEPS = [
  "Describe",
  "Confirm personas",
  "Running",
  "Findings",
] as const;

// Prefixed with "e.g." on purpose: the un-prefixed sentence read as filled-in
// content, so users hit a disabled button with no idea the box was empty.
const DESCRIBE_PLACEHOLDER =
  "e.g. Finance ops reconciling payouts, and devs wiring up subscription billing.";

/** Concurrent launches. Bounded so a 60-journey launch doesn't open 60
 * simultaneous requests, while still finishing in seconds. */
const LAUNCH_CONCURRENCY = 4;

export type CreatePersonaDraft = {
  name: string;
  role: string;
  notes?: string;
  avatarShape: number;
  avatarPalette: number;
};

export type CreateJourneyDraft = {
  name?: string;
  goal: string;
  hostIds: string[];
  environmentIds: string[];
  config: { sessionsPerHost: number; maxTurns: number };
  judgeConfig?: GoalJudgeConfig;
  rubric?: ReturnType<typeof serializeRubricForWire>;
};

type FlowPersona = ReusedPersona;

/**
 * Tool-count hint for the grounding line, isolated so an older backend without
 * the query (or an unresolvable environment) can't break the form — the parent
 * wraps this in an ErrorBoundary and simply renders no hint.
 */
function EnvironmentGroundingHint({
  projectId,
  environmentId,
}: {
  projectId: string;
  environmentId: string;
}) {
  const inventory = useQuery(
    SWARM_QUERIES.getEnvironmentToolInventory as any,
    { projectId, environmentId } as any
  ) as
    | {
        environmentName: string;
        serverCount: number;
        toolCount: number;
        capturedAt: number | null;
      }
    | null
    | undefined;

  // Absent, unresolvable, or nothing captured: say nothing. A "0 tools" line
  // reads as a failure the user has to act on, when the real answer is that
  // generation will fall back to describing the surface by name.
  if (!inventory || inventory.toolCount === 0) return null;
  return (
    <p className="text-sm leading-relaxed text-muted-foreground">
      Grounded on {inventory.toolCount}{" "}
      {inventory.toolCount === 1 ? "tool" : "tools"} from{" "}
      {inventory.environmentName}.
    </p>
  );
}

/** Run `worker` over `items`, at most `limit` at a time. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index]);
      }
    }
  );
  await Promise.all(runners);
}

function errorMessageOf(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function NewSwarmCreateFlow({
  projectId,
  environments,
  personas,
  onCreatePersona,
  onCreateJourney,
  launchJourney,
  onCancel,
  onDone,
}: {
  projectId: string;
  environments: ProjectEnvironmentView[] | undefined;
  /** Existing project personas, for the reuse row. */
  personas: FlowPersona[] | undefined;
  onCreatePersona: (draft: CreatePersonaDraft) => Promise<string>;
  onCreateJourney: (
    personaRefId: string,
    draft: CreateJourneyDraft
  ) => Promise<string>;
  launchJourney: (
    journeyId: string
  ) => Promise<
    { status: "launched"; runId?: string } | { status: "already_launching" }
  >;
  onCancel: () => void;
  /** Hands back a label per launched run so the sessions view can name the
   * groups after the persona and journey instead of a run id. */
  onDone: (runLabels: Map<string, string>) => void;
}) {
  const [step, setStep] = useState<"describe" | "confirm">("describe");
  const [draft, setDraft] = useState("");
  const [environmentIds, setEnvironmentIds] = useState<string[]>([]);
  const [pushIntensity, setPushIntensity] = useState<SwarmPushIntensity>(
    DEFAULT_SWARM_INTENSITY
  );
  const [reusedIds, setReusedIds] = useState<string[]>([]);
  const [proposed, setProposed] = useState<ProposedPersona[]>([]);
  const [generating, setGenerating] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Sync latch: `generating`/`launching` are state, so two fast clicks in one
  // tick would both see the old value and fire twice.
  const inFlightRef = useRef(false);
  // Rows a previous attempt already created. A launch failure leaves the user
  // on Confirm with a Retry, and without this the retry would create every
  // persona and journey a SECOND time — the rows are already real, only the
  // launch needs redoing.
  const persistedTargetsRef = useRef<LaunchTarget[] | null>(null);

  const envList = useMemo(() => environments ?? [], [environments]);
  const personaList = useMemo(() => personas ?? [], [personas]);
  const preset = SWARM_INTENSITY_PRESETS[pushIntensity];
  const reusedPersonas = useMemo(
    () => personaList.filter((persona) => reusedIds.includes(persona._id)),
    [personaList, reusedIds]
  );

  // Generating and reusing are two independent doors into Confirm, and they
  // compose. Writing anything in the box asks for a generation (which needs an
  // environment to ground on); selecting personas alone is a complete swarm on
  // its own — those journeys carry their own environments, so requiring one
  // here would block a returning user over a field their run never reads.
  const wantsGenerate = draft.trim().length > 0;
  const canGenerate = wantsGenerate && environmentIds.length > 0 && !generating;
  const canContinue = generating
    ? false
    : wantsGenerate
    ? canGenerate
    : reusedIds.length > 0;
  /**
   * The action names what will actually happen, so a returning user can see
   * that continuing costs them nothing before they click.
   */
  const continueLabel = (() => {
    const reused = reusedIds.length;
    const fresh = preset.personaCount;
    if (wantsGenerate && reused > 0) {
      return `Continue with ${reused} existing + ${fresh} new`;
    }
    if (wantsGenerate) return "Generate personas";
    if (reused > 0) {
      return `Continue with ${reused} ${reused === 1 ? "persona" : "personas"}`;
    }
    return "Generate personas";
  })();

  /** Why the primary button is disabled, or null when it isn't. */
  const blockedReason =
    canContinue || generating
      ? null
      : wantsGenerate
      ? "Pick an environment to generate against."
      : personaList.length > 0
      ? "Describe your users, or pick a persona you already have."
      : "Describe your users to continue.";

  const handleGenerate = useCallback(async () => {
    if (!canGenerate || inFlightRef.current) return;
    const groundingEnvironmentId = environmentIds[0];
    if (!groundingEnvironmentId) return;
    inFlightRef.current = true;
    setGenerating(true);
    setErrorMessage(null);
    track("swarm_create_generate_started", {
      location: "swarms",
      intensity: pushIntensity,
      personaCount: preset.personaCount,
      reusedPersonas: reusedIds.length,
    });
    try {
      const result = await generateSwarmPersonaBatch({
        projectId,
        environmentId: groundingEnvironmentId,
        personaCount: preset.personaCount,
        journeyCount: preset.journeyCount,
        description: draft.trim(),
        // Dedup hints: the slate is told what the project already has so a
        // returning user doesn't get near-copies of their own personas.
        ...(reusedPersonas.length > 0
          ? {
              existingPersonas: reusedPersonas.map((persona) => ({
                name: persona.name,
                role: persona.role,
              })),
            }
          : {}),
      });
      if (result.personas.length === 0) {
        throw new Error(
          "Generation returned no personas. Try again, or make sure the environment's servers have been connected so their tools are inspected."
        );
      }
      // A fresh slate is a fresh set of rows to create — drop any memory of
      // what a previous attempt persisted.
      persistedTargetsRef.current = null;
      // Avatar looks are minted NOW, not at persist time, so the Confirm
      // preview shows the look the persona will actually be saved with.
      setProposed(
        result.personas.map((entry, personaIndex) => ({
          key: `persona-${personaIndex}-${entry.persona.name}`,
          name: entry.persona.name,
          role: entry.persona.role,
          ...(entry.persona.notes ? { notes: entry.persona.notes } : {}),
          ...mintPersonaAvatarLook(),
          journeys: entry.journeys.map((journey, journeyIndex) => ({
            key: `journey-${personaIndex}-${journeyIndex}`,
            ...(journey.name ? { name: journey.name } : {}),
            goal: journey.goal,
          })),
        }))
      );
      track("swarm_create_generate_completed", {
        location: "swarms",
        personasRequested: preset.personaCount,
        personasReturned: result.personas.length,
      });
      setStep("confirm");
    } catch (err) {
      setErrorMessage(
        err instanceof SwarmGenerateError
          ? err.message
          : errorMessageOf(err, "Failed to generate personas.")
      );
    } finally {
      inFlightRef.current = false;
      setGenerating(false);
    }
  }, [
    canGenerate,
    draft,
    environmentIds,
    preset,
    projectId,
    pushIntensity,
    reusedIds.length,
    reusedPersonas,
  ]);

  /**
   * The one primary action. Generation is NOT the only door into Confirm: a
   * reuse-only swarm skips it entirely, so a returning user reaches the launch
   * screen without writing a description or paying for a slate they didn't
   * ask for.
   */
  const handleContinue = useCallback(() => {
    if (!canContinue) return;
    if (wantsGenerate) {
      void handleGenerate();
      return;
    }
    persistedTargetsRef.current = null;
    setProposed([]);
    setErrorMessage(null);
    setStep("confirm");
  }, [canContinue, handleGenerate, wantsGenerate]);

  const handleLaunch = useCallback(
    async (payload: ConfirmLaunchPayload) => {
      if (inFlightRef.current) return;
      const envPayload = buildEnvJourneyPayload(environmentIds, envList);
      if (!envPayload && proposed.length > 0) {
        setErrorMessage(
          "The selected environments can't be resolved to hosts. Go back and pick an environment with a compatible host."
        );
        return;
      }
      // Pre-check the project cap BEFORE any write: a full project would
      // otherwise fail partway through, leaving some personas created.
      if (personaList.length + proposed.length > MAX_PERSONAS_PER_PROJECT) {
        setErrorMessage(
          `This project is at its limit of ${MAX_PERSONAS_PER_PROJECT} personas. Delete some before creating ${proposed.length} more.`
        );
        return;
      }

      inFlightRef.current = true;
      setLaunching(true);
      setErrorMessage(null);

      let firstError: string | null = null;
      let targets: LaunchTarget[] = [];
      let launched = 0;
      const runLabels = new Map<string, string>();

      // Every exit from here has to clear the latch. Without the finally, an
      // unexpected throw would leave the button spinning on "Creating &
      // launching…" with Cancel disabled — the user's only escape a reload.
      try {
        if (persistedTargetsRef.current) {
          targets = persistedTargetsRef.current;
        } else {
          const rubricWire =
            payload.rubric.length > 0
              ? serializeRubricForWire(payload.rubric)
              : undefined;
          // Reused journeys launch untouched — their own rubric, judge, and
          // environments are already what their owner chose.
          targets = [...payload.reusedTargets];

          for (const persona of proposed) {
            let personaRefId: string;
            try {
              personaRefId = await onCreatePersona({
                name: persona.name,
                role: persona.role,
                ...(persona.notes ? { notes: persona.notes } : {}),
                avatarShape: persona.avatarShape,
                avatarPalette: persona.avatarPalette,
              });
            } catch (err) {
              firstError ??= errorMessageOf(
                err,
                "A persona could not be created."
              );
              continue;
            }
            for (const journey of persona.journeys) {
              try {
                const journeyId = await onCreateJourney(personaRefId, {
                  ...(journey.name ? { name: journey.name } : {}),
                  goal: journey.goal,
                  hostIds: envPayload!.hostIds,
                  environmentIds: envPayload!.environmentIds,
                  config: {
                    sessionsPerHost: preset.sessionsPerHost,
                    maxTurns: preset.maxTurns,
                  },
                  ...(payload.judgeConfig
                    ? { judgeConfig: payload.judgeConfig }
                    : {}),
                  // Empty ⇒ omit, never `[]`: a stored empty rubric reads as
                  // "graded against nothing" rather than ungraded.
                  ...(rubricWire ? { rubric: rubricWire } : {}),
                });
                targets.push({
                  journeyId,
                  label: `${persona.name} · ${
                    journey.name?.trim() || journey.goal.slice(0, 40)
                  }`,
                });
              } catch (err) {
                firstError ??= errorMessageOf(
                  err,
                  "A journey could not be created."
                );
              }
            }
          }
          // Remember what landed so a retry only re-launches. Skipped when
          // nothing was created — there the rows genuinely don't exist yet and
          // retrying creation is the right behavior.
          if (targets.length > 0) persistedTargetsRef.current = targets;
        }

        await runWithConcurrency(
          targets,
          LAUNCH_CONCURRENCY,
          async (target) => {
            try {
              const result = await launchJourney(target.journeyId);
              if (result.status === "launched") {
                launched += 1;
                if (result.runId) runLabels.set(result.runId, target.label);
              }
            } catch (err) {
              firstError ??= errorMessageOf(
                err,
                "A run could not be launched."
              );
            }
          }
        );
      } catch (err) {
        firstError ??= errorMessageOf(err, "The swarm could not be launched.");
      } finally {
        inFlightRef.current = false;
        setLaunching(false);
      }

      track("swarm_create_launched", {
        location: "swarms",
        journeys: targets.length,
        runs: launched,
        intensity: pushIntensity,
      });

      if (launched === 0) {
        // Nothing is running, so leaving the flow would strand the user on an
        // empty view with no explanation. Rows that DID land are real, and the
        // copy has to say so — otherwise Retry looks like it will re-create
        // them.
        const created = persistedTargetsRef.current?.length ?? 0;
        setErrorMessage(
          `No runs were launched. ${
            firstError ?? "The launch requests were rejected."
          }` +
            (created > 0
              ? ` The ${
                  created === 1 ? "journey was" : `${created} journeys were`
                } created — retrying only launches ${
                  created === 1 ? "it" : "them"
                }.`
              : "")
        );
        return;
      }
      toast[launched === targets.length ? "success" : "warning"](
        launched === targets.length
          ? `Launched ${launched} ${launched === 1 ? "run" : "runs"}`
          : `Launched ${launched} of ${targets.length} runs`
      );
      onDone(runLabels);
    },
    [
      envList,
      environmentIds,
      launchJourney,
      onCreateJourney,
      onCreatePersona,
      onDone,
      personaList.length,
      preset,
      proposed,
      pushIntensity,
    ]
  );

  const activeStepIndex = step === "describe" ? 0 : 1;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="new-swarm-create-flow"
    >
      <div className="shrink-0 border-b border-border/60 bg-muted/15 px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-4">
          <Breadcrumb className="min-w-0 flex-1">
            <BreadcrumbList className="min-w-0 flex-nowrap">
              {CREATE_STEPS.map((label, index) => (
                <Fragment key={label}>
                  {index > 0 ? <BreadcrumbSeparator /> : null}
                  <BreadcrumbItem>
                    {index === activeStepIndex ? (
                      <BreadcrumbPage className="font-medium">
                        {label}
                      </BreadcrumbPage>
                    ) : (
                      <span className="text-muted-foreground/70">{label}</span>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            disabled={launching}
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-background">
        {step === "confirm" ? (
          <NewSwarmConfirmStep
            projectId={projectId}
            proposed={proposed}
            onProposedChange={setProposed}
            reusedPersonas={reusedPersonas}
            onRemoveReused={(personaId) =>
              setReusedIds((ids) => ids.filter((id) => id !== personaId))
            }
            preset={preset}
            environmentCount={environmentIds.length}
            launching={launching}
            errorMessage={errorMessage}
            onBack={() => setStep("describe")}
            onLaunch={(payload) => void handleLaunch(payload)}
          />
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8 sm:px-8">
            <div className="space-y-2">
              <h2 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
                Who uses this server, and what do they try to do?
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Bring in personas you already have, describe new ones, or both.
                We infer the goals, the clients and a scoring rubric — you
                confirm all of it next.
              </p>
            </div>

            {/* Two doors into Confirm, side by side and simultaneously live.
                The left one only exists once the project HAS personas, so a
                first swarm is still a single box. */}
            <div
              className={cn(
                "grid gap-6",
                personaList.length > 0
                  ? "md:grid-cols-[minmax(0,18rem)_1fr]"
                  : ""
              )}
            >
              {personaList.length > 0 ? (
                <div className="space-y-2">
                  <Label>Personas you have</Label>
                  <div
                    className="flex min-w-0 flex-col gap-1"
                    role="group"
                    aria-label="Personas you have"
                    data-testid="new-swarm-existing-personas"
                  >
                    {personaList.map((persona) => {
                      const selected = reusedIds.includes(persona._id);
                      return (
                        <button
                          key={persona._id}
                          type="button"
                          role="checkbox"
                          aria-checked={selected}
                          aria-label={`Include ${persona.name}`}
                          onClick={() =>
                            setReusedIds((ids) =>
                              selected
                                ? ids.filter((id) => id !== persona._id)
                                : [...ids, persona._id]
                            )
                          }
                          className={cn(
                            "flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-sm transition-colors",
                            selected
                              ? "border-border bg-muted text-foreground"
                              : "border-transparent text-muted-foreground hover:bg-muted/50"
                          )}
                        >
                          <PersonaPixelAvatar
                            seed={persona._id}
                            shapeIndex={persona.avatarShape}
                            paletteIndex={persona.avatarPalette}
                            size="sm"
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {persona.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    They keep their own journeys and environments.
                  </p>
                </div>
              ) : null}

              <div className="min-w-0 space-y-4">
                {personaList.length > 0 ? (
                  <Label>Describe new ones</Label>
                ) : null}
                <McpjamAgentComposer
                  value={draft}
                  onChange={setDraft}
                  onSubmit={handleContinue}
                  placeholder={DESCRIBE_PLACEHOLDER}
                  minRows={3}
                  maxRows={8}
                />

                <div className="space-y-2">
                  <Label>Environments</Label>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <EnvironmentPicker
                      projectId={projectId}
                      value={environmentIds}
                      onChange={setEnvironmentIds}
                      multi
                      max={MAX_ENVIRONMENTS_PER_JOURNEY}
                      emptyLabel="No environments · pick one"
                      triggerTestId="new-swarm-environments-picker"
                      triggerAriaLabel="Attached environments"
                    />
                  </div>
                  {environments === undefined ? (
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      Loading environments…
                    </p>
                  ) : envList.length === 0 ? (
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      Create an environment on the Environments tab first.
                    </p>
                  ) : environmentIds[0] ? (
                    <ErrorBoundary fallback={null}>
                      <EnvironmentGroundingHint
                        projectId={projectId}
                        environmentId={environmentIds[0]}
                      />
                    </ErrorBoundary>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Label>How hard to push</Label>
                  <div
                    role="radiogroup"
                    aria-label="How hard to push"
                    data-testid="new-swarm-push-intensity"
                    className="grid grid-cols-1 gap-1 rounded-xl bg-muted/50 p-1 sm:grid-cols-3"
                  >
                    {SWARM_INTENSITY_ORDER.map((value) => {
                      const option = SWARM_INTENSITY_PRESETS[value];
                      const selected = pushIntensity === value;
                      const sessions = estimateSwarmSessions(
                        option,
                        environmentIds.length
                      );
                      return (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => setPushIntensity(value)}
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
                            {option.personaCount} personas · {sessions} sessions
                            · {option.eta}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {errorMessage ? (
              <p
                role="alert"
                className="text-sm leading-relaxed text-destructive"
              >
                {errorMessage}
              </p>
            ) : null}

            {/* One action spanning both columns — the split is about where you
                supply input, not about choosing a path. */}
            <div className="flex flex-wrap items-center gap-3 border-t border-border/40 pt-4">
              <Button
                type="button"
                disabled={!canContinue}
                data-testid="new-swarm-continue"
                onClick={handleContinue}
              >
                {generating ? (
                  <>
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    Generating…
                  </>
                ) : (
                  continueLabel
                )}
              </Button>
              {blockedReason ? (
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {blockedReason}
                </p>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
