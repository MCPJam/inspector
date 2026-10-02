import { ANTHROPIC_NATIVE_MODEL_IDS } from "@mcpjam/sdk/model-factory";
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

const LABEL = "Anthropic";
const LIST_URL = "https://api.anthropic.com/v1/models";
const ENDPOINT = "GET /v1/models";
/** Anthropic's documented `anthropic-version` header value. */
const ANTHROPIC_VERSION = "2023-06-01";
/** Page size cap documented for the list endpoint. */
const PAGE_LIMIT = 1000;
/** Stop after this many pages; a real account lists far fewer models. */
const MAX_PAGES = 10;

// Anthropic native ids are dashed aliases (`claude-sonnet-4-5`); the canonical
// ids are the hosted catalog's dotted spelling (`anthropic/claude-sonnet-4.5`).
// The two differ by more than a prefix, which is why this is a table. The
// reviewed rows live in the SDK, which sends the native id on its own BYOK
// Anthropic path: one table, so the model list this adapter reports and the id
// an SDK eval sends cannot disagree.
export const ANTHROPIC_NATIVE_IDS: readonly NativeIdMapping[] =
  ANTHROPIC_NATIVE_MODEL_IDS;

const table = createNativeIdTable(LABEL, ANTHROPIC_NATIVE_IDS);

export const anthropicAdapter: ByokProviderAdapter = {
  providerKey: "anthropic",
  listEndpoint: LIST_URL,
  async listModels(connection, deps = {}) {
    const apiKey = connection.apiKey?.trim();
    if (!apiKey) return missingCredentials(LABEL);
    const headers = {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
    const models: ByokListedModel[] = [];
    let afterId: string | undefined;
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(LIST_URL);
      url.searchParams.set("limit", String(PAGE_LIMIT));
      if (afterId) url.searchParams.set("after_id", afterId);
      const result = await getProviderJson(
        LABEL,
        url.toString(),
        ENDPOINT,
        headers,
        deps,
      );
      if (!result.ok) return result.failure;
      // { data: [{ type: "model", id, display_name, created_at }],
      //   has_more, first_id, last_id }
      const body = result.body;
      if (!isRecord(body) || !Array.isArray(body.data)) {
        return malformed(LABEL, ENDPOINT);
      }
      for (const entry of body.data) {
        if (!isRecord(entry)) continue;
        const nativeId = readString(entry, "id");
        if (!nativeId) continue;
        const canonicalId = table.toCanonicalId(nativeId);
        const displayName = readString(entry, "display_name");
        models.push({
          nativeId,
          ...(canonicalId ? { canonicalId } : {}),
          ...(displayName ? { displayName } : {}),
        });
      }
      const lastId = readString(body, "last_id");
      if (body.has_more !== true) {
        complete = true;
        break;
      }
      if (!lastId || lastId === afterId) break;
      afterId = lastId;
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
  // Anthropic names a snapshot `<alias>-<YYYYMMDD>` (models overview), and the
  // list endpoint may report only the snapshot. This only says the alias is
  // still served; it never produces a request id.
  isSnapshotOf(listedId, aliasId) {
    return (
      listedId.length === aliasId.length + 9 &&
      listedId.startsWith(`${aliasId}-`) &&
      /^\d{8}$/.test(listedId.slice(aliasId.length + 1))
    );
  },
};
