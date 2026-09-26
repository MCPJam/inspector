import { useProjectEnvironmentCapability } from "@/hooks/use-project-environment-capability";

/**
 * One-shot probe of `projectEnvironments:getCapabilities.modelMatrix`.
 *
 * Lives in its own module so tests that mock `@/hooks/useProjectEnvironments`
 * do not have to list this export — a missing named export on that mock
 * would otherwise crash every composer consumer (swarm, User Testing).
 *
 * `convex/react`'s `useQuery` throws during render on a missing function, so
 * this MUST go through `useConvex().query(...)` in an effect and catch
 * `/could not find public function/i` — the same probe as `isAdhocUnavailable`.
 *
 * Returns:
 *  - `undefined` while probing (hide the models slot)
 *  - `true` when the backend advertises the matrix
 *  - `false` on skew or any other failure (hide the slot; resolver must
 *    refuse to send `modelId`)
 */
export function useModelMatrixCapability(
  projectId: string | null | undefined
): boolean | undefined {
  return useProjectEnvironmentCapability(projectId, "modelMatrix");
}
