import {
  convexGetEnvironmentSecretSelection,
  convexListProjectSecretBindings,
  type ProjectSecretBinding,
} from "../computers/convex-secrets-client.js";

/**
 * Whether the environment selects a caller-visible secret delivered this way.
 * Metadata only: no secret value is fetched. A failed read throws; it is never
 * taken for an empty selection.
 */
export async function environmentSelectsSecretDelivery(
  bearer: string,
  args: { projectId: string; environmentId: string },
  delivery: ProjectSecretBinding["delivery"],
): Promise<boolean> {
  const [bindings, selected] = await Promise.all([
    convexListProjectSecretBindings(bearer, { projectId: args.projectId }),
    convexGetEnvironmentSecretSelection(bearer, args),
  ]);
  return bindings.some(
    (binding) =>
      binding.delivery === delivery && selected.includes(binding.secretId),
  );
}
