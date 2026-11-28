import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type {
  EventDescriptorView,
  EventsSubscriptionView,
} from "@/shared/events-api";
import {
  EVENT_WATCHES_API,
  type SavedEventWatch,
  type SavedEventWatchTarget,
} from "@/lib/apis/event-watches-api";
import type { SubscribeFormValue } from "@/components/events/use-subscribe-form";
import { logicalIdOf } from "@/components/events/event-utils";
import type { EventClaimResult } from "./event-dispatch";
import type { PlaygroundEventBinding } from "./PlaygroundEventsProvider";

/** What a page knows about a saved watch that the row doesn't hold. */
type LiveFields = Pick<PlaygroundEventBinding, "recentEvents" | "notice">;

/** The subscription's arguments and mode, as saved with the watch. */
export function subscribeJsonOf(value: SubscribeFormValue): string {
  return JSON.stringify({ arguments: value.arguments, mode: value.mode });
}

function savedSubscribe(
  row: SavedEventWatch,
): Pick<PlaygroundEventBinding, "savedArguments"> {
  if (!row.subscribeJson) return {};
  try {
    const parsed = JSON.parse(row.subscribeJson) as {
      arguments?: Record<string, unknown>;
    };
    return parsed.arguments ? { savedArguments: parsed.arguments } : {};
  } catch {
    // An unreadable value only costs the arguments in the agent's listing.
    return {};
  }
}

/** Rows as the query has them, with this page's writes it hasn't caught up to. */
function withPending(
  rows: readonly SavedEventWatch[],
  pending: Record<string, SavedEventWatch | null>,
  chatSessionId: string,
): SavedEventWatch[] {
  const merged = new Map(rows.map((row) => [row._id, row]));
  for (const [id, write] of Object.entries(pending)) {
    const current = merged.get(id);
    if (write === null) merged.delete(id);
    else if (
      write.chatSessionId === chatSessionId &&
      (!current || current.updatedAt < write.updatedAt)
    )
      merged.set(id, write);
  }
  return [...merged.values()];
}

/**
 * The Playground's saved event connections for the open conversation and
 * client (backend `eventWatches`, AE-14). `projectId` is the Convex project,
 * passed only for a signed-in user; without it nothing is saved and the
 * provider keeps connections in page memory, as for guests.
 *
 * Bindings come back in the provider's shape. Rows made as another client, or
 * in the other runtime (hosted or local), are left out: their subscription
 * means nothing here.
 */
