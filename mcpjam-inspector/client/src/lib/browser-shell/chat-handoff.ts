import { useEffect, useRef } from "react";

type Holder = {
  holding: boolean;
  release: () => Promise<boolean>;
  mounted: boolean;
};
const holders = new Map<string, Holder>();
const keyFor = (projectId: string | null, sessionId?: string | null) =>
  JSON.stringify([projectId, sessionId ?? null]);

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
  release: () => Promise<boolean>;
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
  const holder = holders.get(key);
  if (!holder) return;
  if (holder.holding && !(await holder.release())) {
    throw new Error(
      "Couldn't return browser control to the agent. Try sending your message again.",
    );
  }
  holder.holding = false;
  if (!holder.mounted && holders.get(key) === holder) holders.delete(key);
}
