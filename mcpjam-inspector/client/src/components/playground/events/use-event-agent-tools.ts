import { useMemo, useRef } from "react";
import {
  createEventAgentToolExecutor,
  type EventAgentToolExecutor,
} from "./event-agent-tools";
import { usePlaygroundEvents } from "./PlaygroundEventsProvider";

/**
 * The MCP Events agent tools for this Playground conversation, or
 * `undefined` when they are not offered (`enabled` false, or Events off).
 * One executor per mount, reading the CURRENT events runtime at call time,
 * so a call never runs against a render that has already been replaced.
 */
export function usePlaygroundEventAgentTools(
  enabled: boolean,
): EventAgentToolExecutor | undefined {
  const runtime = usePlaygroundEvents();
  const latest = useRef(runtime);
  latest.current = runtime;
  const executor = useMemo(
    () => createEventAgentToolExecutor(() => latest.current),
    [],
  );
  return enabled && runtime ? executor : undefined;
}
