/**
 * Composer state → {@link CloudServerReadiness}, for surfaces that only run in
 * MCPJam's cloud.
 *
 * The mapping mirrors the backend resolver's server selection, and the two
 * halves of that rule are the reason this is not a one-liner: an environment (or
 * a composition) that names a server GROUP resolves to that group's servers,
 * while one that doesn't resolves to the CLIENT's own set. The group's members
 * come back as ids; a client's set is summarized by `hosts:listHosts` as a
 * count. {@link assessCloudServerReadiness} accepts both shapes and skips
 * whatever it cannot measure.
 *
 * Reads only queries the composer already subscribes to (clients, catalog,
 * groups), so this adds no round-trip to the surfaces that mount it.
 */
import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import {
  isComposeMode,
  type EnvironmentComposerState,
} from "@/components/environment-composer/environment-stack";
import { useHostList } from "@/hooks/useClients";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import {
  useProjectServerAttachments,
  useProjectServers,
} from "@/hooks/useViews";
import {
  assessCloudServerReadiness,
  type CloudLaunchTarget,
  type CloudServerReadiness,
} from "@/lib/cloud-server-readiness";
import { environmentLabel } from "@/lib/environment-label";

export function useCloudServerReadiness({
  projectId,
  state,
  environments,
}: {
  projectId: string;
  state: EnvironmentComposerState;
  /** The project's environments — the rows behind `state.environmentIds`. */
  environments: readonly ProjectEnvironmentView[];
}): CloudServerReadiness {
  const { isAuthenticated } = useConvexAuth();
  // A LOOKUP, not a picker: `hostById` below resolves the client of an
  // environment that already exists, so a filtered-out private scenario
  // backing would read as UNKNOWN readiness rather than as "not offered".
  const { hosts } = useHostList({
    isAuthenticated,
    projectId,
    includePrivateBacking: true,
  });
  const { servers } = useProjectServers({ isAuthenticated, projectId });
  const { serverAttachments } = useProjectServerAttachments({
    isAuthenticated,
    projectId,
  });

  return useMemo(() => {
    const hostById = new Map(hosts.map((host) => [host.hostId, host]));
    const groupById = new Map(
      serverAttachments.map((group) => [group._id, group])
    );
    // Passed through undefined on purpose: an unanswered query is not an
    // empty project, and the two lead to opposite advice.
    const catalog = servers;

    /** A client's own set, as a target. Absent count stays UNKNOWN. */
    const hostTarget = (
      hostId: string,
      label?: string
    ): CloudLaunchTarget | null => {
      const host = hostById.get(hostId);
      if (!host) return null;
      return {
        label: label ?? host.name,
        serverIds: null,
        serverCount:
          typeof host.serverCount === "number" ? host.serverCount : null,
      };
    };

    /** A named group's set, as a target. An unknown group id is unmeasurable. */
    const groupTarget = (
      label: string,
      serverAttachmentId: string
    ): CloudLaunchTarget | null => {
      const group = groupById.get(serverAttachmentId);
      if (!group) return null;
      return {
        label,
        serverIds: group.serverIds,
        serverCount: group.serverIds.length,
      };
    };

    const targets: CloudLaunchTarget[] = [];
    if (isComposeMode(state)) {
      // One composition, fanned out over clients. A shared group replaces every
      // client's own set, so it is ONE target rather than one per client.
      const { serverAttachmentId } = state.stack;
      if (serverAttachmentId) {
        const group = groupById.get(serverAttachmentId);
        const target = group
          ? groupTarget(group.name, serverAttachmentId)
          : null;
        if (target) targets.push(target);
      } else {
        for (const hostId of state.stack.hostIds) {
          const target = hostTarget(hostId);
          if (target) targets.push(target);
        }
      }
    } else {
      const envById = new Map(
        environments.map((environment) => [
          environment.environmentId,
          environment,
        ])
      );
      for (const environmentId of state.environmentIds) {
        const environment = envById.get(environmentId);
        if (!environment) continue;
        const label = environmentLabel(environment, {
          hostName: (hostId) => hostById.get(hostId)?.name,
        });
        // Pinned plugins materialize servers of their own, which no query here
        // returns — such a row is opaque and is left to the resolver.
        if ((environment.pluginVersionIds?.length ?? 0) > 0) {
          targets.push({
            label,
            serverIds: null,
            serverCount: null,
            opaque: true,
          });
          continue;
        }
        const target = environment.serverAttachmentId
          ? groupTarget(label, environment.serverAttachmentId)
          : hostTarget(environment.hostId, label);
        if (target) targets.push(target);
      }
    }

    return assessCloudServerReadiness({ targets, servers: catalog });
  }, [environments, hosts, serverAttachments, servers, state]);
}
