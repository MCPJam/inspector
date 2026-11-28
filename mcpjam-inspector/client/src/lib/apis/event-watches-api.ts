import { makeFunctionReference } from "convex/server";

/**
 * A Playground conversation's saved watch on one subscription (backend
 * `eventWatches`, AE-14). `afterSeq` is the last events-inbox entry it
 * handled: the Playground replays what came after it and claims each entry
 * before its turn, so a reload resumes where the watch stopped and a second
 * tab skips what already ran. A claim is never given back.
 */
export interface SavedEventWatch {
  _id: string;
  projectId: string;
  chatSessionId: string;
  hostId: string | null;
  locality: "hosted" | "local";
  /** Hosted: the registry row's id. Local: the local runtime's id. */
  subscriptionId: string;
  logicalId: string;
  serverName: string;
  eventName: string;
  /** The subscription's arguments and mode, as the page saved them. */
  subscribeJson?: string;
  instructions: string;
  title?: string;
  createdBy: "agent" | "user";
  enabled: boolean;
  afterSeq: number;
  createdAt: number;
  updatedAt: number;
}

/** What a watch points at; a type, so it can be part of function args. */
export type SavedEventWatchTarget = {
  subscriptionId: string;
  logicalId: string;
  serverName: string;
  eventName: string;
  subscribeJson?: string;
};

export interface EventClaim {
  claimed: boolean;
  previousAfterSeq: number;
  reason?: "handled" | "paused" | "removed";
}

export const EVENT_WATCHES_API = {
  listForConversation: makeFunctionReference<
    "query",
    { projectId: string; chatSessionId: string },
    SavedEventWatch[]
  >("eventWatches:listForConversation"),
  create: makeFunctionReference<
    "mutation",
    SavedEventWatchTarget & {
      projectId: string;
      chatSessionId: string;
      hostId: string | null;
      locality: "hosted" | "local";
      instructions: string;
      title?: string;
      createdBy: "agent" | "user";
      afterSeq: number;
    },
    SavedEventWatch
  >("eventWatches:create"),
  update: makeFunctionReference<
    "mutation",
    {
      watchId: string;
      instructions?: string;
      title?: string | null;
      enabled?: boolean;
      afterSeq?: number;
      retarget?: SavedEventWatchTarget;
    },
    SavedEventWatch
  >("eventWatches:update"),
  remove: makeFunctionReference<"mutation", { watchId: string }, null>(
    "eventWatches:remove",
  ),
  claimEvent: makeFunctionReference<
    "mutation",
    { watchId: string; seq: number },
    EventClaim
  >("eventWatches:claimEvent"),
};
