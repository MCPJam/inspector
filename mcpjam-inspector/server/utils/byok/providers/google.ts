import {
  getProviderJson,
  isRecord,
  malformed,
  missingCredentials,
  readPositiveInt,
  readString,
} from "../list-request.js";
import {
  createNativeIdTable,
  type NativeIdMapping,
} from "../native-id-table.js";
import type { ByokListedModel, ByokProviderAdapter } from "../types.js";

const LABEL = "Google";
const LIST_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const ENDPOINT = "GET /v1beta/models";
const PAGE_SIZE = 1000;
const MAX_PAGES = 10;
/**
 * The Gemini API names a model by the resource name `models/{model}`; the
 * model id requests take (and the AI SDK's `google(...)` factory takes) is the
 * `{model}` segment. This parses Google's resource name, it does not map a
 * canonical id.
 */
const RESOURCE_PREFIX = "models/";

// Every native id is a `SUPPORTED_MODELS` Google row that `createLlmModel`
// (server/utils/chat-helpers.ts) sends verbatim to the Gemini API.
const VERBATIM =
  "SUPPORTED_MODELS row sent verbatim to the Gemini API by createLlmModel";
const HOSTED = `${VERBATIM}; canonical spelling from hosted-model-ids.generated.ts`;

export const GOOGLE_NATIVE_IDS: readonly NativeIdMapping[] = [
  {
    canonicalId: "google/gemini-2.5-pro",
    nativeId: "gemini-2.5-pro",
    evidence: HOSTED,
  },
  {
    canonicalId: "google/gemini-2.5-flash",
    nativeId: "gemini-2.5-flash",
    evidence: HOSTED,
  },
  // Not in the hosted catalog; canonical spelling follows its siblings.
  {
    canonicalId: "google/gemini-2.0-flash-exp",
    nativeId: "gemini-2.0-flash-exp",
    evidence: VERBATIM,
  },
];

const table = createNativeIdTable(LABEL, GOOGLE_NATIVE_IDS);

export const googleAdapter: ByokProviderAdapter = {
  providerKey: "google",
  listEndpoint: LIST_URL,
  async listModels(connection, deps = {}) {
    const apiKey = connection.apiKey?.trim();
    if (!apiKey) return missingCredentials(LABEL);
    // The key goes in the `x-goog-api-key` header, never the `?key=` query
    // parameter, so no URL this adapter builds carries it.
    const headers = { "x-goog-api-key": apiKey };
    const models: ByokListedModel[] = [];
    let pageToken: string | undefined;
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(LIST_URL);
      url.searchParams.set("pageSize", String(PAGE_SIZE));
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const result = await getProviderJson(
        LABEL,
        url.toString(),
        ENDPOINT,
        headers,
        deps,
      );
      if (!result.ok) return result.failure;
      // { models: [{ name: "models/…", displayName, inputTokenLimit,
      //   supportedGenerationMethods }], nextPageToken }
      const body = result.body;
      if (!isRecord(body)) return malformed(LABEL, ENDPOINT);
      // An account with no models answers `{}`: no `models` field at all.
      const entries = body.models === undefined ? [] : body.models;
      if (!Array.isArray(entries)) return malformed(LABEL, ENDPOINT);
      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        const name = readString(entry, "name");
        if (!name?.startsWith(RESOURCE_PREFIX)) continue;
        // Only models a chat can call: embedding / AQA models list other
        // generation methods.
        const methods = entry.supportedGenerationMethods;
        if (Array.isArray(methods) && !methods.includes("generateContent")) {
          continue;
        }
        const nativeId = name.slice(RESOURCE_PREFIX.length);
        if (!nativeId) continue;
        const canonicalId = table.toCanonicalId(nativeId);
        const displayName = readString(entry, "displayName");
        const contextLength = readPositiveInt(entry, "inputTokenLimit");
        models.push({
          nativeId,
          ...(canonicalId ? { canonicalId } : {}),
          ...(displayName ? { displayName } : {}),
          ...(contextLength ? { contextLength } : {}),
        });
      }
      const next = readString(body, "nextPageToken");
      if (!next) {
        complete = true;
        break;
      }
      if (next === pageToken) break;
      pageToken = next;
    }
    return {
      ok: true,
      source: "provider-list",
      models,
      complete,
      observedAt: (deps.now ?? Date.now)(),
    };
  },
  toNativeId: table.toNativeId,
  toCanonicalId: table.toCanonicalId,
};
