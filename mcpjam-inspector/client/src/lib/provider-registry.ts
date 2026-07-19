/**
 * provider-registry.ts — THE single source of provider display data
 * (logo, brand color, display name) for the whole app.
 *
 * Model metadata (context, tokens, modalities, description) flows automatically
 * from the backend Gateway catalog and needs no per-model upkeep. Provider
 * BRAND assets can't auto-flow — they're bundled images + Tailwind classes — so
 * they live here, keyed by a NORMALIZED provider key, and are orthogonal to the
 * churning model set: a new model from a known provider is styled automatically,
 * and a brand-new *vendor* is one entry here (+ one logo file) with a graceful
 * monogram fallback until then.
 *
 * This is a LEAF module — it must not import from model-helpers (which delegates
 * back here) or any component, to avoid a cycle.
 */

import azureLogo from "/azure_logo.png";
import bedrockLogo from "/bedrock_logo.svg";
import claudeLogo from "/claude_logo.png";
import openaiLogo from "/openai_logo.png";
import deepseekLogo from "/deepseek_logo.svg";
import googleLogo from "/google_logo.png";
import metaLogo from "/meta_logo.svg";
import mistralLogo from "/mistral_logo.png";
import ollamaLogo from "/ollama_logo.svg";
import ollamaDarkLogo from "/ollama_dark.png";
import grokLightLogo from "/grok_light.svg";
import grokDarkLogo from "/grok_dark.png";
import openrouterLogo from "/openrouter_logo.png";
import moonshotLightLogo from "/moonshot_light.png";
import moonshotDarkLogo from "/moonshot_dark.png";
import zAiLogo from "/z-ai.png";
import minimaxLogo from "/minimax_logo.svg";
import qwenLogo from "/qwen_logo.png";

export type ThemeMode = "light" | "dark" | "system";

export interface ProviderBrand {
  displayName: string;
  /** Bundled logo; `undefined` → render the monogram. */
  logoLight?: string;
  /** Dark-theme variant; falls back to `logoLight`. */
  logoDark?: string;
  /**
   * Monogram styling. For branded providers a Tailwind text-color class pair
   * (colors the monogram letter). For `custom` a background class (gradient) —
   * see `isBackgroundColorClass` in the ProviderLogo component.
   */
  color: string;
}

/**
 * Canonical provider registry. Keys are NORMALIZED (see normalizeProviderKey):
 * every raw prefix a surface might produce (e.g. `x-ai` from an id split, `xai`
 * from the aliased `model.provider`) collapses to one entry here.
 *
 * To add a vendor: drop its logo(s) in `client/public/`, add one entry.
 * To remove: delete the entry (it falls back to a monogram).
 */
const PROVIDER_REGISTRY: Record<string, ProviderBrand> = {
  anthropic: {
    displayName: "Anthropic",
    logoLight: claudeLogo,
    color: "text-orange-600 dark:text-orange-400",
  },
  openai: {
    displayName: "OpenAI",
    logoLight: openaiLogo,
    color: "text-green-600 dark:text-green-400",
  },
  google: {
    displayName: "Google AI",
    logoLight: googleLogo,
    color: "text-red-600 dark:text-red-400",
  },
  deepseek: {
    displayName: "DeepSeek",
    logoLight: deepseekLogo,
    color: "text-blue-600 dark:text-blue-400",
  },
  mistral: {
    displayName: "Mistral AI",
    logoLight: mistralLogo,
    color: "text-orange-500 dark:text-orange-400",
  },
  meta: {
    displayName: "Meta",
    logoLight: metaLogo,
    color: "text-blue-500 dark:text-blue-400",
  },
  xai: {
    displayName: "xAI",
    logoLight: grokLightLogo,
    logoDark: grokDarkLogo,
    color: "text-purple-600 dark:text-purple-400",
  },
  moonshotai: {
    displayName: "Moonshot AI",
    logoLight: moonshotLightLogo,
    logoDark: moonshotDarkLogo,
    color: "text-indigo-600 dark:text-indigo-400",
  },
  "z-ai": {
    displayName: "Zhipu AI",
    logoLight: zAiLogo,
    color: "text-cyan-600 dark:text-cyan-400",
  },
  minimax: {
    displayName: "MiniMax",
    logoLight: minimaxLogo,
    color: "text-pink-600 dark:text-pink-400",
  },
  qwen: {
    displayName: "Qwen",
    logoLight: qwenLogo,
    color: "text-yellow-600 dark:text-yellow-400",
  },
  ollama: {
    displayName: "Ollama",
    logoLight: ollamaLogo,
    logoDark: ollamaDarkLogo,
    color: "text-gray-600 dark:text-gray-400",
  },
  bedrock: {
    displayName: "Amazon Bedrock",
    logoLight: bedrockLogo,
    color: "text-blue-600 dark:text-blue-400",
  },
  azure: {
    displayName: "Azure OpenAI",
    logoLight: azureLogo,
    color: "text-purple-600 dark:text-purple-400",
  },
  openrouter: {
    displayName: "OpenRouter",
    logoLight: openrouterLogo,
    color: "text-purple-500 dark:text-purple-400",
  },
  custom: {
    displayName: "Custom",
    // No bundled logo → monogram; the background gradient makes it legible.
    color: "bg-gradient-to-br from-teal-500 to-cyan-600",
  },
};

