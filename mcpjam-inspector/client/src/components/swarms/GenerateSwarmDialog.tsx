/**
 * AI generation dialog for the Swarms surface.
 *
 * Two modes behind one compact form:
 *   - `persona`  — generate one persona AND its journeys in a single click.
 *   - `journeys` — generate journeys for the already-selected persona.
 *
 * Targets are Project Environments only. Generation is grounded in the FIRST
 * selected environment (`environmentId` — the backend resolves its server
 * group, or the host's own picks when it defines none). Created journey rows
 * carry `environmentIds` + compat `hostIds` and OMIT `serverAttachmentId` —
 * see `journey-environments.ts` for that invariant.
 *
 * Generation itself is a backend call; the rows are then created through the
 * ordinary `personas:createPersona` / `journeys:createJourney` mutations so
 * every existing validation applies and the results land as real, editable
 * rows. Running them stays a separate explicit click.
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Label } from "@mcpjam/design-system/label";
import { ServerPicker } from "@/components/hosts/server-picker";
import { useSwarmDefaultTarget } from "@/components/swarms/use-swarm-default-target";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { joinLabels } from "@/lib/cloud-server-readiness";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import {
  generateSwarmJourneys,
  generateSwarmPersona,
  SwarmGenerateError,
  type SwarmGeneratedJourney,
} from "@/lib/swarm-api";
import { track } from "@/lib/analytics";
import { toast } from "@/lib/toast";

const DEFAULT_JOURNEY_COUNT = 3;

/** Mirrors `personas:createPersona`'s avatar bounds — the mutation THROWS on
 * an out-of-range index rather than clamping, so generated values must be
 * in-range by construction. */
const PERSONA_AVATAR_SHAPE_COUNT = 6;
const PERSONA_AVATAR_PALETTE_COUNT = 6;

/** Matches `personas:createPersona`'s per-project cap. Pre-checked client-side
 * so a full project fails before spending a generation. */
export const MAX_PERSONAS_PER_PROJECT = 200;

const randomAvatarIndex = (count: number) => Math.floor(Math.random() * count);

const EMPTY_SLATE_MESSAGE =
  "Generation returned no goals. Try again, or make sure the environment's servers have been connected so their tools are inspected.";

export interface GenerateSwarmDialogProps {
  mode: "persona" | "journeys";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /**
   * Live project environments — pass `undefined` while the list is loading
   * and `[]` when there are none.
   */
  environments?: ProjectEnvironmentView[];
  /** Live persona count; gates the 200-per-project cap in `persona` mode. */
  personaCount?: number;
  /** Project clients, for the default target. */
  hosts: ReadonlyArray<{ hostId: string }>;
  /** Required in `journeys` mode: the persona the journeys are generated for. */
  persona?: { _id: string; name: string; role: string; notes?: string };
  /** Creates the persona row; resolves to the new persona's id. */
  onCreatePersona: (draft: {
    name: string;
    role: string;
    notes?: string;
    avatarShape: number;
    avatarPalette: number;
  }) => Promise<string>;
  /**
   * Creates one journey row against the given persona. Env-shaped:
   * `environmentIds` + compat `hostIds`, no `serverAttachmentId`.
   */
  onCreateJourney: (
    personaRefId: string,
    draft: {
      name?: string;
      goal: string;
      hostIds: string[];
      environmentIds: string[];
      config: { sessionsPerTarget: number; maxTurns: number };
    },
  ) => Promise<void>;
  /** Selects the freshly created persona in the sidebar. */
  onPersonaCreated?: (personaRefId: string) => void;
}

