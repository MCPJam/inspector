import { useEffect } from "react";
import { create } from "zustand";
import type { EventAgent } from "./event-dispatch";

export const useEventAgentBridge = create<{
  agent: EventAgent | null;
  set: (agent: EventAgent | null) => void;
}>((set) => ({
  agent: null,
  set: (agent) => set({ agent }),
}));

export function usePublishEventAgent(agent: EventAgent) {
  const publish = useEventAgentBridge((state) => state.set);
  const { scope, blockedReason, send } = agent;
  useEffect(() => {
    publish({ scope, blockedReason, send });
    return () => publish(null);
  }, [scope, blockedReason, send, publish]);
}
