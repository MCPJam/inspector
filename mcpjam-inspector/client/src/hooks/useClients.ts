import { useMutation, useQuery } from "convex/react";
import type { HostConfigDtoV2, HostConfigInputV2 } from "@/lib/client-config-v2";
import type { ChatboxMode } from "./useChatboxes";
import { shouldQueryProjectId } from "./useProjects";

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
  hostConfigId: string;
  modelId: string;
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
  // Additive: the Chatbox surface reads this to decide whether to render the
  // "managed by Swarms, no publish surface" notice instead of back-minting.
  ownerScope?: HostOwnerScope;
}

export function useHostList({
  isAuthenticated,
  projectId,
}: {
  isAuthenticated: boolean;
  projectId: string | null;
}): {
  hosts: HostListItem[];
  isLoading: boolean;
} {
  // Skip until `projectId` is a real Convex id. A transient LOCAL project id
  // (UUID, or a `local_`/`project_` placeholder) flows in while the shared
  // Convex id is still resolving — passing it to a `v.id("projects")` query
  // throws an ArgumentValidationError. `shouldQueryProjectId` is the same guard
  // every other project-scoped Convex query uses.
  const result = useQuery(
    "hosts:listHosts" as any,
    isAuthenticated && shouldQueryProjectId(projectId)
      ? ({ projectId } as any)
      : "skip",
  ) as HostListItem[] | null | undefined;

  return {
    hosts: result ?? [],
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
  const shouldQuery = isAuthenticated && shouldQueryHostId(hostId);
  // Trimmed, so a padded id can't pass the guard and then fail validation.
  const queryHostId = hostId?.trim() ?? "";

  const result = useQuery(
    "hosts:getHost" as any,
    shouldQuery ? ({ hostId: queryHostId } as any) : "skip",
  ) as HostDetail | null | undefined;

  return {
    host: result ?? null,
    // A skipped query never resolves, so reporting it as loading would leave
    // callers (the Connect canvas, the compare grid) spinning forever.
    isLoading: shouldQuery && result === undefined,
  };
}

export function useHostMutations() {
  const createHost = useMutation("hosts:createHost" as any) as unknown as (args: {
    projectId: string;
    name: string;
    input: HostConfigInputV2;
    // `'journeys'` → mint a standalone (chatbox-less) host owned by the Swarm
    // surface. `'user_testing'` → mint the host, an ad-hoc environment over
    // it, and an ENVIRONMENT-backed chatbox, all in one transaction; the
    // scenario's servers then resolve live from the host config instead of
    // being copied into the chatbox. Absent → legacy behavior (a host-backed
    // chatbox is minted).
    owner?: "journeys" | "user_testing";
    // Access mode for the auto-minted chatbox. Absent → 'project_members'.
    // Set here rather than with a follow-up setChatboxMode so a scenario is
    // never briefly readable by the wrong audience. Ignored for journeys hosts.
    chatboxMode?: ChatboxMode;
  }) => Promise<{
    hostId: string;
    hostConfigId: string;
    chatboxId: string | null;
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
