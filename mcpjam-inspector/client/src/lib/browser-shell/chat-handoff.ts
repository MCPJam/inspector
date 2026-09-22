import { useEffect, useRef } from "react";

type Holder = {
  holding: boolean;
  release: (isCurrent: () => boolean) => Promise<boolean>;
  mounted: boolean;
  releaseInFlight?: Promise<void>;
};
const holders = new Map<string, Holder>();
const keyFor = (projectId: string | null, sessionId?: string | null) =>
  JSON.stringify([projectId, sessionId ?? null]);

type CommandHandoff = {
  settled: Promise<void>;
  release: () => Promise<void>;
  releaseInFlight?: Promise<void>;
};
// Tab-strip commands can hold a browser that has never had a mounted renderer.
// Keep these separate from pane registrations, which may mount/unmount while a
// command is still in flight and must not overwrite its pending handoff.
const commandHandoffs = new Map<string, Set<CommandHandoff>>();

export function runBrowserCommandWithHandoff<T>(args: {
  projectId: string;
  sessionId: string;
  send: () => Promise<T>;
  release: () => Promise<void>;
}): Promise<T> {
  const key = keyFor(args.projectId, args.sessionId);
  const pending = Promise.resolve().then(args.send);
  const handoff: CommandHandoff = {
    // Even an error can follow acquisition (for example a stale page). A lost
    // response is not evidence that the daemon did not acquire the lease.
    settled: pending.then(
      () => {},
      () => {},
    ),
    release: args.release,
  };
  const entries = commandHandoffs.get(key) ?? new Set<CommandHandoff>();
  entries.add(handoff);
  commandHandoffs.set(key, entries);
  return pending;
}

async function releaseCommandHandoffs(key: string): Promise<void> {
  const entries = commandHandoffs.get(key);
  if (!entries) return;
  for (const handoff of entries) {
    handoff.releaseInFlight ??= handoff.settled
      .then(handoff.release)
      .then(() => {
        entries.delete(handoff);
        if (!entries.size) commandHandoffs.delete(key);
      })
      .finally(() => {
        handoff.releaseInFlight = undefined;
      });
    await handoff.releaseInFlight;
  }
}

/** The holder survives closing the panel: the browser lease does too. */
export function useBrowserChatHandoff({
  projectId,
  sessionId,
  holding,
  release,
}: {
  projectId: string | null;
  sessionId?: string;
  holding: boolean;
  release: (isCurrent: () => boolean) => Promise<boolean>;
}) {
  const key = keyFor(projectId, sessionId);
  const ref = useRef<{ key: string; holder: Holder } | null>(null);
  if (ref.current?.key !== key) {
    ref.current = { key, holder: { holding, release, mounted: true } };
  }
  const holder = ref.current.holder;
  holder.holding = holding;
  holder.release = release;
  useEffect(() => {
    if (!projectId) return;
    holder.mounted = true;
    holders.set(key, holder);
    return () => {
      holder.mounted = false;
      if (!holder.holding && holders.get(key) === holder) holders.delete(key);
    };
  }, [projectId, key, holder]);
}

/** Await before dispatching a user turn so browser tools cannot race the handoff. */
export async function releaseBrowserForChat(
  projectId: string | null | undefined,
  sessionId?: string | null,
): Promise<void> {
  if (!projectId) return;
  const key = keyFor(projectId, sessionId);
  if (commandHandoffs.has(key)) await releaseCommandHandoffs(key);
  const holder = holders.get(key);
  if (!holder) return;
  if (!holder.releaseInFlight && holder.holding) {
    holder.releaseInFlight = holder
      .release(() => holder.mounted && holders.get(key) === holder)
      .then((released) => {
        if (!released) {
          throw new Error(
            "Couldn't return browser control to the agent. Try sending your message again.",
          );
        }
        holder.holding = false;
        if (!holder.mounted && holders.get(key) === holder) holders.delete(key);
      })
      .finally(() => {
        holder.releaseInFlight = undefined;
      });
  }
  // Also await an existing request if a render already updated holding.
  await holder.releaseInFlight;
}
