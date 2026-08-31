import { isLocalOnlyMcpServerConfig } from "@/shared/local-only-mcp";

/**
 * Pre-launch check for surfaces whose runs execute in MCPJam's cloud.
 *
 * ## Why this exists
 *
 * A hosted run resolves its servers from the environment: the environment's
 * server group when it names one, otherwise the CLIENT's server set (see
 * `resolveEnvironment` in the backend). Neither the composer nor the launch
 * button looked at that set, so a client with nothing enrolled produced a
 * perfectly valid-looking setup — and the failure only arrived from the
 * resolver, as `ENV_NO_SERVERS`, after personas, goals and an ad-hoc
 * `Swarm setup · <client>` row had already been written.
 *
 * Locality is the second half of the same question, and the resolver does NOT
 * answer it: a stdio server, or one on `localhost`/a private address, resolves
 * exactly like a public one and then fails at connect time inside the cloud
 * run. A cloud-only surface can rule both out here, while the user is still
 * looking at the picker they'd have to change.
 *
 * Everything here is pure so the rules are testable without a Convex mock; the
 * hook that feeds it lives in `use-cloud-server-readiness.ts`.
 */

/** A project-catalog server, narrowed to what classification needs. */
export type CloudServerCatalogEntry = {
  _id: string;
  name: string;
  /** stdio servers carry a command; presence alone makes them local-only. */
  command?: unknown;
  /** http servers carry a url; a private/loopback host makes it local-only. */
  url?: unknown;
};

/** One thing a cloud run would be launched against — a client or environment. */
export type CloudLaunchTarget = {
  /** Name shown in the block copy. */
  label: string;
  /**
   * The servers this target resolves to, when the surface knows them (an
   * explicit server group does). `null` when only the COUNT is known —
   * `hosts:listHosts` summarizes a client's set as `serverCount`.
   */
  serverIds: readonly string[] | null;
  /**
   * How many servers the target resolves to. `null` = UNKNOWN, which is not
   * zero: an older backend omits the field, and a target we can't measure must
   * never be blocked on a guess.
   */
  serverCount: number | null;
  /**
   * Set when something outside this view can contribute servers — a pinned
   * plugin materializes its own. Such a target is skipped entirely rather than
   * judged on the servers we happen to see.
   */
  opaque?: boolean;
};

export type CloudServerReadiness =
  | { status: "ok" }
  /** At least one target resolves to zero servers — the `ENV_NO_SERVERS` shape. */
  | { status: "no_servers"; labels: string[] }
  /** A target carries a server the run refuses: one stdio member, or a set
   * that is unreachable end to end. `serverNames` lists only the offenders. */
  | { status: "local_only"; labels: string[]; serverNames: string[] };

/**
 * The servers in this set that would sink the run, or none.
 *
 * One stdio server is enough: the runner refuses it whatever else the target
 * resolves to. Locality short of that only counts for the set as a whole — a
 * loopback URL beside a reachable server has not been observed to fail, and
 * blocking on it would be a guess.
 */
export function unrunnableServers(
  servers: readonly CloudServerCatalogEntry[],
): CloudServerCatalogEntry[] {
  const unreachable = servers.filter((server) =>
    isLocalOnlyMcpServerConfig(server),
  );
  if (unreachable.length === 0) return [];
  // Nothing here can run: name them all, or the user fixes one and fails again.
  if (unreachable.length === servers.length) return unreachable;
  // Otherwise only a stdio member sinks an otherwise-fine set.
  return unreachable.filter((server) => typeof server.command === "string");
}

/**
 * Whether a cloud run against exactly these servers can start. An empty set
 * cannot: it resolves to zero servers, even though there is nothing
 * unreachable to name.
 */
export function serversAreRunnable(
  servers: readonly CloudServerCatalogEntry[],
): boolean {
  return servers.length > 0 && unrunnableServers(servers).length === 0;
}

/**
 * Judge a set of launch targets against the project's server catalog.
 *
 * Fails OPEN on missing data — an unmeasurable target is skipped, not blocked —
 * because a false block would wall a user off from a setup that runs fine. The
 * resolver's own `ENV_NO_SERVERS` remains the backstop for anything we skip.
 *
 * `no_servers` outranks `local_only`: it needs a different fix (connect or
 * enroll a server, versus make an existing one reachable), and reporting the
 * emptier problem first keeps the copy to one instruction.
 */
export function assessCloudServerReadiness(args: {
  targets: readonly CloudLaunchTarget[];
  /** The project's server catalog. Empty while it loads — treated as unknown. */
  servers: readonly CloudServerCatalogEntry[];
}): CloudServerReadiness {
  const byId = new Map(args.servers.map((server) => [server._id, server]));
  const emptyLabels: string[] = [];
  const localOnlyLabels: string[] = [];
  const localOnlyServerNames = new Set<string>();

  for (const target of args.targets) {
    if (target.opaque) continue;
    if (target.serverCount === 0) {
      emptyLabels.push(target.label);
      continue;
    }

    let candidates: CloudServerCatalogEntry[];
    if (target.serverIds) {
      candidates = target.serverIds
        .map((serverId) => byId.get(serverId))
        .filter((server): server is CloudServerCatalogEntry => Boolean(server));
      // A partial view of the group (catalog still loading, a server moved
      // projects) can't rule locality out for the members we can't see.
      if (candidates.length !== target.serverIds.length) continue;
    } else {
      // Only a count: the target's servers are SOME subset of the catalog, so
      // locality is only decidable when the whole catalog is local-only. That
      // needs a known, non-zero count — an unknown one could be zero, which is
      // the other problem entirely.
      if (typeof target.serverCount !== "number" || target.serverCount === 0) {
        continue;
      }
      candidates = [...args.servers];
    }

    if (candidates.length === 0) continue;
    const unrunnable = unrunnableServers(candidates);
    if (unrunnable.length === 0) continue;
    localOnlyLabels.push(target.label);
    for (const server of unrunnable) localOnlyServerNames.add(server.name);
  }

  if (emptyLabels.length > 0) {
    return { status: "no_servers", labels: emptyLabels };
  }
  if (localOnlyLabels.length > 0) {
    return {
      status: "local_only",
      labels: localOnlyLabels,
      serverNames: [...localOnlyServerNames],
    };
  }
  return { status: "ok" };
}

function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 2) return labels.join(" and ");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * User-facing copy for a block. `null` for `ok`, so a caller can render the
 * notice and gate its button off the same value.
 *
 * `message` states the finding, `detail` the next step — the same two-part
 * shape `CloudUnreachableNotice` already renders for the sandbox block, and the
 * same split `environment-error.ts` uses for the resolver's own failure.
 */
export function describeCloudServerBlock(readiness: CloudServerReadiness): {
  message: string;
  detail: string;
} | null {
  if (readiness.status === "ok") return null;
  const subject = joinLabels(readiness.labels);
  const verb = readiness.labels.length > 1 ? "have" : "has";
  if (readiness.status === "no_servers") {
    return {
      message: `${subject} ${verb} no servers to run against.`,
      detail:
        "A cloud run takes its servers from the client, so this setup would be rejected at launch. Connect a server and turn on Auto-connect on the Servers tab, or attach a server group to the setup.",
    };
  }
  return {
    message: `${subject} ${verb} servers this run can't reach: ${joinLabels(readiness.serverNames)}.`,
    detail:
      "Sessions run in MCPJam's cloud, which can't reach a stdio server or a localhost/private-address URL. Expose the server over HTTPS (Create tunnel on its card does this) and point the client at that URL, or run it from a local surface instead.",
  };
}
