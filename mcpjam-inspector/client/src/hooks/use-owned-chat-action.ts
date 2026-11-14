import { useCallback, useEffect, useRef, useState } from "react";

export type OwnedChatActionOptions<Payload> = {
  scope: string;
  disabled: boolean;
  /** Persistent admission while an admitted action runs. Callers may exclude
   * busy state caused by their own readiness gates; entry still checks disabled. */
  liveBlocked?: boolean;
  accepts: (payload: Payload) => boolean;
  gates: readonly (() => Promise<boolean>)[];
  send: (payload: Payload, isCurrent: () => boolean) => Promise<boolean>;
  onSent?: () => void;
  /** Admit a transfer while its source is live, before a new-chat reset disposes it. */
  prepareNew?: (
    payload: Payload,
    isCurrent: () => boolean,
  ) => Promise<Payload | null>;
  /** How long a `prepareNew` result stays usable; no new chat starts after. */
  preparedForMs?: number;
  lock?: { current: boolean };
  /** Readiness for a draft, which only edits the composer: ownership,
   * read-only and transition state, never whether a send could run. */
  draftBlocked?: boolean;
  /** A draft in a new chat also waits for any running turn to finish. */
  newDraftBlocked?: boolean;
  /** Places the payload in the composer. Nothing executes. */
  draft?: (payload: Payload, isCurrent: () => boolean) => Promise<boolean>;
  newChat?: {
    ownerScope: string;
    threadId: string;
    begin: (isCurrent: () => boolean) => Promise<string | null>;
  };
};

/** Shared explicit dispatch lifetime for Setup and app messages. No effect on render. */
export function useOwnedChatAction<Payload>(
  options: OwnedChatActionOptions<Payload>,
) {
  const current = useRef(options);
  current.current = options;
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [pending, setPending] = useState(false);
  const dispatch = useCallback(
    async (
      payload: Payload,
      target: "active" | "new",
      requireLive: () => boolean = () => true,
      mode: "send" | "draft" = "send",
    ): Promise<boolean> => {
      const start = current.current;
      const blocked = (options: OwnedChatActionOptions<Payload>) =>
        mode === "draft"
          ? !options.draft ||
            options.draftBlocked === true ||
            (target === "new" && options.newDraftBlocked === true)
          : (options.liveBlocked ?? options.disabled);
      if (
        !mounted.current ||
        inFlight.current ||
        start.lock?.current ||
        (mode === "send" && start.disabled) ||
        blocked(start) ||
        !requireLive() ||
        !start.accepts(payload) ||
        (target === "new" && !start.newChat)
      )
        return false;
      inFlight.current = true;
      if (start.lock) start.lock.current = true;
      setPending(true);
      let expectedScope = start.scope;
      let transferred = false;
      let usableUntil = Infinity;
      const stillOwned = () =>
        mounted.current &&
        (transferred || requireLive()) &&
        current.current.scope === expectedScope &&
        !blocked(current.current) &&
        current.current.accepts(payload);
      try {
        // Gates prepare execution; a draft executes nothing.
        for (const gate of mode === "send" ? start.gates : []) {
          if (!stillOwned() || !(await gate()) || !stillOwned()) return false;
        }
        if (target === "new") {
          if (mode === "draft") {
            // The payload was fully checked before dispatch and needs no
            // server receipt; holding it here lets it outlive the source
            // App, which the new-chat reset disposes.
            if (!stillOwned()) return false;
            transferred = true;
          } else if (start.prepareNew) {
            const prepared = await start.prepareNew(payload, stillOwned);
            if (!prepared || !stillOwned()) return false;
            payload = prepared;
            transferred = true;
            usableUntil = Date.now() + (start.preparedForMs ?? Infinity);
          }
          const created = await start.newChat!.begin(
            () => stillOwned() && Date.now() < usableUntil,
          );
          const live = current.current;
          if (
            !mounted.current ||
            (!transferred && !requireLive()) ||
            !created ||
            created === start.newChat!.threadId ||
            live.newChat?.ownerScope !== start.newChat!.ownerScope ||
            live.newChat?.threadId !== created ||
            blocked(live)
          )
            return false;
          expectedScope = live.scope;
        }
        if (!stillOwned()) return false;
        if (mode === "draft")
          return await current.current.draft!(payload, stillOwned);
        const sent = await current.current.send(payload, stillOwned);
        if (sent && stillOwned()) current.current.onSent?.();
        return sent;
      } finally {
        inFlight.current = false;
        if (start.lock) start.lock.current = false;
        if (mounted.current) setPending(false);
      }
    },
    [],
  );
  return { dispatch, pending };
}
