/**
 * `list_models` answers with the whole public catalog: about 255 models and
 * 440 KB, three-quarters of it per-model observation timestamps and marketing
 * copy. The text rendering is capped, but `structuredContent` would still
 * carry all of it into a client, and Claude's directory review asks for
 * responses sized to the task. This keeps what choosing a model needs.
 *
 * MCP-only: the CLI and REST still return the full rows, and the omitted
 * fields are named in the result so nothing is silently missing.
 */
const MODEL_CATALOG_OMITTED_FIELDS = [
  "description",
  "observations",
  "architecture (beyond modalities)",
  "top_provider",
  "per_request_limits",
  "default_parameters",
  "pricing (beyond prompt and completion)",
] as const;

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : undefined;
}

export function compactModelCatalogForModel(payload: object): object {
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) return payload;
  return {
    ...payload,
    items: items.map((raw) => {
      const model = (raw ?? {}) as Record<string, unknown>;
      const pricing = (model.pricing ?? {}) as Record<string, unknown>;
      const architecture = (model.architecture ?? {}) as Record<
        string,
        unknown
      >;
      const parameters = stringList(model.supported_parameters);
      return {
        id: model.id,
        name: model.name,
        ...(model.provider !== undefined ? { provider: model.provider } : {}),
        ...(model.providerSource !== undefined
          ? { providerSource: model.providerSource }
          : {}),
        ...(model.context_length !== undefined
          ? { contextLength: model.context_length }
          : {}),
        ...(pricing.prompt !== undefined || pricing.completion !== undefined
          ? {
              pricingPerToken: {
                prompt: pricing.prompt,
                completion: pricing.completion,
              },
            }
          : {}),
        ...(stringList(architecture.input_modalities)
          ? { inputModalities: architecture.input_modalities }
          : {}),
        ...(stringList(architecture.output_modalities)
          ? { outputModalities: architecture.output_modalities }
          : {}),
        ...(parameters ? { supportsTools: parameters.includes("tools") } : {}),
        ...(Array.isArray(model.supportedReasoningEfforts)
          ? { supportedReasoningEfforts: model.supportedReasoningEfforts }
          : {}),
        ...(model.guestAllowed !== undefined
          ? { guestAllowed: model.guestAllowed }
          : {}),
        ...(model.deprecated_at !== undefined && model.deprecated_at !== null
          ? { deprecatedAt: model.deprecated_at }
          : {}),
      };
    }),
    compacted: { omittedFields: [...MODEL_CATALOG_OMITTED_FIELDS] },
  };
}

/** Per-tool reshaping of a successful result, applied on this surface only. */
export const MCP_RESULT_PROJECTIONS: Readonly<
  Record<string, ((payload: object) => object) | undefined>
> = {
  list_models: compactModelCatalogForModel,
};
