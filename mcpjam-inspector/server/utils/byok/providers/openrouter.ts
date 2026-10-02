import {
  getProviderJson,
  isRecord,
  malformed,
  readPositiveInt,
  readString,
} from "../list-request.js";
import type {
  ByokListedModel,
  ByokProviderAdapter,
  NativeIdResult,
} from "../types.js";

const LABEL = "OpenRouter";
const LIST_URL = "https://openrouter.ai/api/v1/models";
const ENDPOINT = "GET /api/v1/models";

/**
 * OpenRouter's mapping table has one row, and it is the identity: MCPJam's
 * canonical ids ARE OpenRouter's spellings (`x-ai/`, `z-ai/`, `meta-llama/`,
 * `mistralai/`, `qwen/`; the Gateway spellings `xai/`, `zai/`, `meta/`,
 * `mistral/`, `alibaba/` only ever appear on the Gateway wire), and an org's
 * OpenRouter `selectedModels` are sent to OpenRouter verbatim
 * (`createLlmModel`, backend `buildOrgModel`). Nothing is stripped or added.
 *
 * Whether OpenRouter serves a given id is the list's question, not this
 * mapping's: an id is only identity-mapped when it has the `vendor/model`
 * shape OpenRouter ids have.
 */
export const OPENROUTER_NATIVE_ID_RULE = {
  kind: "identity",
  evidence:
    "canonical ids use OpenRouter's vendor spellings; selectedModels are sent verbatim by createLlmModel and backend buildOrgModel",
} as const;

const OPENROUTER_ID = /^[a-z0-9][a-z0-9._-]*\/[^\s/][^\s]*$/;

function toNativeId(canonicalId: string): NativeIdResult {
  const id = canonicalId.trim();
  if (!OPENROUTER_ID.test(id)) {
    return {
      ok: false,
      code: "unmapped",
      reason: `${canonicalId} is not a vendor/model id`,
    };
  }
  return {
    ok: true,
    nativeId: id,
    evidence: OPENROUTER_NATIVE_ID_RULE.evidence,
  };
}

export const openrouterAdapter: ByokProviderAdapter = {
  providerKey: "openrouter",
  listEndpoint: LIST_URL,
  async listModels(connection, deps = {}) {
    // The list endpoint is public; the key, when there is one, is sent so an
    // account-scoped answer is possible, never required.
    const apiKey = connection.apiKey?.trim();
    const result = await getProviderJson(
      LABEL,
      LIST_URL,
      ENDPOINT,
      apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      deps,
    );
    if (!result.ok) return result.failure;
    // { data: [{ id, name, context_length, supported_parameters, ... }] }
    const data = isRecord(result.body) ? result.body.data : undefined;
    if (!Array.isArray(data)) return malformed(LABEL, ENDPOINT);
    const models: ByokListedModel[] = [];
    for (const entry of data) {
      if (!isRecord(entry)) continue;
      const nativeId = readString(entry, "id");
      if (!nativeId) continue;
      const mapped = toNativeId(nativeId);
      const displayName = readString(entry, "name");
      const contextLength = readPositiveInt(entry, "context_length");
      models.push({
        nativeId,
        ...(mapped.ok ? { canonicalId: nativeId } : {}),
        ...(displayName ? { displayName } : {}),
        ...(contextLength ? { contextLength } : {}),
      });
    }
    return {
      ok: true,
      source: "provider-list",
      models,
      complete: true,
      observedAt: (deps.now ?? Date.now)(),
    };
  },
  toNativeId,
  toCanonicalId(nativeId) {
    const mapped = toNativeId(nativeId);
    return mapped.ok ? mapped.nativeId : undefined;
  },
};
