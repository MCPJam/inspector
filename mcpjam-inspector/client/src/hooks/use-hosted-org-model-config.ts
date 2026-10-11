import { useMemo } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import type { OrgVisibleConfig } from "@/components/chat-v2/shared/model-helpers";
import { orgRequiresOwnKeys } from "@/shared/org-ai-key-policy";

/**
 * The org model config a picker composes from: providers, plus the
 * organization's AI key policy and readiness (present even when `providers`
 * is empty), `unresolved` for a project no organization owns, and `pending`
 * while a query this hook needs has not answered yet.
 */
export type HostedOrgModelConfig = OrgVisibleConfig;

/**
 * Returned while a needed query is still in flight. It carries no providers
 * and no policy, and `composeAvailableModels` locks every row for it, so no
 * hosted model becomes a usable default before the policy is known. Callers
 * that only want a loaded config read it through {@link loadedOrgModelConfig}.
 */
export const PENDING_ORG_MODEL_CONFIG: HostedOrgModelConfig = Object.freeze({
  providers: [],
  pending: true,
}) as HostedOrgModelConfig;

/** `undefined` while the config is loading (`pending`), else the config. */
export function loadedOrgModelConfig<T extends OrgVisibleConfig>(
  config: T | null | undefined,
): T | undefined {
  return config && !config.pending ? config : undefined;
}

/**
 * Merge the project-scoped and org-wide answers. The project answer is the
 * authority on the policy (it names the organization that owns the project's
 * data); the org-wide answer only lends providers when the project answer
 * lists none (an older backend answered per-project with an empty list).
 */
export function mergeHostedOrgModelConfig(
  projectConfig: OrgVisibleConfig | null | undefined,
  organizationConfig: OrgVisibleConfig | null | undefined,
): OrgVisibleConfig | undefined {
  if (projectConfig?.unresolved) {
    // No organization owns this project, so no organization's policy or
    // providers apply to it. Never fall back to another organization's
    // providers.
    return projectConfig;
  }
  if (projectConfig && projectConfig.providers.length > 0) {
    return projectConfig;
  }
  if (!organizationConfig) return projectConfig ?? undefined;
  if (!projectConfig) return organizationConfig;
  if (!projectConfig.aiKeyPolicy && !projectConfig.aiReadiness) {
    return organizationConfig;
  }
  return {
    ...organizationConfig,
    ...(projectConfig.aiKeyPolicy
      ? { aiKeyPolicy: projectConfig.aiKeyPolicy }
      : {}),
    ...(projectConfig.aiReadiness
      ? { aiReadiness: projectConfig.aiReadiness }
      : {}),
  };
}

export function useHostedOrgModelConfig({
  projectId,
  organizationId,
  disabled = false,
}: {
  projectId?: string | null;
  organizationId?: string | null;
  /**
   * Skip both org/project-scoped config queries entirely.
   *
   * Scenario share-link viewers are authenticated as anonymous guests but hold
   * NO membership in the host's project. `getVisibleConfigForProject` is gated
   * by `requireProjectRole`, so it throws "Not a member of this project" for
   * them — and with no route-level ErrorBoundary that Convex error takes down
   * the whole page. The scenario already resolves its model server-side from the
   * scenario row (surfaced as `executionConfig.modelId`), so this config is
   * unused on that surface anyway. Scenario callers pass `disabled: true`.
   */
  disabled?: boolean;
}): HostedOrgModelConfig | undefined {
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const hasScope = !disabled && (!!projectId || !!organizationId);
  // Signed in (or still finding out), but the policy cannot be read yet: the
  // sign-in is resolving, the user row is still being set up, or reads are
  // paused while the session recovers.
  const policyUnreadable =
    hasScope && (isAuthLoading || (isAuthenticated && !isUserReady));
  const shouldQuery = isAuthenticated && isUserReady && !disabled;
  const queriesProject = shouldQuery && !!projectId;
  const queriesOrganization = shouldQuery && !!organizationId;

  const projectConfig = useQuery(
    "organizationModelProviders:getVisibleConfigForProject" as any,
    queriesProject ? ({ projectId } as any) : "skip"
  ) as HostedOrgModelConfig | null | undefined;

  const organizationConfig = useQuery(
    "organizationModelProviders:getVisibleConfig" as any,
    queriesOrganization ? ({ organizationId } as any) : "skip"
  ) as HostedOrgModelConfig | null | undefined;

  return useMemo(() => {
    // Rows stay locked until the policy can be read and has answered.
    if (policyUnreadable) return PENDING_ORG_MODEL_CONFIG;
    // No scope to read a policy for (signed out, a scenario, no project or
    // organization): today's behavior, `undefined`.
    if (!shouldQuery || (!queriesProject && !queriesOrganization)) {
      return undefined;
    }
    const projectAnswered = !queriesProject || projectConfig !== undefined;
    const organizationAnswered =
      !queriesOrganization || organizationConfig !== undefined;
    // A policy that is ON wins as soon as either answer carries it (fail
    // closed): waiting for the other answer, or a fallback built from it,
    // could otherwise offer a hosted default for a moment.
    const requiringAnswer = orgRequiresOwnKeys(projectConfig)
      ? projectConfig
      : orgRequiresOwnKeys(organizationConfig)
        ? organizationConfig
        : undefined;
    if (requiringAnswer) {
      const merged =
        mergeHostedOrgModelConfig(projectConfig, organizationConfig) ??
        requiringAnswer;
      return orgRequiresOwnKeys(merged)
        ? merged
        : {
            ...merged,
            aiKeyPolicy: requiringAnswer.aiKeyPolicy,
            aiReadiness: requiringAnswer.aiReadiness,
          };
    }
    if (queriesProject && !projectAnswered) {
      // The project answer is the authority on the policy. Until it arrives,
      // an org-wide answer that already carries a policy (off, here) stands in
      // for the same organization; anything else waits.
      if (organizationConfig?.aiKeyPolicy) return organizationConfig;
      return PENDING_ORG_MODEL_CONFIG;
    }
    if (!organizationAnswered) {
      // The project answered without providers and with no policy of its own
      // (an older backend): today's fallback needs the org-wide answer.
      if (
        projectConfig &&
        (projectConfig.providers.length > 0 ||
          projectConfig.unresolved ||
          projectConfig.aiKeyPolicy)
      ) {
        return projectConfig;
      }
      return PENDING_ORG_MODEL_CONFIG;
    }
    return mergeHostedOrgModelConfig(projectConfig, organizationConfig);
  }, [
    organizationConfig,
    policyUnreadable,
    projectConfig,
    queriesOrganization,
    queriesProject,
    shouldQuery,
  ]);
}
