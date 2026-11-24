/**
 * Read-only `events/list` and `skills/list` on a connection the caller
 * already holds. The Events conformance runner and the server doctor read
 * through these, and a background probe can too, without opening a client of
 * its own. Each result carries a small summary (counts and protocol ids, no
 * server text) beside the full listing.
 */

import type { MCPClientManager } from "./mcp-client-manager/MCPClientManager.js";
import type { EventDescriptorWire } from "./mcp-client-manager/events-ext-schemas.js";
import type { SkillsSupport } from "./mcp-client-manager/skills-dispatch.js";
import {
  listServerSkillCatalog,
  type ServerSkillListing,
} from "./server-skills.js";

/** Pages of `events/list` read before stopping. */
export const EVENTS_LIST_MAX_PAGES = 20;

export interface ServerEventTypesRead {
  status: "listed" | "failed";
  /** Event types in listing order, including those read before a failure. */
  events: EventDescriptorWire[];
  /** The page cap stopped the walk while the server still offered a cursor. */
  truncated: boolean;
  /** Why a page failed, when `status` is `"failed"`. */
  error?: unknown;
  summary: { eventCount: number; deliveryModes: string[] };
}

/**
 * Walk `events/list` pages until the server stops offering a new cursor or
 * `maxPages` is reached. A failed page ends the walk; what was read is kept.
 * `signal` goes with every page and ends the walk once aborted, so no later
 * page is sent (and none reconnects a closed connection) after the caller
 * gave up; the read then reports `failed` with the abort reason.
 */
export async function readServerEventTypes(
  manager: Pick<MCPClientManager, "listServerEvents">,
  serverId: string,
  {
    maxPages = EVENTS_LIST_MAX_PAGES,
    signal,
  }: { maxPages?: number; signal?: AbortSignal } = {}
): Promise<ServerEventTypesRead> {
  const events: EventDescriptorWire[] = [];
  let truncated = false;
  let failure: { error: unknown } | undefined;
  try {
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      signal?.throwIfAborted();
      const result = await manager.listServerEvents(
        serverId,
        cursor !== undefined ? { cursor } : undefined,
        signal ? { signal } : undefined
      );
      events.push(...result.events);
      if (result.nextCursor === undefined || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
      truncated = page === maxPages - 1;
    }
  } catch (error) {
    failure = { error };
  }
  const summary = {
    eventCount: events.length,
    deliveryModes: [...new Set(events.flatMap((event) => event.delivery))],
  };
  return failure
    ? { status: "failed", events, truncated, error: failure.error, summary }
    : { status: "listed", events, truncated, summary };
}

export interface ServerSkillsListSummary {
  count: number;
  /** Listed skills the server itself marks as not loadable. */
  unloadable: number;
  /** Entries MCPJam could not make sense of. */
  rejected: number;
  directoryRead: boolean;
}

export type ServerSkillsRead =
  /** The extension is not active on this connection; nothing was sent. */
  | { status: "inactive"; support: SkillsSupport | undefined }
  | {
      status: "listed";
      support: SkillsSupport;
      listing: ServerSkillListing;
      summary: ServerSkillsListSummary;
    }
  | { status: "failed"; support: SkillsSupport; error: unknown };

/**
 * Drain `skills/list` through {@link listServerSkillCatalog} when the Skills
 * extension is active on this connection. `support` is undefined when the
 * manager could not report it. `options.signal` cancels the drain.
 */
export async function readServerSkillCatalog(
  manager: MCPClientManager,
  serverId: string,
  options: { signal?: AbortSignal } = {}
): Promise<ServerSkillsRead> {
  let support: SkillsSupport | undefined;
  try {
    support = manager.getSkillsSupport(serverId);
  } catch {
    // A manager that cannot report support has none to offer this read.
    support = undefined;
  }
  if (!support?.active) return { status: "inactive", support };

  try {
    const listing = await listServerSkillCatalog(manager, serverId, options);
    return {
      status: "listed",
      support,
      listing,
      summary: {
        count: listing.skills.length,
        unloadable: listing.skills.filter((skill) => skill.unloadable).length,
        rejected: listing.rejected.length,
        directoryRead: support.directoryRead,
      },
    };
  } catch (error) {
    return { status: "failed", support, error };
  }
}
