import { listConfiguredModels } from "../configured-list.js";
import { explicitNativeIdRequired } from "../native-id-table.js";
import type { ByokProviderAdapter } from "../types.js";

/**
 * Amazon Bedrock access is granted per AWS account and region, and requests
 * name a model id or a cross-region inference profile
 * (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`). The org lists the ids it
 * has access to (`selectedModels`); those are the native ids, carried on the
 * saved selection as `nativeModelId`.
 */
export const bedrockAdapter: ByokProviderAdapter = {
  providerKey: "bedrock",
  listEndpoint: null,
  async listModels(connection, deps) {
    return listConfiguredModels(connection, deps);
  },
  toNativeId: () =>
    explicitNativeIdRequired(
      "Amazon Bedrock",
      "model or inference profile ids",
    ),
  toCanonicalId: () => undefined,
};
