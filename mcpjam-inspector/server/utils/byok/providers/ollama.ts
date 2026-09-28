import {
  getProviderJson,
  isRecord,
  malformed,
  readString,
  trimTrailingSlashes,
} from "../list-request.js";
import { explicitNativeIdRequired } from "../native-id-table.js";
import type { ByokListedModel, ByokProviderAdapter } from "../types.js";

const LABEL = "Ollama";
const DEFAULT_HOST = "http://127.0.0.1:11434";
const ENDPOINT = "GET /api/tags";

/**
 * The Ollama host root for a configured base URL. Connections store it in
 * three shapes: the inspector's `http://host:11434/api` (native API), the org
 * config's OpenAI-compatible `https://host/v1`, and a bare host. `/api/tags`
 * lives on the root in every case.
 */
export function ollamaHostRoot(baseUrl: string | undefined): string {
  const trimmed = trimTrailingSlashes(baseUrl ?? "");
  if (!trimmed) return DEFAULT_HOST;
  return trimTrailingSlashes(trimmed.replace(/\/(api|v1)$/i, ""));
}

export const ollamaAdapter: ByokProviderAdapter = {
  providerKey: "ollama",
  listEndpoint: `${DEFAULT_HOST}/api/tags`,
  async listModels(connection, deps = {}) {
    const url = `${ollamaHostRoot(connection.baseUrl)}/api/tags`;
    // Ollama has no key of its own; a proxy in front of it may want one.
    const apiKey = connection.apiKey?.trim();
    const result = await getProviderJson(
      LABEL,
      url,
      ENDPOINT,
      apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      deps,
    );
    if (!result.ok) return result.failure;
    // { models: [{ name: "llama3.2:latest", model, modified_at, size, ... }] }
    const entries = isRecord(result.body) ? result.body.models : undefined;
    if (!Array.isArray(entries)) return malformed(LABEL, ENDPOINT);
    const models: ByokListedModel[] = [];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      // `model` is the tag requests take; older servers only send `name`.
      const nativeId = readString(entry, "model") ?? readString(entry, "name");
      if (!nativeId) continue;
      models.push({ nativeId });
    }
    return {
      ok: true,
      source: "provider-list",
      models,
      complete: true,
      observedAt: (deps.now ?? Date.now)(),
    };
  },
  // Ollama models are local tags with no canonical twin: a selection of one
  // carries the tag as `nativeModelId`.
  toNativeId: () => explicitNativeIdRequired(LABEL, "local model tags"),
  toCanonicalId: () => undefined,
};
