/**
 * "Where this runs", defaulted rather than asked for.
 *
 * Generate and the new-goal form both need a target chosen when the surface
 * opens and real environment ids at submit. The loading guards below are the
 * reason this is shared: each has been a bug, and one copy is enough.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvexAuth } from "convex/react";
import {
  composerHasTarget,
  defaultComposerState,
  emptyComposerState,
  type EnvironmentComposerState,
} from "@/components/environment-composer/environment-stack";
import { useCloudServerReadiness } from "@/components/environment-composer/use-cloud-server-readiness";
import { useComposerResolver } from "@/components/environment-composer/use-composer-resolver";
import { preferredAttachmentId } from "@/components/swarms/generate-target-recency";
import { MAX_ENVIRONMENTS_PER_JOURNEY } from "@/components/swarms/journey-environments";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import {
  useProjectEnvironments,
  type ProjectEnvironmentView,
} from "@/hooks/useProjectEnvironments";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import {
  useProjectServerAttachments,
  useProjectServers,
} from "@/hooks/useViews";
import { serversAreRunnable } from "@/lib/cloud-server-readiness";
import { useOptionalSharedAppState } from "@/state/app-state-context";

export type SwarmDefaultTarget = {
  state: EnvironmentComposerState;
  setState: React.Dispatch<React.SetStateAction<EnvironmentComposerState>>;
  /** Names somewhere to run, and that somewhere has servers. */
  ready: boolean;
  /** The clients resolving to zero servers, when that is what blocks `ready`. */
  noServers: { labels: string[] } | null;
  /** Mints or reuses the environments this target resolves to. */
  resolve: () => Promise<string[]>;
  /** Live environment ids, or undefined when the query does not run. */
  liveEnvironmentIds: ReadonlySet<string> | undefined;
};

export function useSwarmDefaultTarget({
  projectId,
  active,
  environments,
  hosts,
}: {
  projectId: string;
  /** The surface is open. Callers mount this only while it is. */
  active: boolean;
  /** `undefined` while loading. */
  environments: ProjectEnvironmentView[] | undefined;
  hosts: ReadonlyArray<{ hostId: string }>;
}): SwarmDefaultTarget {
  const [state, setState] =
    useState<EnvironmentComposerState>(emptyComposerState);
  const envList = useMemo(() => environments ?? [], [environments]);
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const { serverAttachments, isLoading: attachmentsLoading } =
    useProjectServerAttachments({ isAuthenticated, projectId });
  const environmentsEnabled = useProjectEnvironmentsEnabled();
  // Null outside an AppStateProvider — then there is no connection history.
  const appState = useOptionalSharedAppState();
  const resolveTargets = useComposerResolver(projectId);
  // Ad-hoc rows carry `lastUsedAt`, and the caller's list is named-only.
  const usageRows = useProjectEnvironments(projectId, { includeAdhoc: true });
  const usageQueryEnabled =
    isAuthenticated && isUserReady && shouldQueryProjectId(projectId);
  // The same rows double as the live set: this query excludes archived ones.
  const liveEnvironmentIds = useMemo(
    () =>
      usageRows
        ? new Set(usageRows.map((row) => row.environmentId))
        : undefined,
    [usageRows],
  );
  const { servers: catalog } = useProjectServers({
    isAuthenticated,
    projectId,
  });
  // Never default to a group the run would refuse. A group we cannot measure
  // stays in the running — the readiness check is the backstop, not this.
  const offerable = useMemo(() => {
    const byId = new Map((catalog ?? []).map((server) => [server._id, server]));
    return serverAttachments.filter((group) => {
      const members = group.serverIds
        .map((id) => byId.get(id))
        .filter((server): server is NonNullable<typeof server> =>
          Boolean(server),
        );
      if (members.length !== group.serverIds.length) return true;
      return serversAreRunnable(members);
    });
  }, [catalog, serverAttachments]);
  /** One-shot per opening; a later render must not overwrite an edit. */
  const seededRef = useRef(false);

  useEffect(() => {
    if (!active || seededRef.current) return;
    if (environmentsEnabled && environments === undefined) return;
    // The attachments query reports an empty list while it loads; seeding off
    // that would latch the default to "no server group".
    if (attachmentsLoading) return;
    // `lastUsedAt` rides on these rows, and the seed latches — choosing before
    // they land freezes the fallback the usage signal exists to replace. Only
    // when the query actually runs: a skipped one reports `undefined` forever,
    // and waiting on that would never seed at all.
    if (usageQueryEnabled && usageRows === undefined) return;
    if (isAuthenticated && shouldQueryProjectId(projectId) && !isUserReady) {
      return;
    }
    const next = defaultComposerState({
      environments: environmentsEnabled ? envList : [],
      hosts,
      serverAttachments: offerable,
      environmentsEnabled,
    });
    // Latch only once something was seeded; `hosts` can still be empty here.
    if (!next) return;
    seededRef.current = true;
    // Only on the composed branch: a saved environment carries its own server
    // group, and overriding it would silently retarget the environment.
    if (next.environmentIds.length === 0) {
      const preferred = preferredAttachmentId({
        attachments: offerable,
        environments: usageRows ?? [],
        servers: appState?.servers,
      });
      if (preferred) next.stack.serverAttachmentId = preferred;
    }
    setState(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active,
    appState?.servers,
    attachmentsLoading,
    environments,
    environmentsEnabled,
    hosts,
    isAuthenticated,
    isUserReady,
    offerable,
    projectId,
    usageQueryEnabled,
    usageRows,
  ]);

  // The resolver rejects a target with no servers (`ENV_NO_SERVERS`), and the
  // same queries can answer that here, before the round-trip.
  const readiness = useCloudServerReadiness({
    projectId,
    state,
    environments: envList,
  });
  const noServers = readiness.status === "no_servers" ? readiness : null;

  const resolve = useCallback(async () => {
    const resolved = await resolveTargets({
      state,
      liveEnvironments: envList,
      max: MAX_ENVIRONMENTS_PER_JOURNEY,
    });
    if (resolved.environmentIds.length === 0) {
      throw new Error("Could not resolve where this should run.");
    }
    return resolved.environmentIds;
  }, [envList, resolveTargets, state]);

  return {
    state,
    setState,
    ready: composerHasTarget(state) && !noServers,
    noServers,
    resolve,
    liveEnvironmentIds,
  };
}
