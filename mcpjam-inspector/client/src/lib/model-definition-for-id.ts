import type { ModelDefinition } from "@/shared/types";

/** Display the recorded model id without guessing its provider or capabilities. */
export function modelDefinitionForId(modelId?: string | null): ModelDefinition {
  return {
    id: modelId ?? "unknown",
    name: modelId ?? "Unknown",
    provider: "custom",
  };
}
