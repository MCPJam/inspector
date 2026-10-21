/**
 * Azure OpenAI runs a model only through a deployment an admin created on the
 * resource and named. The name can be anything, so a catalog id such as
 * `azure/gpt-5.1` names no deployment, and one is never derived by stripping
 * the prefix: `gpt-5.1` is the base model, not a deployment of it.
 *
 * The backend refuses an org selection that names no deployment before it
 * calls Azure, with the same rule as {@link azureDeploymentName}. The
 * Inspector applies it earlier, in the picker, the eval preflight and the
 * runner, so such a selection is never offered or launched.
 */

/** Provider key of Azure OpenAI, on a model row and an org connection. */
export const AZURE_PROVIDER_KEY = "azure";

/**
 * The deployment a selection names: its native id, else a bare model id (no
 * `/`). `undefined` when neither.
 */
export function azureDeploymentName(selection: {
  modelId: string;
  nativeModelId?: string;
}): string | undefined {
  const explicit = selection.nativeModelId?.trim();
  if (explicit) return explicit;
  const bare = selection.modelId.trim();
  return bare && !bare.includes("/") ? bare : undefined;
}

/** Why an Azure model row with no deployment can't be picked. */
export const AZURE_DEPLOYMENT_REQUIRED_REASON =
  "This model has no Azure deployment. Add a deployment name in Organization → AI providers.";

/** Why a saved selection of `model` with no Azure deployment can't run. */
export function azureDeploymentMissingReason(model: string): string {
  return `${model} has no Azure deployment. Pick a deployment for it, or add one in Organization → AI providers.`;
}
