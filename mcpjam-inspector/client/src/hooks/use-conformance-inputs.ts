import { useMemo } from "react";
import type { ConformanceProbes } from "./use-conformance-probes";

/**
 * Protocol inputs are shared; Tasks settings and the log level filtering
 * advice's own tool on this browser take precedence.
 */
export function mergeConformanceInputs(
  shared: ConformanceProbes,
  local: ConformanceProbes,
): ConformanceProbes {
  return {
    ...shared,
    ...(local.tasksProbe ? { tasksProbe: local.tasksProbe } : {}),
    ...(local.tasksOverrides ? { tasksOverrides: local.tasksOverrides } : {}),
    ...(local.logLevelOverride
      ? { logLevelOverride: local.logLevelOverride }
      : {}),
  };
}

export function useConformanceInputs(
  shared: Record<string, ConformanceProbes> | undefined,
  localFor: (name: string) => ConformanceProbes,
) {
  return useMemo(() => {
    const cache = new Map<string, ConformanceProbes>();
    return (name: string) => {
      let inputs = cache.get(name);
      if (!inputs) {
        inputs =
          shared && Object.hasOwn(shared, name)
            ? mergeConformanceInputs(shared[name]!, localFor(name))
            : localFor(name);
        cache.set(name, inputs);
      }
      return inputs;
    };
  }, [shared, localFor]);
}
