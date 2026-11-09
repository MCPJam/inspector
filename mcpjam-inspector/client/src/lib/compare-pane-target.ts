import type {
  HostedHiddenEnvironment,
  HostedRuntimeContext,
} from "./hosted-runtime-context";
import type {
  EnvironmentOverrides,
  HostedExecutionTarget,
} from "@/shared/execution-target";

export function hiddenPluginContext(
  composition: HostedHiddenEnvironment & { wanted: boolean },
): Pick<HostedRuntimeContext, "hiddenEnvironment"> {
  const {
    wanted,
    blockingError,
    environmentId,
    pluginServerIds,
    venue,
    recover,
  } = composition;
  return wanted || blockingError
    ? {
        hiddenEnvironment: {
          environmentId,
          pluginServerIds,
          venue,
          recover,
          blockingError,
        },
      }
    : {};
}

/** A named setup resolves servers by id on the managed route. Its client is
 * only a presentation cache key; sending it as an execution pointer too is invalid. */
export function buildComparePaneTarget(input: {
  target?: HostedExecutionTarget;
  hostId?: string | null;
  overrides?: EnvironmentOverrides;
  ensureServerIds?: HostedRuntimeContext["ensureServerIds"];
  composition?: HostedHiddenEnvironment & { wanted: boolean };
}): HostedRuntimeContext {
  if (input.target?.kind === "environment") {
    return {
      executionTarget: input.target,
      requiresWebChatApi: true,
      ...(input.hostId ? { presentationHostId: input.hostId } : {}),
      ...(input.overrides ? { environmentOverrides: input.overrides } : {}),
    };
  }
  const hostId = input.target?.hostId ?? input.hostId;
  return {
    ...(hostId ? { hostId } : {}),
    ...(input.ensureServerIds
      ? { ensureServerIds: input.ensureServerIds }
      : {}),
    ...(input.composition ? hiddenPluginContext(input.composition) : {}),
  };
}
