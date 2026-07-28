/**
 * AI generation dialog for the Swarms surface.
 *
 * Two modes behind one compact form:
 *   - `persona`  — generate one persona AND its journeys in a single click.
 *   - `journeys` — generate journeys for the already-selected persona.
 *
 * The dialog picks the grounding + targets (server group → the tool inventory
 * the prompt is grounded in; clients + journey count → what the created rows
 * target). Generation itself is a backend call; the rows are then created
 * through the ordinary `personas:createPersona` / `journeys:createJourney`
 * mutations so every existing validation applies and the results land as real,
 * editable rows. Running them stays a separate explicit click.
 */
import { useEffect, useState } from "react";
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
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { ServerGroupPicker } from "@/components/hosts/ServerGroupPicker";
import {
  SwarmHostMultiSelect,
  type SwarmHostItem,
} from "@/components/swarms/swarm-host-multi-select";
import {
  generateSwarmJourneys,
  generateSwarmPersona,
  SwarmGenerateError,
  type SwarmGeneratedJourney,
} from "@/lib/swarm-api";
import { track } from "@/lib/analytics";
import { toast } from "@/lib/toast";

export const MIN_GENERATED_JOURNEYS = 1;
export const MAX_GENERATED_JOURNEYS = 5;
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

export interface GenerateSwarmDialogProps {
  mode: "persona" | "journeys";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  hosts: SwarmHostItem[];
  /** Live persona count; gates the 200-per-project cap in `persona` mode. */
  personaCount?: number;
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
  /** Creates one journey row against the given persona. */
  onCreateJourney: (
    personaRefId: string,
    draft: {
      name?: string;
      goal: string;
      hostIds: string[];
      serverAttachmentId: string;
      config: { sessionsPerHost: number; maxTurns: number };
    }
  ) => Promise<void>;
  /** Selects the freshly created persona in the sidebar. */
  onPersonaCreated?: (personaRefId: string) => void;
}

