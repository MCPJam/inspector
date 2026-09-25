/**
 * OpenRouter model metadata types
 * These types match the backend API response from /models endpoint
 */

export interface OpenRouterModel {
  id: string;
  canonical_slug: string;
  name: string;
  created: number;
  pricing: {
    prompt: string;
    completion: string;
    request: string;
    image: string;
  };
  // Nullable to match the backend `CatalogModelDto`: a model with no known
  // context length renders "N/A" instead of a misleading 0.
  context_length: number | null;
  architecture: {
    modality: string;
    input_modalities: string[];
    output_modalities: string[];
    tokenizer: string;
    instruct_type?: string;
  };
  top_provider: {
    is_moderated: boolean;
    context_length: number | null;
    max_completion_tokens: number | null;
  };
  per_request_limits: any;
  supported_parameters: string[];
  default_parameters: any;
  description: string;
  // Whether MCPJam serves this model to signed-out guests (from the canonical
  // model capabilities, not the OpenRouter/Gateway catalog). Consumed by the
  // picker to gate guest-visible models.
  guestAllowed: boolean;
  // Which provider serves this model: 'gateway' when a Gateway price exists,
  // 'openrouter' for fallback models with no Gateway entry.
  providerSource: "gateway" | "openrouter";
  // Catalog observations (backend P3-1). Every field is optional: a backend
  // that predates them sends none, and the picker must then behave as before.
  /** Release time, epoch seconds (Gateway `released`). */
  released?: number | null;
  /** Provider retirement time, epoch ms (Gateway `deprecated_at`). */
  deprecated_at?: number | null;
  observations?: Partial<Record<string, CatalogObservationDto | null>> | null;
  /** True only when `supported_parameters` is the Gateway's full list. */
  supported_parameters_complete?: boolean;
  free_tier_eligible?: boolean;
  judge_eligible?: boolean;
  /** When the catalog row's observations were read, epoch ms. */
  catalog_observed_at?: number | null;
}

export interface CatalogObservationDto {
  status?: string;
  source?: string;
  observedAt?: number | null;
}
