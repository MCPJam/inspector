/**
 * BYOK provider adapters: how MCPJam discovers and addresses the models a
 * customer's own provider connection serves.
 *
 * Each adapter answers two questions for one provider:
 *
 *  - `listModels(connection)`: which models does this connection serve right
 *    now? Read from the provider's own list endpoint where one exists (OpenAI,
 *    Anthropic, Google, OpenRouter, Ollama). Azure, Bedrock and custom
 *    providers have no usable list for the ids a request is made with (an Azure
 *    deployment is named by the admin, Bedrock access is granted per account),
 *    so their adapters report the ids the connection was configured with.
 *  - `toNativeId(canonicalId)`: which id does the provider API take for a
 *    canonical `provider/model` id? Answered from an explicit table of reviewed
 *    pairs, each with the evidence it rests on, and never by stripping the
 *    canonical prefix: a canonical id with no reviewed row is `unmapped`, not
 *    guessed. Providers addressed by explicit ids (Azure deployments, Bedrock
 *    model / inference-profile ids, custom and Ollama models) answer
 *    `explicit_native_id_required`: the saved selection's `nativeModelId` is
 *    the only source.
 *
 * Secrets: a connection's `apiKey` goes into the request's auth header and
 * nowhere else. It is never part of a result, an error message, a log line or
 * a URL, and an upstream error body (which may echo a masked key) is dropped,
 * not relayed.
 */

export type ByokConnection = {
  /** Org/local provider key: `openai`, `azure`, `custom:<slug>`, ... */
  providerKey: string;
  /** The provider key/token. Only ever placed in the auth header. */
  apiKey?: string;
  /** Provider endpoint override (Ollama host, Azure resource URL, ...). */
  baseUrl?: string;
  /**
   * The model ids the connection was configured with: Azure deployment names,
   * Bedrock `selectedModels`, custom-provider and Ollama `modelIds`.
   */
  configuredModelIds?: readonly string[];
};

export type ByokListedModel = {
  /** The id the provider API takes. */
  nativeId: string;
  /** Canonical id, only when the adapter's reviewed table maps this id. */
  canonicalId?: string;
  displayName?: string;
  contextLength?: number;
};

export type ByokListFailureCode =
  | "missing_credentials"
  | "unauthorized"
  | "http_error"
  | "network_error"
  | "malformed_response";

export type ByokListResult =
  | {
      ok: true;
      /**
       * `provider-list`: read from the provider's list endpoint.
       * `configured`: the connection's own configured ids (no list endpoint).
       */
      source: "provider-list" | "configured";
      models: ByokListedModel[];
      /**
       * False when the adapter stopped paging before the provider said the
       * list was done. An incomplete list never counts as a miss.
       */
      complete: boolean;
      observedAt: number;
    }
  | {
      ok: false;
      code: ByokListFailureCode;
      /** HTTP status of the upstream answer, when there was one. */
      status?: number;
      /** Safe to show and log: never includes the key or the upstream body. */
      message: string;
    };

export type NativeIdResult =
  | { ok: true; nativeId: string; evidence: string }
  | {
      ok: false;
      code: "unmapped" | "explicit_native_id_required";
      reason: string;
    };

export type ByokAdapterDeps = {
  fetch?: typeof fetch;
  now?: () => number;
  /** Per-request timeout; defaults to {@link DEFAULT_LIST_TIMEOUT_MS}. */
  timeoutMs?: number;
};

export interface ByokProviderAdapter {
  providerKey: string;
  /**
   * The list endpoint this adapter reads (for docs and error messages), or
   * `null` when the adapter reports configured ids.
   */
  listEndpoint: string | null;
  listModels(
    connection: ByokConnection,
    deps?: ByokAdapterDeps,
  ): Promise<ByokListResult>;
  toNativeId(canonicalId: string): NativeIdResult;
  /** Reverse lookup over the same reviewed table; `undefined` when unmapped. */
  toCanonicalId(nativeId: string): string | undefined;
  /**
   * Whether a listed id is a dated snapshot of an alias id, for providers
   * whose list endpoint reports snapshots rather than the aliases requests
   * use. Only used to decide that a static alias is still served.
   */
  isSnapshotOf?(listedId: string, aliasId: string): boolean;
}

export const DEFAULT_LIST_TIMEOUT_MS = 10_000;
