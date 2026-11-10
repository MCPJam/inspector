export { OPENAI_NATIVE_MODEL_IDS as OPENAI_NATIVE_IDS } from "@mcpjam/sdk/model-factory";
import { OPENAI_NATIVE_MODEL_IDS } from "@mcpjam/sdk/model-factory";
import {
  getProviderJson,
  isRecord,
  malformed,
  missingCredentials,
  readString,
} from "../list-request.js";
import {
  createNativeIdTable,
} from "../native-id-table.js";
import type { ByokListedModel, ByokProviderAdapter } from "../types.js";

const LABEL = "OpenAI";
const LIST_URL = "https://api.openai.com/v1/models";
const ENDPOINT = "GET /v1/models";


const table = createNativeIdTable(LABEL, OPENAI_NATIVE_MODEL_IDS);

export const openaiAdapter: ByokProviderAdapter = {
  providerKey: "openai",
  listEndpoint: LIST_URL,
  async listModels(connection, deps = {}) {
    const apiKey = connection.apiKey?.trim();
    if (!apiKey) return missingCredentials(LABEL);
    const result = await getProviderJson(
      LABEL,
      LIST_URL,
      ENDPOINT,
      { Authorization: `Bearer ${apiKey}` },
      deps,
    );
    if (!result.ok) return result.failure;
    // { object: "list", data: [{ id, object: "model", created, owned_by }] }
    const data = isRecord(result.body) ? result.body.data : undefined;
    if (!Array.isArray(data)) return malformed(LABEL, ENDPOINT);
    const models: ByokListedModel[] = [];
    for (const entry of data) {
      if (!isRecord(entry)) continue;
      const nativeId = readString(entry, "id");
      if (!nativeId) continue;
      const canonicalId = table.toCanonicalId(nativeId);
      models.push({ nativeId, ...(canonicalId ? { canonicalId } : {}) });
    }
    return {
      ok: true,
      source: "provider-list",
      models,
      complete: true,
      observedAt: (deps.now ?? Date.now)(),
    };
  },
  toNativeId: table.toNativeId,
  toCanonicalId: table.toCanonicalId,
};