export function GenerateSwarmDialog({
  mode,
  open,
  onOpenChange,
  projectId,
  hosts,
  personaCount,
  persona,
  onCreatePersona,
  onCreateJourney,
  onPersonaCreated,
}: GenerateSwarmDialogProps) {
  const [serverAttachmentId, setServerAttachmentId] = useState<string | null>(
    null
  );
  const [hostIds, setHostIds] = useState<string[]>([]);
  const [journeyCount, setJourneyCount] = useState(DEFAULT_JOURNEY_COUNT);
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Latched once the persona row is written. Re-running generation after that
  // point would spend quota AND create a SECOND persona rather than retrying
  // the journeys, so the submit button stays locked for the rest of this
  // dialog session; the retry path is "Generate journeys" on the new persona.
  const [personaCommitted, setPersonaCommitted] = useState(false);

  useEffect(() => {
    if (!open) {
      setServerAttachmentId(null);
      setHostIds([]);
      setJourneyCount(DEFAULT_JOURNEY_COUNT);
      setPending(false);
      setErrorMessage(null);
      setPersonaCommitted(false);
    }
  }, [open]);

  const toggleHost = (id: string) =>
    setHostIds((prev) =>
      prev.includes(id) ? prev.filter((h) => h !== id) : [...prev, id]
    );

  const countValid =
    Number.isInteger(journeyCount) &&
    journeyCount >= MIN_GENERATED_JOURNEYS &&
    journeyCount <= MAX_GENERATED_JOURNEYS;
  // The cap precheck below is only meaningful once the persona count has
  // loaded. Treating `undefined` as "under the cap" would let a full project
  // spend generation quota before `createPersona` rejects the row, so persona
  // mode stays disabled until the count is known.
  const personaCountKnown =
    mode !== "persona" || typeof personaCount === "number";
  const canSubmit =
    !pending &&
    !personaCommitted &&
    personaCountKnown &&
    !!serverAttachmentId &&
    hostIds.length > 0 &&
    countValid;

  const createJourneyRows = async (
    personaRefId: string,
    journeys: SwarmGeneratedJourney[],
    attachmentId: string,
    /** Snapshotted at submit — see `handleGenerate`. Never the live state. */
    targetHostIds: string[]
  ): Promise<{ created: number; firstError: Error | null }> => {
    let created = 0;
    let firstError: Error | null = null;
    for (const journey of journeys) {
      try {
        await onCreateJourney(personaRefId, {
          ...(journey.name ? { name: journey.name } : {}),
          goal: journey.goal,
          hostIds: targetHostIds,
          serverAttachmentId: attachmentId,
          config: { sessionsPerHost: 1, maxTurns: 6 },
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
    if (!serverAttachmentId || hostIds.length === 0 || !countValid) return;
    if (
      mode === "persona" &&
      typeof personaCount === "number" &&
      personaCount >= MAX_PERSONAS_PER_PROJECT
    ) {
      setErrorMessage(
        `This project already has ${MAX_PERSONAS_PER_PROJECT} personas. Delete one before generating another.`
      );
      return;
    }
    setPending(true);
    setErrorMessage(null);
    // Snapshot BOTH targets at submit. Generation is a slow round-trip and the
    // pickers stay mounted, so reading live state after the await would let a
    // mid-flight change retarget the created rows — or clear the host list and
    // fail every mutation — after the quota was already spent.
    const attachmentId = serverAttachmentId;
    const targetHostIds = [...hostIds];

    try {
      if (mode === "persona") {
        track("swarm_generate_persona_started", {
          location: "swarms",
          journeyCount,
          hostCount: hostIds.length,
        });
        const result = await generateSwarmPersona({
          projectId,
          serverAttachmentId: attachmentId,
          journeyCount,
        });
        if (result.journeys.length === 0) {
          // Checked before onCreatePersona so a failed generation can't strand
          // a journey-less persona. "Generate persona" always ships journeys.
          throw new Error(
            "Generation returned no journeys. Try again, or pick a server group whose servers have been connected."
          );
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
          attachmentId,
          targetHostIds
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
            `Created the persona, but no journeys could be saved. ${
              firstError?.message ?? "The journey writes were rejected."
            } Close this dialog and use Generate journeys on the new persona to retry.`
          );
          return;
        }
        toast.success(
          created === result.journeys.length
            ? `Created persona + ${created} ${
                created === 1 ? "journey" : "journeys"
              }`
            : `Created persona + ${created} of ${result.journeys.length} journeys`
        );
        onOpenChange(false);
        return;
      }

      if (!persona) return;
      track("swarm_generate_journeys_started", {
        location: "swarms",
        journeyCount,
        hostCount: hostIds.length,
      });
      const result = await generateSwarmJourneys({
        projectId,
        serverAttachmentId: attachmentId,
        journeyCount,
        persona: {
          name: persona.name,
          role: persona.role,
          ...(persona.notes ? { notes: persona.notes } : {}),
        },
      });
      if (result.journeys.length === 0) {
        throw new Error(
          "Generation returned no journeys. Try again, or pick a server group whose servers have been connected."
        );
      }
      const { created, firstError } = await createJourneyRows(
        persona._id,
        result.journeys,
        attachmentId,
        targetHostIds
      );
      // Every write failed (deleted server group, rejected goals, …): surface
      // the mutation error instead of closing on a "0 of N" success toast —
      // the generation quota was already spent, so the user needs the reason.
      if (created === 0 && result.journeys.length > 0) {
        throw (
          firstError ??
          new Error("No journeys could be saved for this persona.")
        );
      }
      track("swarm_generate_journeys_completed", {
        location: "swarms",
        journeysRequested: result.journeys.length,
        journeysCreated: created,
      });
      toast.success(
        created === result.journeys.length
          ? `Created ${created} ${created === 1 ? "journey" : "journeys"}`
          : `Created ${created} of ${result.journeys.length} journeys`
      );
      onOpenChange(false);
    } catch (error) {
      // 429 (quota/wallet) and other 4xx carry backend copy worth showing
      // inline rather than as a transient toast.
      setErrorMessage(
        error instanceof SwarmGenerateError || error instanceof Error
          ? error.message
          : "Generation failed"
      );
    } finally {
      setPending(false);
    }
  };

  const title = mode === "persona" ? "Generate persona" : "Generate journeys";
  const description =
    mode === "persona"
      ? "Generates one persona and its journeys, grounded in a server group's tools. Everything lands as editable rows — nothing runs until you say so."
      : `Generates journeys for ${
          persona?.name ?? "this persona"
        }, grounded in a server group's tools. Nothing runs until you say so.`;

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
            <Label>Server group</Label>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <ServerGroupPicker
                projectId={projectId}
                value={serverAttachmentId}
                onChange={(id) => setServerAttachmentId(id)}
                onClearSelection={() => setServerAttachmentId(null)}
                emptyTriggerLabel="No server group · pick one"
                infoText="The tools in this group ground what gets generated, and every created journey runs against it."
                inModal
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Clients</Label>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <SwarmHostMultiSelect
                hosts={hosts}
                hostIds={hostIds}
                onToggle={toggleHost}
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Label
              htmlFor="swarm-generate-count"
              className="shrink-0 text-[11px] text-muted-foreground"
            >
              Journeys
            </Label>
            <Input
              id="swarm-generate-count"
              type="number"
              min={MIN_GENERATED_JOURNEYS}
              max={MAX_GENERATED_JOURNEYS}
              className="h-8 w-16"
              value={journeyCount}
              onChange={(e) => setJourneyCount(Number(e.target.value))}
            />
          </div>

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
            {mode === "persona" ? "Generate persona" : "Generate journeys"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
