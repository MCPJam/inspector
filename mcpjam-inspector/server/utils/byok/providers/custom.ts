import { listConfiguredModels } from "../configured-list.js";
import { explicitNativeIdRequired } from "../native-id-table.js";
import type { ByokProviderAdapter } from "../types.js";

/**
 * Custom (OpenAI- or Anthropic-compatible) providers serve whatever the admin
 * configured (`modelIds`). Their ids are the native ids, carried on the saved
 * selection as `nativeModelId`.
 */
export const customAdapter: ByokProviderAdapter = {
  providerKey: "custom",
  listEndpoint: null,
  async listModels(connection, deps) {
    return listConfiguredModels(connection, deps);
  },
  toNativeId: () =>
    explicitNativeIdRequired("A custom provider", "its configured model ids"),
  toCanonicalId: () => undefined,
};
