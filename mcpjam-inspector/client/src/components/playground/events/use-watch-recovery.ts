import { useEffect, useRef } from "react";
import { useServerActionsOptional } from "@/state/server-actions-context";
import type { EventsFeedGap } from "@/components/events/use-events-feed";
import type { PlaygroundEventBinding } from "./PlaygroundEventsProvider";

/** How long the feed stays quiet before a quiet watch's position moves up. */
const SETTLED_MS = 5_000;

type Notice = (id: string, notice: string) => void;

/**
 * What brings the open conversation's saved event connections back to work
 * after a reload (AE-14):
 *
 * - Hosted only, reconnect each connection's server once, never with a
 *   sign-in popup. A hosted reload resets every server to disconnected; a
 *   local one re-syncs from the local process, where a manual connect could
 *   also ask to approve a stdio command, so it isn't attempted there.
 * - Local only, say when this app isn't running a connection's subscription:
 *   it restarted, or the connection was made on another computer.
 * - Say when the inbox may have dropped events before they could run.
 * - Once the feed is quiet and nothing waits for a connection, move its saved
 *   position up to the latest entry (a claim only moves forward), so a quiet
 *   connection doesn't replay the inbox, or warn again, on every load.
 */
export function useWatchRecovery(options: {
  hosted: boolean;
  conversationId: string | undefined;
  bindings: readonly PlaygroundEventBinding[];
  servers: Record<string, { connectionStatus?: string } | undefined>;
  /** The local runtime's subscription ids, once its stream has sent them. */
  localSubscriptions: ReadonlySet<string> | null;
  gaps: readonly EventsFeedGap[];
  /** The newest entry the feed has seen. */
  head: number | undefined;
  queued: (id: string) => number;
  notice: Notice;
  advance: (id: string, seq: number) => Promise<unknown>;
}) {
  const actions = useServerActionsOptional();
  const saved = options.bindings.filter(
    (binding) => binding.saved && binding.enabled,
  );
  const tried = useRef(new Set<string>());
  const warned = useRef(new Set<string>());
  const latest = useRef(options);
  latest.current = options;

  const disconnected = options.hosted
    ? [...new Set(saved.map((binding) => binding.serverName))]
        .filter((name) => {
          const status = options.servers[name]?.connectionStatus;
          return (
            status !== "connected" &&
            status !== "connecting" &&
            status !== "oauth-flow" &&
            !tried.current.has(`${options.conversationId}:${name}`)
          );
        })
        .sort()
    : [];
  const disconnectedKey = disconnected.join("\n");
  useEffect(() => {
    if (!actions || disconnected.length === 0) return;
    for (const name of disconnected)
      tried.current.add(`${latest.current.conversationId}:${name}`);
    const message = (name: string, result: {
      reauthServerNames: string[];
      missingServerNames: string[];
      readyServerNames: string[];
    }) =>
      result.readyServerNames.includes(name)
        ? null
        : result.reauthServerNames.includes(name)
          ? `Sign in to ${name} again to run its events.`
          : result.missingServerNames.includes(name)
            ? `${name} isn't in this project anymore. Connect the event to another server.`
            : `Couldn't connect ${name}. Connect it to run its events.`;
    void actions
      .ensureServersReady(disconnected)
      .then((result) => {
        for (const binding of latest.current.bindings) {
          const text = message(binding.serverName, result);
          if (text && disconnected.includes(binding.serverName))
            latest.current.notice(binding.id, text);
        }
      })
      .catch((error: unknown) => {
        for (const binding of latest.current.bindings)
          if (disconnected.includes(binding.serverName))
            latest.current.notice(
              binding.id,
              error instanceof Error
                ? error.message
                : `Couldn't connect ${binding.serverName}. Connect it to run its events.`,
            );
      });
    // `disconnectedKey` stands for `disconnected`, which is new each render.
  }, [actions, disconnectedKey]);

  const notRunning = options.localSubscriptions
    ? saved.filter(
        (binding) =>
          !options.hosted &&
          !options.localSubscriptions?.has(binding.subscriptionId),
      )
    : [];
  const gapped = saved.filter((binding) =>
    options.gaps.some((gap) => gap.toSeq > binding.afterSeq),
  );
  const noticeKey = [
    ...notRunning.map((binding) => `run:${binding.id}`),
    ...gapped.map((binding) => `gap:${binding.id}`),
  ].join("\n");
  useEffect(() => {
    for (const binding of notRunning)
      if (!warned.current.has(`run:${binding.id}`)) {
        warned.current.add(`run:${binding.id}`);
        options.notice(
          binding.id,
          "This local app isn't running this subscription. It restarted, or the connection was made on another computer. Connect the event again.",
        );
      }
    for (const binding of gapped)
      if (!warned.current.has(`gap:${binding.id}`)) {
        warned.current.add(`gap:${binding.id}`);
        options.notice(
          binding.id,
          "Some events may have expired before they could run.",
        );
      }
    // `noticeKey` stands for both lists, which are new each render.
  }, [noticeKey]);

  const quietKey = saved
    .map((binding) => `${binding.id}:${binding.afterSeq}`)
    .join("\n");
  useEffect(() => {
    const head = options.head;
    if (head === undefined) return;
    const timer = setTimeout(() => {
      const current = latest.current;
      for (const binding of current.bindings)
        if (
          binding.saved &&
          binding.enabled &&
          head > binding.afterSeq &&
          current.queued(binding.id) === 0
        )
          void current.advance(binding.id, head).catch((error: unknown) => {
            // A refused move only costs a longer replay on the next load.
            console.warn("Couldn't save an event connection's position", error);
          });
    }, SETTLED_MS);
    return () => clearTimeout(timer);
  }, [options.head, quietKey]);
}
