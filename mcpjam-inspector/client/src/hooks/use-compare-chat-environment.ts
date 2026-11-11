import { hiddenPluginContext } from "@/lib/compare-pane-target";
import { useMemo } from "react";
import { usePlaygroundHiddenEnvironment } from "./use-playground-hidden-environment";
import type { HostedRuntimeContext } from "@/lib/hosted-runtime-context";

/** Each compare lane composes only the plugins its own client can run. */
export function useCompareChatEnvironment({
  hostedContext,
  harnessId,
  hostResolved,
  computerAttached,
}: {
  hostedContext?: HostedRuntimeContext;
  harnessId?: string | null;
  hostResolved: boolean;
  computerAttached?: boolean;
}) {
  const hiddenEnvironment = usePlaygroundHiddenEnvironment({
    projectId: hostedContext?.projectId ?? null,
    hostId: hostedContext?.hostId ?? null,
    eligible:
      !hostedContext?.executionTarget &&
      !hostedContext?.scenarioId,
    harnessId: harnessId,
    hostResolved: hostResolved,
    computerAttached,
  });
  const columnHostedContext = useMemo(
    () => ({
      ...hostedContext,
      ...(!hostedContext?.executionTarget && !hostedContext?.scenarioId
        ? hiddenPluginContext(hiddenEnvironment)
        : {}),
    }),
    [
      hostedContext,
      hiddenEnvironment.wanted,
      hiddenEnvironment.blockingError,
      hiddenEnvironment.environmentId,
      hiddenEnvironment.pluginServerIds,
      hiddenEnvironment.venue,
      hiddenEnvironment.recover,
    ],
  );
  return { hiddenEnvironment, columnHostedContext };
}
