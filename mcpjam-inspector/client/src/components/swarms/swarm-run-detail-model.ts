/**
 * Pure helpers for `/swarms/:swarmId` — which tab a live wave should open
 * on, and the launched-run rows the shared watch surface needs.
 *
 * The create wizard's Running step is the same matrix + stream. Once that
 * step is left (or the run is opened from the list) this page is the only
 * URL that can show it, so the mapping has to be deterministic from the
 * overview wave the detail page already holds.
 */
import type { SwarmDetailTab } from "@/lib/app-navigation";
import type { SwarmOverviewRun } from "@/lib/swarm-api";
import type {
  SwarmLaunchedRun,
  SwarmRunningColumn,
} from "@/components/swarms/new-swarm-running-step";

export interface SwarmDetailPersona {
  _id: string;
  name: string;
  role?: string;
  avatarShape?: number;
  avatarPalette?: number;
}

/**
 * The detail tab strip, in display order.
 *
 * Findings leads because it is what a reader wants from a settled wave. Run
 * trails: it is the watch surface, and a live wave reaches it through
 * {@link resolveSwarmRunDetailTab} rather than by being clicked, so leading
 * with it put an in-flight view first on a page that is usually read after
 * the fact.
 */
export const DETAIL_TAB_OPTIONS = [
  { value: "findings" as const, label: "Findings" },
  { value: "insights" as const, label: "Insights" },
  { value: "sessions" as const, label: "Sessions" },
  { value: "run" as const, label: "Run" },
] as const;

/**
 * Default landing: a live wave with no explicit tab opens the watch
 * surface (`run`). A finished wave, or an explicit `?tab=`, keeps the
 * parsed tab — including `?tab=run` on a settled wave, so the matrix
 * stays reachable after the strip flips to Complete.
 */
export function resolveSwarmRunDetailTab(args: {
  parsed: SwarmDetailTab;
  tabParam: string | null;
  sessionParam: string | null;
  live: boolean;
}): SwarmDetailTab {
  if (args.live && !args.tabParam && !args.sessionParam) return "run";
  return args.parsed;
}

/** Overview runs → the watch surface's per-goal rows. */
export function launchedRunsFromWave(
  runs: readonly SwarmOverviewRun[],
  personas: readonly SwarmDetailPersona[],
): SwarmLaunchedRun[] {
  const personaByName = new Map(personas.map((persona) => [persona.name, persona]));
  return runs.map((run) => {
    const persona = personaByName.get(run.personaName);
    return {
      runId: run.runId,
      journeyId: run.journeyRefId,
      personaId: persona?._id ?? run.personaName,
      personaName: run.personaName,
      personaRole: persona?.role ?? "",
      avatarShape: persona?.avatarShape,
      avatarPalette: persona?.avatarPalette,
      label: `${run.personaName} · ${run.journeyName}`,
      goalLabel: run.journeyName,
    };
  });
}

/**
 * Placeholder columns until `RunLiveBridge` snapshots land. Keys prefer a
 * matching host id so a late snapshot can replace them without a flicker
 * to a different identity; the label prefers the environment nickname.
 */
export function fallbackColumnsFromWave(
  runs: readonly SwarmOverviewRun[],
  hosts: readonly { hostId: string; name: string }[],
): SwarmRunningColumn[] {
  const hostByName = new Map(hosts.map((host) => [host.name, host]));
  const seen = new Map<string, SwarmRunningColumn>();
  for (const run of runs) {
    for (const target of run.targets ?? []) {
      const host = hostByName.get(target.hostName);
      const key = host?.hostId ?? target.hostName;
      if (seen.has(key)) continue;
      const envName = target.environmentName?.trim();
      seen.set(key, {
        key,
        hostId: host?.hostId,
        label: envName || target.hostName,
      });
    }
  }
  return [...seen.values()];
}
