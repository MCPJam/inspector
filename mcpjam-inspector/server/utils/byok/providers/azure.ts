import { listConfiguredModels } from "../configured-list.js";
import { explicitNativeIdRequired } from "../native-id-table.js";
import type { ByokProviderAdapter } from "../types.js";

/**
 * Azure OpenAI requests name a DEPLOYMENT, which the admin created and named
 * on their resource: `gpt-5.1` is a base model, and a deployment of it can be
 * called anything. So there is no canonical → native mapping to review, and
 * the static `azure/gpt-5.1` ids name no deployment at all. The deployment
 * names come from the connection (`modelIds` on the org's Azure provider) and
 * ride on the saved selection as `nativeModelId`.
 */
export const azureAdapter: ByokProviderAdapter = {
  providerKey: "azure",
  listEndpoint: null,
  async listModels(connection, deps) {
    return listConfiguredModels(connection, deps);
  },
  toNativeId: () =>
    explicitNativeIdRequired("Azure OpenAI", "deployment names"),
  toCanonicalId: () => undefined,
};
