import type { ReactNode } from "react";
import type { SwarmOverviewTarget } from "@/lib/swarm-api";
import {
  formatWaveModelLabel,
  WaveClientLogoStrip,
  waveClientNames,
  type SwarmWave,
} from "./swarm-overview-panel";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const shortDateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const englishShortDate =
  /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12]\d|3[01])$/;

export function describeSwarmIdentity(wave: SwarmWave) {
  // A reused journey can carry its original swarm name on a legacy row.
  // Use the wave anchor so a sibling's older name never labels this wave.
  const authored = wave.anchor.swarmName?.trim() || undefined;
  const savedDate = authored?.match(/^Swarm · (.+)$/)?.[1];
  const defaultDate =
    savedDate &&
    (savedDate === shortDateFormat.format(wave.createdAt) || englishShortDate.test(savedDate))
      ? savedDate
      : undefined;
  const name = defaultDate || authored?.toLowerCase() === "swarm" ? undefined : authored;
  const date = defaultDate ?? dateFormat.format(wave.createdAt);
  const servers = [...new Set(wave.runs.flatMap((run) => run.serverNames ?? []))];
  return {
    name,
    servers,
    heading: servers.join(", ") || name || "Swarm",
    title: servers.length > 0 ? name : undefined,
    date: name?.includes(date) ? undefined : date,
    formattedDate: date,
  };
}

function Metadata({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <dt className="shrink-0">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-foreground">{children}</dd>
    </div>
  );
}

export function SwarmRunMetadata({
  name,
  targets,
  environments,
  hostStyleByName,
  sessions,
}: {
  name?: string;
  targets: readonly SwarmOverviewTarget[];
  environments: readonly string[];
  hostStyleByName: ReadonlyMap<string, string | null | undefined>;
  sessions?: { succeeded: number; total: number };
}) {
  return (
    <dl className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
      {name && <Metadata label="Name">{name}</Metadata>}
      {sessions && (
        <Metadata label="Sessions">
          <span className="tabular-nums">
            {sessions.succeeded}/{sessions.total} complete
          </span>
        </Metadata>
      )}
      {waveClientNames(targets).length > 0 && (
        <Metadata label="Clients">
          <WaveClientLogoStrip targets={targets} hostStyleByName={hostStyleByName} />
        </Metadata>
      )}
      {targets.length > 0 && (
        <Metadata label="Model">{formatWaveModelLabel(targets)}</Metadata>
      )}
      {environments.length > 0 && (
        <Metadata label="Environment">{environments.join(", ")}</Metadata>
      )}
    </dl>
  );
}