// Every raw prefix variant a surface might produce → canonical registry key.
// The client's `model.provider` for hosted models is already aliased
// (hostedProviderFromCanonicalId: x-ai→xai, meta-llama→meta, mistralai→mistral),
// but eval cards derive the provider from `id.split("/")[0]` (raw `x-ai`,
// `meta-llama`, `mistralai`). Reconcile both here.
const PROVIDER_ALIASES: Record<string, string> = {
  "x-ai": "xai",
  "meta-llama": "meta",
  mistralai: "mistral",
  zai: "z-ai",
  moonshot: "moonshotai",
};

const DEFAULT_COLOR = "text-gray-600 dark:text-gray-400";

/** Title-case an unknown provider key ("arcee-ai" → "Arcee Ai"). */
export function titleCaseProviderKey(raw: string): string {
  return raw
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Collapse any raw provider string to its canonical registry key.
 * `custom:<slug>` → `custom` (peel the slug BEFORE this if you need it, e.g.
 * for the display name).
 */
export function normalizeProviderKey(raw: string): string {
  const key = raw.startsWith("custom:") ? "custom" : raw.toLowerCase();
  return PROVIDER_ALIASES[key] ?? key;
}

function resolveDark(themeMode?: ThemeMode): boolean {
  if (themeMode === "dark") return true;
  if (themeMode === "light" || themeMode === undefined) return false;
  // system: read the document class (SSR-safe guard).
  return (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  );
}

/** Theme-aware provider logo, or `null` when none is registered (→ monogram). */
export function getProviderLogo(
  provider: string,
  themeMode?: ThemeMode
): string | null {
  const brand = PROVIDER_REGISTRY[normalizeProviderKey(provider)];
  if (!brand?.logoLight) return null;
  return resolveDark(themeMode)
    ? brand.logoDark ?? brand.logoLight
    : brand.logoLight;
}

/** Monogram color classes for a provider (see ProviderBrand.color). */
export function getProviderColor(provider: string): string {
  return (
    PROVIDER_REGISTRY[normalizeProviderKey(provider)]?.color ?? DEFAULT_COLOR
  );
}

/**
 * Human display name for a provider group key. Handles `custom:<slug>` (returns
 * the slug), known providers (registry), and unknown catalog providers
 * (title-cased) — so a new vendor renders a clean name with no code change.
 */
export function getProviderDisplayName(groupKey: string): string {
  if (groupKey.startsWith("custom:")) {
    return groupKey.slice("custom:".length);
  }
  const brand = PROVIDER_REGISTRY[normalizeProviderKey(groupKey)];
  return brand?.displayName ?? titleCaseProviderKey(groupKey);
}

/** Whether a provider has a bundled logo (true) or falls back to a monogram. */
export function providerHasLogo(provider: string): boolean {
  return !!PROVIDER_REGISTRY[normalizeProviderKey(provider)]?.logoLight;
}