export function useWatchStore(options: {
  projectId: string | null;
  conversationId: string | undefined;
  hostId: string | null;
  locality: "hosted" | "local";
  agentScope: string | undefined;
  ownerScope: string;
  describe: (
    serverName: string,
    eventName: string,
  ) => EventDescriptorView | undefined;
}) {
  const { projectId, conversationId, hostId, locality } = options;
  const saving = !!projectId && !!conversationId;
  const rows = useQuery(
    EVENT_WATCHES_API.listForConversation,
    saving ? { projectId, chatSessionId: conversationId } : "skip",
  );
  const createRow = useMutation(EVENT_WATCHES_API.create);
  const updateRow = useMutation(EVENT_WATCHES_API.update);
  const removeRow = useMutation(EVENT_WATCHES_API.remove);
  const claimRow = useMutation(EVENT_WATCHES_API.claimEvent);
  const [pending, setPending] = useState<
    Record<string, SavedEventWatch | null>
  >({});
  const [live, setLive] = useState<Record<string, LiveFields>>({});
  const [views, setViews] = useState<Record<string, EventsSubscriptionView>>(
    {},
  );
  // When the open conversation's connections loaded: reset on every open,
  // not once per page, so events that arrived while it was closed count as
  // having waited each time it's reopened.
  const opened = useRef<{ conversationId?: string; at?: number }>({});
  if (opened.current.conversationId !== conversationId)
    opened.current = { conversationId };
  if (rows !== undefined && conversationId && opened.current.at === undefined)
    opened.current.at = Date.now();

  // Drop writes the query has caught up to.
  useEffect(() => {
    if (!rows) return;
    setPending((previous) => {
      const next = { ...previous };
      for (const [id, write] of Object.entries(previous)) {
        const row = rows.find((candidate) => candidate._id === id);
        if (write === null ? !row : row && row.updatedAt >= write.updatedAt)
          delete next[id];
      }
      return Object.keys(next).length === Object.keys(previous).length
        ? previous
        : next;
    });
  }, [rows]);

  const toBinding = (row: SavedEventWatch): PlaygroundEventBinding => {
    const view = views[row.subscriptionId];
    return {
      id: row._id,
      saved: true,
      subscriptionId: row.subscriptionId,
      logicalId: row.logicalId,
      serverName: row.serverName,
      eventName: row.eventName,
      instructions: row.instructions,
      enabled: row.enabled,
      afterSeq: row.afterSeq,
      agentScope: options.agentScope ?? "",
      ownerScope: options.ownerScope,
      event: options.describe(row.serverName, row.eventName) ?? {
        name: row.eventName,
        delivery: [],
      },
      ...(view ? { subscription: view } : {}),
      ...savedSubscribe(row),
      ...(row.title ? { title: row.title } : {}),
      createdBy: row.createdBy,
      ...live[row._id],
    };
  };
  const visible =
    saving && rows && conversationId
      ? withPending(rows, pending, conversationId).filter(
          (row) => row.hostId === hostId && row.locality === locality,
        )
      : [];
  const bindings = visible.map(toBinding);
  const savedIds = new Set(visible.map((row) => row._id));

  /** Records a write so renders before the query catches up still show it. */
  const remember = (row: SavedEventWatch) => {
    setPending((previous) => ({ ...previous, [row._id]: row }));
    return toBinding(row);
  };
  const recordViews = (subscriptions: EventsSubscriptionView[]) =>
    setViews((previous) => {
      const next = { ...previous };
      for (const subscription of subscriptions)
        next[subscription.id] = subscription;
      return next;
    });
  const create = async (
    target: SavedEventWatchTarget,
    fields: Pick<PlaygroundEventBinding, "instructions" | "afterSeq"> & {
      title?: string;
      createdBy: "agent" | "user";
    },
  ): Promise<PlaygroundEventBinding> => {
    if (!projectId || !conversationId)
      throw new Error("Open a saved conversation before connecting an event.");
    const row = await createRow({
      projectId,
      chatSessionId: conversationId,
      hostId,
      locality,
      ...target,
      ...fields,
    });
    return remember(row);
  };
  const update = async (
    id: string,
    fields: {
      instructions?: string;
      title?: string | null;
      enabled?: boolean;
      afterSeq?: number;
      retarget?: SavedEventWatchTarget;
    },
  ): Promise<PlaygroundEventBinding> =>
    remember(await updateRow({ watchId: id, ...fields }));

  return {
    saving,
    /** False until the open conversation's saved connections have loaded. */
    loaded: !saving || rows !== undefined,
    bindings,
    isSaved: (id: string) => savedIds.has(id),
    /** When the binding's conversation was last opened in this page. */
    loadedAt: (binding: PlaygroundEventBinding) =>
      binding.saved && opened.current.conversationId === conversationId
        ? opened.current.at
        : undefined,
    patchLive(id: string, patch: (fields: LiveFields) => LiveFields) {
      setLive((previous) => ({
        ...previous,
        [id]: { ...previous[id], ...patch(previous[id] ?? {}) },
      }));
    },
    recordViews,
    update,
    /**
     * Saves a new connection, or with `retargetId` points an existing one at
     * another subscription, and returns it with its event and subscription.
     */
    async save(
      to: {
        subscription: EventsSubscriptionView;
        serverName: string;
        event: EventDescriptorView;
        value: SubscribeFormValue;
      },
      fields: Pick<PlaygroundEventBinding, "afterSeq"> &
        Partial<Pick<PlaygroundEventBinding, "instructions">> & {
          title?: string;
          createdBy?: "agent" | "user";
        },
      retargetId?: string,
    ): Promise<PlaygroundEventBinding> {
      const target: SavedEventWatchTarget = {
        subscriptionId: to.subscription.id,
        logicalId: logicalIdOf(to.subscription),
        serverName: to.serverName,
        eventName: to.event.name,
        subscribeJson: subscribeJsonOf(to.value),
      };
      const binding = retargetId
        ? await update(retargetId, { afterSeq: fields.afterSeq, retarget: target })
        : await create(target, {
            instructions: fields.instructions ?? "",
            afterSeq: fields.afterSeq,
            createdBy: fields.createdBy ?? "user",
            ...(fields.title ? { title: fields.title } : {}),
          });
      recordViews([to.subscription]);
      return { ...binding, event: to.event, subscription: to.subscription };
    },
    async remove(id: string) {
      setPending((previous) => ({ ...previous, [id]: null }));
      try {
        await removeRow({ watchId: id });
      } catch (error) {
        setPending((previous) => {
          const next = { ...previous };
          delete next[id];
          return next;
        });
        throw error;
      }
    },
    /**
     * Claims entry `seq` (also used to move a quiet watch's position forward,
     * since a claim only moves it forward). Null for a binding that isn't
     * saved: it needs no claim.
     */
    async claim(id: string, seq: number): Promise<EventClaimResult | null> {
      if (!savedIds.has(id)) return null;
      return claimRow({ watchId: id, seq });
    },
  };
}

export type WatchStore = ReturnType<typeof useWatchStore>;
