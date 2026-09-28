import { anthropicAdapter } from "./anthropic.js";
import { azureAdapter } from "./azure.js";
import { bedrockAdapter } from "./bedrock.js";
import { customAdapter } from "./custom.js";
import { googleAdapter } from "./google.js";
import { ollamaAdapter } from "./ollama.js";
import { openaiAdapter } from "./openai.js";
import { openrouterAdapter } from "./openrouter.js";
import type { ByokProviderAdapter } from "../types.js";

/**
 * Every BYOK provider adapter, by provider key. Providers without one here
 * (deepseek, mistral, xai, moonshotai, z-ai, qwen, minimax) have no reviewed
 * native-id table yet; callers get `undefined` and keep the static list.
 */
export const BYOK_PROVIDER_ADAPTERS: Readonly<
  Record<string, ByokProviderAdapter>
> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, ByokProviderAdapter>, {
    anthropic: anthropicAdapter,
    azure: azureAdapter,
    bedrock: bedrockAdapter,
    custom: customAdapter,
    google: googleAdapter,
    ollama: ollamaAdapter,
    openai: openaiAdapter,
    openrouter: openrouterAdapter,
  }),
);

/** The adapter for a provider key; `custom:<slug>` keys use the custom one. */
export function getByokProviderAdapter(
  providerKey: string,
): ByokProviderAdapter | undefined {
  const key = providerKey.trim();
  if (key === "custom" || key.startsWith("custom:")) return customAdapter;
  return Object.prototype.hasOwnProperty.call(BYOK_PROVIDER_ADAPTERS, key)
    ? BYOK_PROVIDER_ADAPTERS[key]
    : undefined;
}

export {
  anthropicAdapter,
  azureAdapter,
  bedrockAdapter,
  customAdapter,
  googleAdapter,
  ollamaAdapter,
  openaiAdapter,
  openrouterAdapter,
};
