import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import { compactModelLabel } from "@/components/chat-v2/shared/model-helpers";
import { useAvailableModels } from "@/hooks/use-available-models";
import { useHostList } from "@/hooks/useClients";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import { useSandboxImages } from "@/hooks/useSandboxImages";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import type { EnvironmentLabelContext } from "@/lib/environment-label";
import { clientDisplayName } from "@/lib/client-display-name";

/**
 * The name lookups `@/lib/environment-label` needs, fetched once per SURFACE.
 *
 * ## The budget this exists to protect
 *
 * Every field an environment card shows comes from the row that
 * `projectEnvironments:listEnvironments` already returned, plus two project-wide
 * lookups: host names and sandbox-image names. Nothing here triggers a runtime
 * resolve, because a resolve is one round trip PER ENVIRONMENT — an N+1 on a
 * list that re-renders on every visit.
 *
 * That is also why a card never shows a resolved server count. The row stores a
 * `serverAttachmentId` (a scope), not a server set; the real set folds in the
 * host's own picks and any plugin-contributed servers, both LIVE. Printing a
 * number would mean either lying or paying the N+1. The honest count belongs in
 * the Playground, where exactly one environment is resolved for real.
 *
 * ## Why `environments` is a parameter
 *
 * The sandbox-image query is skipped entirely unless a LOADED row actually pins
 * an image. The image name is its only consumer, so firing it for an empty or
 * still-loading list — or for a project whose environments pin nothing — would
 * add a project-wide request that can never render anything. Once a pinned row
 * appears the query starts, and `environmentImageLabel`'s truncated-id fallback
 * covers the frame before it resolves.
 */
export function useEnvironmentLabelContext(
  projectId: string | null,
  environments: ProjectEnvironmentView[] | undefined
): EnvironmentLabelContext {
  const { isAuthenticated } = useConvexAuth();
  // Normalize ONCE and feed every hook the same value: `useProjectEnvironments`
  // trims internally, so a whitespace-padded id still renders rows while
  // `useHostList` would key off the raw string and leave every row labeled
  // "Unknown client".
  const normalizedProjectId = projectId?.trim() || null;
  const { hosts } = useHostList({
    isAuthenticated,
    projectId: normalizedProjectId,
    // A LOOKUP, not a picker: this builds the hostId → name map every
    // environment label falls back to, and an ad-hoc environment's client is
    // often a private scenario-backing one. Filtering it out here would label
    // those rows "Unknown client" — hiding a name, not a choice.
    includePrivateBacking: true,
  });
  const computersEnabled = useComputersEnabled();
  const hasPinnedImage = (environments ?? []).some(
    (environment) => environment.computerEnvironmentId
  );
  const hasModelOverride = (environments ?? []).some(
    (environment) => environment.modelId
  );
  const sandboxImages = useSandboxImages(
    computersEnabled && hasPinnedImage ? normalizedProjectId : null
  );
  // Query-budget: only pay for the catalog when a loaded row actually
  // carries a model override. Passing no projectId still resolves the
  // active-project catalog, so skip the hook's project scope unless needed.
  const { availableModels } = useAvailableModels(
    hasModelOverride ? { projectId: normalizedProjectId } : { projectId: null }
  );

  const hostNamesById = useMemo(
    () => new Map(hosts.map((host) => [host.hostId, clientDisplayName(host)])),
    [hosts]
  );
  const imageNamesById = useMemo(
    () =>
      new Map(
        (sandboxImages ?? []).map((img) => [img.environmentId, img.name])
      ),
    [sandboxImages]
  );
  const modelNamesById = useMemo(() => {
    if (!hasModelOverride) return undefined;
    return new Map(
      availableModels.map((model) => [
        String(model.id),
        compactModelLabel(model.name) || String(model.id),
      ])
    );
  }, [availableModels, hasModelOverride]);

  return useMemo(
    () => ({
      hostName: (hostId: string) => hostNamesById.get(hostId),
      imageName: (imageId: string) => imageNamesById.get(imageId),
      computersEnabled,
      ...(modelNamesById
        ? { modelName: (modelId: string) => modelNamesById.get(modelId) }
        : {}),
    }),
    [hostNamesById, imageNamesById, computersEnabled, modelNamesById]
  );
}