export function GenerateSwarmDialog({
  mode,
  open,
  onOpenChange,
  projectId,
  environments,
  personaCount,
  hosts,
  persona,
  onCreatePersona,
  onCreateJourney,
  onPersonaCreated,
}: GenerateSwarmDialogProps) {
  const journeyCount = DEFAULT_JOURNEY_COUNT;
  const target = useSwarmDefaultTarget({
    projectId,
    active: open,
    environments,
    hosts,
  });
  const { state: targetState, setState: setTargetState, noServers } = target;
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Latched once the persona row is written. Re-running generation after that
  // point would spend quota AND create a SECOND persona rather than retrying
  // the journeys, so the submit button stays locked for the rest of this
  // dialog session; the retry path is "Generate journeys" on the new persona.
  const [personaCommitted, setPersonaCommitted] = useState(false);
  // Synchronous latch so a double-click can't dispatch two BILLED generations
  // before React commits `pending` and renders the button disabled. Same
  // pattern as `rebuildInFlightRef` in ScenarioUsagePanel; the state above is
  // still what drives rendering.
  const generateInFlightRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setPending(false);
      setErrorMessage(null);
      setPersonaCommitted(false);
      generateInFlightRef.current = false;
    }
  }, [open]);

  // The cap precheck below is only meaningful once the persona count has
  // loaded. Treating `undefined` as "under the cap" would let a full project
  // spend generation quota before `createPersona` rejects the row, so persona
  // mode stays disabled until the count is known.
  const personaCountKnown =
    mode !== "persona" || typeof personaCount === "number";
  const targetsValid = target.ready;
  const canSubmit =
    !pending && !personaCommitted && personaCountKnown && targetsValid;

  const createJourneyRows = async (
    personaRefId: string,
    journeys: SwarmGeneratedJourney[],
    /** Snapshotted at submit — see `handleGenerate`. Never the live state. */
    target: {
      hostIds: string[];
      environmentIds: string[];
    },
  ): Promise<{ created: number; firstError: Error | null }> => {
    let created = 0;
    let firstError: Error | null = null;
    for (const journey of journeys) {
      try {
        await onCreateJourney(personaRefId, {
          ...(journey.name ? { name: journey.name } : {}),
          goal: journey.goal,
          ...target,
          config: { sessionsPerTarget: 1, maxTurns: 6 },
        });
        created += 1;
      } catch (error) {
        // Partial failure keeps the rows that landed — the persona and any
        // created journeys stay editable rather than being rolled back. The
        // first error is kept so a run where NOTHING landed can report why
        // instead of closing on a "0 of N" success toast.
        if (!firstError) {
          firstError =
            error instanceof Error ? error : new Error(String(error));
        }
      }
    }
    return { created, firstError };
  };

  const handleGenerate = async () => {
    if (!targetsValid) return;
    // Every rejection that returns WITHOUT entering the try/finally below must
    // come before the latch is taken — otherwise the latch is never released
    // and the button is silently dead until the dialog is reopened.
    if (
      mode === "persona" &&
      typeof personaCount === "number" &&
      personaCount >= MAX_PERSONAS_PER_PROJECT
    ) {
      setErrorMessage(
        `This project already has ${MAX_PERSONAS_PER_PROJECT} personas. Delete one before generating another.`,
      );
      return;
    }
    // Latch BEFORE any await — `pending` and `personaCommitted` only take
    // effect on the next render, which is too late for a rapid second click.
    // Released in the `finally` that every path below flows through.
    if (generateInFlightRef.current || personaCommitted) return;
    generateInFlightRef.current = true;
    setPending(true);
    setErrorMessage(null);
    try {
      // Before generating, so a failure here costs no generation.
      const environmentIds = await target.resolve();
      const groundingEnvironmentId = environmentIds[0]!;
      // Snapshot targets at submit. Generation is a slow round-trip and the
      // pickers stay mounted, so reading live state after the await would let a
      // mid-flight change retarget the created rows — or clear the selection and
      // fail every mutation — after the quota was already spent.
      const journeyTarget = {
        hostIds: [] as string[],
        environmentIds: [...environmentIds],
      };

      if (mode === "persona") {
        track("swarm_generate_persona_started", {
          location: "swarms",
          journeyCount,
          hostCount: journeyTarget.hostIds.length,
          targetMode: "environments",
          environmentCount: journeyTarget.environmentIds.length,
        });
        const result = await generateSwarmPersona({
          projectId,
          environmentId: groundingEnvironmentId,
          journeyCount,
        });
        if (result.journeys.length === 0) {
          // Checked before onCreatePersona so a failed generation can't strand
          // a journey-less persona. "Generate persona" always ships journeys.
          throw new Error(EMPTY_SLATE_MESSAGE);
        }
        const personaRefId = await onCreatePersona({
          name: result.persona.name,
          role: result.persona.role,
          ...(result.persona.notes ? { notes: result.persona.notes } : {}),
          avatarShape: randomAvatarIndex(PERSONA_AVATAR_SHAPE_COUNT),
          avatarPalette: randomAvatarIndex(PERSONA_AVATAR_PALETTE_COUNT),
        });
        // The row exists now — no second generation from this dialog.
        setPersonaCommitted(true);
        const { created, firstError } = await createJourneyRows(
          personaRefId,
          result.journeys,
          journeyTarget,
        );
        // The persona landed either way — select it so the new row is visible
        // even when every journey write failed.
        onPersonaCreated?.(personaRefId);
        track("swarm_generate_persona_completed", {
          location: "swarms",
          journeysRequested: result.journeys.length,
          journeysCreated: created,
        });
        // Nothing to celebrate if no journey survived: keep the dialog open
        // and show why, rather than closing on a "0 of N" success toast.
        if (created === 0 && result.journeys.length > 0) {
          setErrorMessage(
            `Created the persona, but no goals could be saved. ${
              firstError?.message ?? "The goal writes were rejected."
            } Close this dialog and use Generate goals on the new persona to retry.`,
          );
          return;
        }
        toast.success(
          created === result.journeys.length
            ? `Created persona + ${created} ${created === 1 ? "goal" : "goals"}`
            : `Created persona + ${created} of ${result.journeys.length} goals`,
        );
        onOpenChange(false);
        return;
      }

      if (!persona) return;
      track("swarm_generate_journeys_started", {
        location: "swarms",
        journeyCount,
        hostCount: journeyTarget.hostIds.length,
        targetMode: "environments",
        environmentCount: journeyTarget.environmentIds.length,
      });
      const result = await generateSwarmJourneys({
        projectId,
        environmentId: groundingEnvironmentId,
        journeyCount,
        persona: {
          name: persona.name,
          role: persona.role,
          ...(persona.notes ? { notes: persona.notes } : {}),
        },
      });
      if (result.journeys.length === 0) {
        throw new Error(EMPTY_SLATE_MESSAGE);
      }
      const { created, firstError } = await createJourneyRows(
        persona._id,
        result.journeys,
        journeyTarget,
      );
      // Every write failed (archived environment, rejected goals, …): surface
      // the mutation error instead of closing on a "0 of N" success toast —
      // the generation quota was already spent, so the user needs the reason.
      if (created === 0 && result.journeys.length > 0) {
        throw (
          firstError ?? new Error("No goals could be saved for this persona.")
        );
      }
      track("swarm_generate_journeys_completed", {
        location: "swarms",
        journeysRequested: result.journeys.length,
        journeysCreated: created,
      });
      toast.success(
        created === result.journeys.length
          ? `Created ${created} ${created === 1 ? "goal" : "goals"}`
          : `Created ${created} of ${result.journeys.length} goals`,
      );
      onOpenChange(false);
    } catch (error) {
      // 429 (quota/wallet) and other 4xx carry backend copy worth showing
      // inline rather than as a transient toast.
      setErrorMessage(
        error instanceof SwarmGenerateError || error instanceof Error
          ? error.message
          : "Generation failed",
      );
    } finally {
      generateInFlightRef.current = false;
      setPending(false);
    }
  };

  const title = mode === "persona" ? "Generate persona" : "Generate goals";
  const description =
    mode === "persona"
      ? "Generates a user persona and its goals, grounded in your server's tools. Confirm the server you'd like to use first."
      : "Generates goals for your user persona, grounded in your server's tools. Confirm the server you'd like to use first.";

  return (
    <Dialog
      open={open}
      // Generation is in flight and NOT abortable: the backend call is already
      // billed and the row mutations follow it. Unmounting here would leave
      // that work running headless and let a retry double-spend, so Escape,
      // outside-click, and the close button are ignored while pending (the
      // Cancel button is disabled for the same reason).
      onOpenChange={(next) => {
        if (pending && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-1">
          <div className="flex flex-col gap-1.5">
            <Label>Servers</Label>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <ServerPicker
                projectId={projectId}
                value={targetState.stack.serverAttachmentId}
                onChange={(serverAttachmentId) =>
                  setTargetState((prev) => ({
                    ...prev,
                    stack: { ...prev.stack, serverAttachmentId },
                    customized: true,
                  }))
                }
                // The dialog opens with a group already seeded and nothing
                // gates on it, so without a way back the client's own servers
                // — what the empty label promises — become unreachable.
                onClearSelection={() =>
                  setTargetState((prev) => ({
                    ...prev,
                    stack: { ...prev.stack, serverAttachmentId: null },
                    customized: true,
                  }))
                }
                emptyTriggerLabel="Server group · client default"
                triggerTestId="generate-server-group-picker"
                inModal
              />
            </div>
            {hosts.length === 0 ? (
              <p className="text-[11px] leading-snug text-muted-foreground">
                Connect a client before generating.
              </p>
            ) : null}
          </div>

          {noServers ? (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs leading-snug text-destructive"
            >
              {joinLabels(noServers.labels)} has no servers assigned. Turn on
              Auto-connect on the{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => {
                  onOpenChange(false);
                  navigateApp(routePaths.servers);
                }}
              >
                Servers tab
              </button>
              , or pick a server group above.
            </p>
          ) : null}

          {errorMessage ? (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs leading-snug text-destructive"
            >
              {errorMessage}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {personaCommitted ? "Close" : "Cancel"}
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() => void handleGenerate()}
          >
            {pending ? (
              <Loader2 className="mr-1 size-3 animate-spin" />
            ) : (
              <Sparkles className="mr-1 size-3" />
            )}
            {mode === "persona" ? "Generate persona" : "Generate goals"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
