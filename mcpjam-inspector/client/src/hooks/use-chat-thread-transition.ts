import { useCallback, useEffect, useRef } from "react";

/** Wait for the normal new-chat action to publish a ready destination identity. */
export function useChatThreadTransition(options: {
  threadId: string;
  ownerScope: string;
  begin: () => Promise<boolean>;
  /** Target bootstrap/restoration can settle after the new thread ID renders. */
  destinationReady?: boolean;
  timeoutMs?: number;
}) {
  const current = useRef(options);
  current.current = options;
  const pending = useRef<{
    source: string;
    owner: string;
    accepted: boolean;
    destination: string | null;
    finish: (value: string | null) => void;
  } | null>(null);
  const mounted = useRef(true);
  const settle = useCallback(() => {
    const active = pending.current;
    if (!active) return;
    if (current.current.ownerScope !== active.owner) active.finish(null);
    else if (active.accepted && current.current.threadId !== active.source) {
      const destination = current.current.threadId;
      if (active.destination && active.destination !== destination)
        active.finish(null);
      else {
        active.destination = destination;
        if (current.current.destinationReady !== false)
          active.finish(destination);
      }
    }
  }, []);
  useEffect(settle, [
    options.threadId,
    options.ownerScope,
    options.destinationReady,
    settle,
  ]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.finish(null);
    };
  }, []);
  const begin = useCallback(
    (isCurrent: () => boolean): Promise<string | null> => {
      if (!mounted.current || pending.current || !isCurrent())
        return Promise.resolve(null);
      const start = current.current;
      return new Promise((resolve) => {
        const timer = setTimeout(
          () => active.finish(null),
          start.timeoutMs ?? 10000,
        );
        const active = {
          source: start.threadId,
          owner: start.ownerScope,
          accepted: false,
          destination: null as string | null,
          finish(value: string | null) {
            if (pending.current !== active) return;
            pending.current = null;
            clearTimeout(timer);
            resolve(value);
          },
        };
        pending.current = active;
        void Promise.resolve()
          .then(() =>
            pending.current === active &&
            mounted.current &&
            current.current.ownerScope === start.ownerScope &&
            current.current.threadId === start.threadId &&
            isCurrent()
              ? start.begin()
              : false,
          )
          .then(
            (accepted) => {
              if (pending.current !== active) return;
              if (!accepted) active.finish(null);
              else {
                active.accepted = true;
                settle();
              }
            },
            () => active.finish(null),
          );
      });
    },
    [settle],
  );
  return { begin };
}
