import type { LaunchTarget, ProposedPersona } from "./new-swarm-confirm-step";
import type { SwarmRunningColumn } from "./new-swarm-running-step";
import { PersonaPixelAvatar } from "./persona-pixel-avatar";
import { cn } from "@/lib/utils";

export type SwarmLaunchRow = {
  key: string;
  personaId: string;
  personaName: string;
  avatarShape?: number;
  avatarPalette?: number;
  goal: string;
  status: "queued" | "starting" | "failed" | "not_started";
  error?: string;
  runId?: string;
};

export function swarmLaunchRows(
  proposed: ProposedPersona[],
  reused: LaunchTarget[],
  persisted: LaunchTarget[] | null,
): SwarmLaunchRow[] {
  const targets = (persisted ?? reused).map(
    (target): SwarmLaunchRow => ({
      key: target.launchProgressKey ?? target.journeyId,
      personaId: target.personaId,
      personaName: target.personaName,
      avatarShape: target.avatarShape,
      avatarPalette: target.avatarPalette,
      goal: target.goalLabel ?? target.label,
      status: "queued",
    }),
  );
  if (persisted) return targets;
  return targets.concat(
    proposed.flatMap((persona) =>
      persona.journeys
        .filter((journey) => journey.goal.trim())
        .map((journey) => ({
          key: `${persona.key}:${journey.key}`,
          personaId: persona.key,
          personaName: persona.name,
          avatarShape: persona.avatarShape,
          avatarPalette: persona.avatarPalette,
          goal: journey.name?.trim() || journey.goal.slice(0, 40),
          status: "queued" as const,
        })),
    ),
  );
}

/** Planned goals have no run id yet, so they must never mount live queries. */
export function SwarmPendingLaunchRows({
  rows,
  columns,
}: {
  rows: SwarmLaunchRow[];
  columns: SwarmRunningColumn[];
}) {
  const labels = {
    queued: "Queued",
    starting: "Starting",
    failed: "Could not start",
    not_started: "Not started",
  };
  return rows
    .filter((row) => !row.runId)
    .map((row) => (
      <tr
        key={row.key}
        data-testid="swarm-pending-launch-row"
        className="border-b border-border/30 last:border-0"
      >
        {columns.map((column) => (
          <td
            key={column.key}
            className="min-w-[7.5rem] px-2 py-2 align-middle"
          >
            <div
              data-outcome={row.status}
              aria-label={`${labels[row.status]} ${row.personaName} on ${column.label}`}
              className={cn(
                "flex items-center gap-1 rounded-lg border px-2.5 py-2",
                row.status === "failed"
                  ? "border-destructive/40 bg-destructive/10"
                  : "border-border/60 bg-muted/10",
              )}
            >
              <PersonaPixelAvatar
                seed={row.personaId}
                shapeIndex={row.avatarShape}
                paletteIndex={row.avatarPalette}
                size="sm"
                state={row.status === "starting" ? "running" : "idle"}
              />
              <div className="min-w-0 flex-1 text-xs leading-tight text-foreground">
                <p className="font-semibold">
                  {labels[row.status]}: {row.goal}
                </p>
                {row.error ? <p className="mt-1">{row.error}</p> : null}
              </div>
            </div>
          </td>
        ))}
      </tr>
    ));
}
