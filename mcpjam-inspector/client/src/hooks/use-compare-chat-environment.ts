import { useMemo } from "react";
import { usePlaygroundHiddenEnvironment } from "./use-playground-hidden-environment";
import type { HostedRuntimeContext } from "@/lib/hosted-runtime-context";

/** Each compare lane composes only the plugins its own client can run. */
export function useCompareChatEnvironment({
  hostedContext,
  harnessId,
  hostResolved,
}: {
  hostedContext?: HostedRuntimeContext;
  harnessId?: string | null;
  hostResolved: boolean;
}) {
  const hiddenEnvironment = usePlaygroundHiddenEnvironment({
    projectId: hostedContext?.projectId ?? null,
    hostId: hostedContext?.hostId ?? null,
    eligible:
      !hostedContext?.executionTarget &&
      !hostedContext?.scenarioId,
    harnessId: harnessId,
    hostResolved: hostResolved,
  });
  const columnHostedContext = useMemo(
    () => ({
      ...hostedContext,
      ...(hiddenEnvironment.wanted || hiddenEnvironment.blockingError
        ? {
            hiddenEnvironment: {
              environmentId: hiddenEnvironment.environmentId,
              pluginServerIds: hiddenEnvironment.pluginServerIds,
              venue: hiddenEnvironment.venue,
              recover: hiddenEnvironment.recover,
              blockingError: hiddenEnvironment.blockingError,
            },
          }
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
