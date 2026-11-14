import type { LanguageModel } from "ai";
import {
  buildOrgModelFromResolvedConfig,
  type OrgProviderResolvedConfig,
} from "@mcpjam/sdk/model-factory";
import { createGuardedFetch } from "./hosted-egress-guard.js";

/**
 * A model on an organization connection this process calls itself (the local
 * runtime). Hosted, the connection's base URL is dialed from a shared network,
 * so every request, each redirect hop included, passes the hosted egress
 * guard; locally the guard is plain fetch.
 */
export function buildGuardedOrgModel(
  provider: OrgProviderResolvedConfig,
  modelId: string,
): LanguageModel {
  return buildOrgModelFromResolvedConfig(provider, modelId, {
    fetch: createGuardedFetch({
      label: `${provider.displayName ?? provider.providerKey} URL`,
    }),
  });
}
