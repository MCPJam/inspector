/**
 * Reviewed canonical ↔ native model id pairs, for providers whose API does not
 * accept the canonical spelling.
 *
 * A CANONICAL id is the hosted catalog's `provider/model` spelling — the one
 * `list_models`, the model picker and suite files hand out
 * (`anthropic/claude-sonnet-4.5`). A NATIVE id is what the provider's own API
 * is called with (`claude-sonnet-4-5`). For Anthropic the two differ by more
 * than a prefix — dotted versus dashed — so a BYOK run that sent the canonical
 * model part verbatim reached `api.anthropic.com` with an id it does not serve.
 * Only a reviewed table can map them: deriving one from the other by string
 * surgery would be a guess that looks right until it is not.
 *
 * PURE and browser-safe. The Inspector server's BYOK Anthropic adapter reads
 * the same rows through `@mcpjam/sdk/model-factory`, so the model list the
 * Inspector shows and the id the SDK sends cannot disagree.
 */

/** One reviewed canonical ↔ native pair. */
export type NativeModelIdMapping = {
  /** Canonical `provider/model` id. */
  canonicalId: string;
  /** The id the provider API is called with. */
  nativeId: string;
  /**
   * Other native spellings the provider's list endpoint reports for the same
   * model (e.g. a dated snapshot of an alias). Reverse lookup only; requests
   * use `nativeId`.
   */
  nativeAliases?: readonly string[];
  /** Why the pair is right: where the native id is documented or used. */
  evidence: string;
};

// Every native id below is a `SUPPORTED_MODELS` row that the Inspector's
// `createLlmModel` (server/utils/chat-helpers.ts) sends verbatim to
// api.anthropic.com.
const VERBATIM =
  "SUPPORTED_MODELS row sent verbatim to api.anthropic.com by createLlmModel";
const HOSTED = `${VERBATIM}; canonical spelling from hosted-model-ids.generated.ts`;

/** Anthropic's reviewed table. Canonical ids are dotted, native ids dashed. */
export const ANTHROPIC_NATIVE_MODEL_IDS: readonly NativeModelIdMapping[] =
  Object.freeze([
    {
      canonicalId: "anthropic/claude-fable-5",
      nativeId: "claude-fable-5",
      evidence: HOSTED,
    },
    // Not in the hosted catalog; canonical spelling follows claude-sonnet-5.
    {
      canonicalId: "anthropic/claude-opus-5",
      nativeId: "claude-opus-5",
      evidence: VERBATIM,
    },
    {
      canonicalId: "anthropic/claude-sonnet-5",
      nativeId: "claude-sonnet-5",
      evidence: HOSTED,
    },
    {
      canonicalId: "anthropic/claude-opus-4.8",
      nativeId: "claude-opus-4-8",
      evidence: HOSTED,
    },
    {
      canonicalId: "anthropic/claude-opus-4.7",
      nativeId: "claude-opus-4-7",
      evidence: HOSTED,
    },
    {
      canonicalId: "anthropic/claude-opus-4.6",
      nativeId: "claude-opus-4-6",
      evidence: HOSTED,
    },
    {
      canonicalId: "anthropic/claude-sonnet-4.6",
      nativeId: "claude-sonnet-4-6",
      evidence: HOSTED,
    },
    {
      canonicalId: "anthropic/claude-sonnet-4.5",
      nativeId: "claude-sonnet-4-5",
      // The dated snapshot the alias points at, as GET /v1/models lists it.
      nativeAliases: ["claude-sonnet-4-5-20250929"],
      evidence: `${HOSTED}; snapshot id from Anthropic's models overview`,
    },
    {
      canonicalId: "anthropic/claude-haiku-4.5",
      nativeId: "claude-haiku-4-5",
      nativeAliases: ["claude-haiku-4-5-20251001"],
      evidence: `${HOSTED}; snapshot id from Anthropic's models overview`,
    },
  ]);

/**
 * canonical id → row, built once and checked on the way.
 *
 * The checks are the ones the server's `createNativeIdTable` makes, repeated
 * here because this module is what every importer loads: a bad edit (a
 * canonical id listed twice, one native id claimed by two canonical ids) fails
 * every test that touches the table instead of mapping one of them silently.
 */
function indexByCanonicalId(
  providerLabel: string,
  rows: readonly NativeModelIdMapping[]
): ReadonlyMap<string, NativeModelIdMapping> {
  const byCanonical = new Map<string, NativeModelIdMapping>();
  const nativeOwner = new Map<string, string>();
  for (const row of rows) {
    if (!row.evidence.trim()) {
      throw new Error(
        `${providerLabel} native model id table: ${row.canonicalId} has no evidence`
      );
    }
    if (byCanonical.has(row.canonicalId)) {
      throw new Error(
        `${providerLabel} native model id table: ${row.canonicalId} listed twice`
      );
    }
    byCanonical.set(row.canonicalId, row);
    for (const native of [row.nativeId, ...(row.nativeAliases ?? [])]) {
      const owner = nativeOwner.get(native);
      if (owner !== undefined && owner !== row.canonicalId) {
        throw new Error(
          `${providerLabel} native model id table: ${native} claimed by ${owner} and ${row.canonicalId}`
        );
      }
      nativeOwner.set(native, row.canonicalId);
    }
  }
  return byCanonical;
}

const ANTHROPIC_BY_CANONICAL = indexByCanonicalId(
  "Anthropic",
  ANTHROPIC_NATIVE_MODEL_IDS
);

/**
 * The id to call `api.anthropic.com` with, for the MODEL part of a BYOK
 * `anthropic/<model>` string.
 *
 * A reviewed canonical spelling maps to its native id
 * (`claude-sonnet-4.5` → `claude-sonnet-4-5`). Everything else passes through
 * UNCHANGED: a native id or a dated snapshot is already what the API takes,
 * and an id the table does not know is the caller's to choose — rewriting it
 * would be the guess the table exists to avoid.
 */
export function anthropicNativeModelId(model: string): string {
  const row = ANTHROPIC_BY_CANONICAL.get(`anthropic/${model.trim()}`);
  return row ? row.nativeId : model;
}
