import {
  getProviderJson,
  isRecord,
  malformed,
  missingCredentials,
  readString,
} from "../list-request.js";
import {
  createNativeIdTable,
  type NativeIdMapping,
} from "../native-id-table.js";
import type { ByokListedModel, ByokProviderAdapter } from "../types.js";

const LABEL = "OpenAI";
const LIST_URL = "https://api.openai.com/v1/models";
const ENDPOINT = "GET /v1/models";

// Every row here is a `SUPPORTED_MODELS` OpenAI row: `createLlmModel`
// (server/utils/chat-helpers.ts) sends that id verbatim to api.openai.com, and
// OpenAI's `GET /v1/models` lists models under the same ids. The canonical id
// is the hosted catalog's spelling (shared/hosted-model-ids.generated.ts).
const VERBATIM =
  "SUPPORTED_MODELS row sent verbatim to api.openai.com by createLlmModel; listed under this id by GET /v1/models";
const HOSTED = `${VERBATIM}; canonical spelling from hosted-model-ids.generated.ts`;

export const OPENAI_NATIVE_IDS: readonly NativeIdMapping[] = [
  {
    canonicalId: "openai/gpt-5.6-luna",
    nativeId: "gpt-5.6-luna",
    evidence: HOSTED,
  },
  {
    canonicalId: "openai/gpt-5.6-sol",
    nativeId: "gpt-5.6-sol",
    evidence: HOSTED,
  },
  {
    canonicalId: "openai/gpt-5.6-terra",
    nativeId: "gpt-5.6-terra",
    evidence: HOSTED,
  },
  // Not in the hosted catalog (it lists gpt-5.1-instant / -thinking instead);
  // the canonical id follows the `openai/<native>` spelling of its siblings.
  { canonicalId: "openai/gpt-5.1", nativeId: "gpt-5.1", evidence: VERBATIM },
  {
    canonicalId: "openai/gpt-5.1-codex",
    nativeId: "gpt-5.1-codex",
    evidence: HOSTED,
  },
  {
    canonicalId: "openai/gpt-5.1-codex-mini",
    nativeId: "gpt-5.1-codex-mini",
    evidence: HOSTED,
  },
  { canonicalId: "openai/gpt-5", nativeId: "gpt-5", evidence: HOSTED },
  {
    canonicalId: "openai/gpt-5-mini",
    nativeId: "gpt-5-mini",
    evidence: HOSTED,
  },
  {
    canonicalId: "openai/gpt-5-nano",
    nativeId: "gpt-5-nano",
    evidence: HOSTED,
  },
  { canonicalId: "openai/gpt-5-pro", nativeId: "gpt-5-pro", evidence: HOSTED },
  {
    canonicalId: "openai/gpt-5-codex",
    nativeId: "gpt-5-codex",
    evidence: HOSTED,
  },
  { canonicalId: "openai/gpt-4.1", nativeId: "gpt-4.1", evidence: HOSTED },
  {
    canonicalId: "openai/gpt-4.1-mini",
    nativeId: "gpt-4.1-mini",
    evidence: HOSTED,
  },
  {
    canonicalId: "openai/gpt-4.1-nano",
    nativeId: "gpt-4.1-nano",
    evidence: HOSTED,
  },
  { canonicalId: "openai/gpt-4o", nativeId: "gpt-4o", evidence: HOSTED },
  {
    canonicalId: "openai/gpt-4o-mini",
    nativeId: "gpt-4o-mini",
    evidence: HOSTED,
  },
];

const table = createNativeIdTable(LABEL, OPENAI_NATIVE_IDS);

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
