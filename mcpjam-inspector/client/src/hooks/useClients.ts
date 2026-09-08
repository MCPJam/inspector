import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import type { HostConfigDtoV2, HostConfigInputV2 } from "@/lib/client-config-v2";
import type { ScenarioMode } from "./useScenarios";
import { shouldQueryProjectId } from "./useProjects";
import { withoutPrivateScenarioBackingHosts } from "@/lib/host-owner-scope";
import { resolveClientDisplayNames } from "@/lib/client-display-name";

/**
 * Product ownership of a host. Defined in `@/lib/host-owner-scope` alongside
 * the "hide private scenario-backing clients" predicate — a pure module, so
 * surfaces that mock this hooks module in tests still get the real rule.
 * Re-exported here because host consumers reach for it beside `HostListItem`.
 */
export type { HostOwnerScope } from "@/lib/host-owner-scope";
import type { HostOwnerScope } from "@/lib/host-owner-scope";

export interface HostListItem {
  hostId: string;
  name: string;
  /** Presentation-only unique name; never persisted or sent to mutations. */
  displayName?: string;
  hostConfigId: string;
  modelId: string;
  /**
   * The emulated client this host is, from the list query's own config read.
   * Additive: older backends omit it, so readers must treat absent as unknown
   * rather than as "no style". Available for EVERY host, which is what lets
   * Compare reconcile the live list against the catalog presets without
   * depending on which rows happen to be selected.
   */
  hostStyle?: string | null;
  serverCount: number;
  // Additive (PR: standalone hosts). Older backends omit these; readers must
  // treat absent as null/false rather than assume presence.
  ownerScope?: HostOwnerScope;
  hasComputer?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface HostDetail {
  hostId: string;
  name: string;
  config: HostConfigDtoV2;
  // Additive: the Scenario surface reads this to decide whether to render the
  // "managed by Swarms, no publish surface" notice instead of back-minting.
  ownerScope?: HostOwnerScope;
}

/**
 * The project's clients, with private scenario-backing ones REMOVED by default.
 *
 * The filter lives here rather than at each call site because there are ~18 of
 * them and the ones that matter are leaves: `HostPicker`, `MultiHostPicker`,
 * `ClientAttachmentsEditor` and friends each call this hook themselves, so a
 * caller that filters the list it holds does nothing about the picker rendered
 * inside it. Defaulting to the safe set is the only version of this rule that
 * actually holds — a new picker gets it without knowing it exists.
 *
 * `includePrivateBacking` is for the handful of consumers doing an id → name
 * or id → row LOOKUP rather than offering a choice; for them a missing host is
 * a rendering bug, not a safety win. Pass it deliberately and say why.
 */
export function useHostList({
  isAuthenticated,
  projectId,
  includePrivateBacking = false,
}: {
  isAuthenticated: boolean;
  projectId: string | null;
  includePrivateBacking?: boolean;
}): {
  hosts: HostListItem[];
  isLoading: boolean;
} {
  const isUserReady = useDbUserReady();
  const queryProjectId = projectId?.trim() ?? "";
  const hasQueryableProjectId = shouldQueryProjectId(queryProjectId);
  const shouldQuery =
    isAuthenticated && isUserReady && hasQueryableProjectId;

  // Skip until `projectId` is a real Convex id. A transient LOCAL project id
  // (UUID, or a `local_`/`project_` placeholder) flows in while the shared
  // Convex id is still resolving — passing it to a `v.id("projects")` query
  // throws an ArgumentValidationError. `shouldQueryProjectId` is the same guard
  // every other project-scoped Convex query uses.
  const result = useQuery(
    "hosts:listHosts" as any,
    shouldQuery ? ({ projectId: queryProjectId } as any) : "skip",
  ) as HostListItem[] | null | undefined;

  const hosts = useMemo(() => {
    const all = result ?? [];
    const visible = withoutPrivateScenarioBackingHosts(all);
    const displayNames = resolveClientDisplayNames(visible);
    const decorated = all.map((host) => ({
      ...host,
      displayName: displayNames.get(host.hostId) ?? host.name,
    }));
    return includePrivateBacking
      ? decorated
      : withoutPrivateScenarioBackingHosts(decorated);
  }, [result, includePrivateBacking]);

  return {
    hosts,
    // Loading in EVERY skip window, not just while the query is in flight.
    // `HostsRoute` reads an empty list as a dead permalink and bounces it, and
    // the `?template=` flow reads it as "no such host yet" and mints one — both
    // are wrong while the answer is merely unknown (signed out, `projectId`
    // still a placeholder, or the `users` row still bootstrapping), so those
    // windows must read as pending rather than as an answered empty.
    isLoading: result === undefined,
  };
}

// Deliberately a HEURISTIC, not a validator: Convex's id format is not a
// documented syntax to match against, so only the backend's `normalizeId` can
// answer this for real. It exists to catch the class of value that actually
// reaches us — a short catalog slug — since host ids travel through the URL
// (`/hosts/:hostId`) and through per-project persisted storage.
const CONVEX_HOST_ID_PATTERN = /^[a-z0-9]{20,}$/i;

/**
 * Whether `hostId` is shaped like a Convex `hosts` document id, and so could
 * resolve to a host at all.
 *
 * `/hosts/:hostId` hands over whatever is in the URL, so a clients-catalog slug
 * gets here — `/hosts/chatgpt`, whose supported deep link is
 * `/hosts?template=chatgpt`. Such a value can never resolve to a host, and
 * querying with it used to throw against `hosts:getHost`'s `v.id("hosts")`
 * argument, surfacing as an opaque `[CONVEX Q(hosts:getHost)] Server Error`
 * (the Sentry issue this guard closes). The backend now normalizes the id and
 * reads a malformed one as not-found, so this is no longer the only thing
 * standing between a typed URL and a crash — it stays because a value that
 * cannot resolve should not cost a round-trip, and because `HostsRoute` uses it
 * to keep such a value OUT of persisted state, where it would outlive the URL.
 *
 * Positive shape check rather than `shouldQueryProjectId`'s sentinel blocklist:
 * a slug looks like a perfectly ordinary id to a blocklist.
 */
export function shouldQueryHostId(hostId: string | null | undefined): boolean {
  const normalized = hostId?.trim();
  return Boolean(normalized && CONVEX_HOST_ID_PATTERN.test(normalized));
}

export function useHost({
  isAuthenticated,
  hostId,
}: {
  isAuthenticated: boolean;
  hostId: string | null;
}): {
  host: HostDetail | null;
  isLoading: boolean;
} {
  const isUserReady = useDbUserReady();
  const hasQueryableHostId = shouldQueryHostId(hostId);
  const shouldQuery = isAuthenticated && isUserReady && hasQueryableHostId;
  // Trimmed, so a padded id can't pass the guard and then fail validation.
  const queryHostId = hostId?.trim() ?? "";

  const result = useQuery(
    "hosts:getHost" as any,
    shouldQuery ? ({ hostId: queryHostId } as any) : "skip",
  ) as HostDetail | null | undefined;

  return {
    host: result ?? null,
    // Loading only while an answer is actually coming: signed out, or a hostId
    // that can never resolve (a catalog slug in the URL), reports NOT loading,
    // because that query stays skipped forever and callers (the Connect canvas,
    // the compare grid) would spin forever waiting on it. Waiting for the
    // `users` row IS loading — that skip does resolve, once bootstrap lands.
    isLoading: isAuthenticated && hasQueryableHostId && result === undefined,
  };
}

export function useHostMutations() {
  const createHost = useMutation("hosts:createHost" as any) as unknown as (args: {
    projectId: string;
    name: string;
    input: HostConfigInputV2;
    // `'journeys'` → mint a standalone (scenario-less) host owned by the Swarm
    // surface. `'user_testing'` → mint the host, an ad-hoc environment over
    // it, and an ENVIRONMENT-backed scenario, all in one transaction; the
    // scenario's servers then resolve live from the host config instead of
    // being copied into the scenario. Absent → legacy behavior (a host-backed
    // scenario is minted).
    owner?: "journeys" | "user_testing";
    // Access mode for the auto-minted scenario. Absent → 'project_members'.
    // Set here rather than with a follow-up setScenarioMode so a scenario is
    // never briefly readable by the wrong audience. Ignored for journeys hosts.
    scenarioMode?: ScenarioMode;
  }) => Promise<{
    hostId: string;
    hostConfigId: string;
    scenarioId: string | null;
    // Present only for `owner: 'user_testing'` — the ad-hoc environment the
    // scenario resolves through, needed to rebind its setup later.
    environmentId?: string;
  }>;

  const updateHost = useMutation("hosts:updateHost" as any) as unknown as (args: {
    hostId: string;
    name?: string;
    input?: HostConfigInputV2;
  }) => Promise<{ hostId: string; hostConfigId: string }>;

  // Transactional server-only edit: the backend composes the rest of the
  // config from the host's CURRENT stored config inside the mutation, so a
  // concurrent model/prompt edit can't be reverted by a stale client cache
  // (which a full-config `updateHost` round-trip is vulnerable to).
  const updateHostServers = useMutation(
    "hosts:updateHostServers" as any,
  ) as unknown as (args: {
    hostId: string;
    serverIds: string[];
    optionalServerIds?: string[];
  }) => Promise<{ hostId: string; hostConfigId: string }>;

  const deleteHost = useMutation("hosts:deleteHost" as any) as unknown as (args: {
    hostId: string;
    force?: boolean;
  }) => Promise<void>;

  const duplicateHost = useMutation("hosts:duplicateHost" as any) as unknown as (args: {
    hostId: string;
    name?: string;
  }) => Promise<{ hostId: string; hostConfigId: string }>;

  return {
    createHost,
    updateHost,
    updateHostServers,
    deleteHost,
    duplicateHost,
  };
}
