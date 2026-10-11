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
  lock?: { current: boolean };
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
    ): Promise<boolean> => {
      const start = current.current;
      if (
        !mounted.current ||
        inFlight.current ||
        start.lock?.current ||
        start.disabled ||
        start.liveBlocked === true ||
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
      const stillOwned = () =>
        mounted.current &&
        (transferred || requireLive()) &&
        current.current.scope === expectedScope &&
        !(current.current.liveBlocked ?? current.current.disabled) &&
        current.current.accepts(payload);
      try {
        for (const gate of start.gates) {
          if (!stillOwned() || !(await gate()) || !stillOwned()) return false;
        }
        if (target === "new") {
          if (start.prepareNew) {
            const prepared = await start.prepareNew(payload, stillOwned);
            if (!prepared || !stillOwned()) return false;
            payload = prepared;
            transferred = true;
          }
          const created = await start.newChat!.begin(stillOwned);
          const live = current.current;
          if (
            !mounted.current ||
            (!transferred && !requireLive()) ||
            !created ||
            created === start.newChat!.threadId ||
            live.newChat?.ownerScope !== start.newChat!.ownerScope ||
            live.newChat?.threadId !== created ||
            (live.liveBlocked ?? live.disabled)
          )
            return false;
          expectedScope = live.scope;
        }
        if (!stillOwned()) return false;
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
