/**
 * Shared provider logo utilities
 * Used across chat, evals, and other components that display model providers
 */

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
import litellmLogo from "/litellm_logo.png";
import openrouterLogo from "/openrouter_logo.png";
import moonshotLightLogo from "/moonshot_light.png";
import moonshotDarkLogo from "/moonshot_dark.png";
import zAiLogo from "/z-ai.png";

export type ThemeMode = "light" | "dark" | "system";

/**
 * Get the appropriate logo for a provider based on theme
 */
export const getProviderLogo = (
  provider: string,
  themeMode?: ThemeMode,
): string | null => {
  switch (provider) {
    case "anthropic":
      return claudeLogo;
    case "openai":
      return openaiLogo;
    case "deepseek":
      return deepseekLogo;
    case "google":
      return googleLogo;
    case "mistral":
      return mistralLogo;
    case "ollama":
      // Return dark logo when in dark mode
      if (themeMode === "dark") {
        return ollamaDarkLogo;
      }
      // For system theme, check if document has dark class
      if (themeMode === "system" && typeof document !== "undefined") {
        const isDark = document.documentElement.classList.contains("dark");
        return isDark ? ollamaDarkLogo : ollamaLogo;
      }
      // Default to light logo for light mode or when themeMode is not provided
      return ollamaLogo;
    case "meta":
    case "meta-llama":
      return metaLogo;
    case "x-ai":
    case "xai":
      if (themeMode === "dark") {
        return grokDarkLogo;
      }
      if (themeMode === "system" && typeof document !== "undefined") {
        const isDark = document.documentElement.classList.contains("dark");
        return isDark ? grokDarkLogo : grokLightLogo;
      }
      return grokLightLogo;
    case "litellm":
      return litellmLogo;
    case "openrouter":
      return openrouterLogo;
    case "moonshotai":
      if (themeMode === "dark") {
        return moonshotDarkLogo;
      }
      if (themeMode === "system" && typeof document !== "undefined") {
        const isDark = document.documentElement.classList.contains("dark");
        return isDark ? moonshotDarkLogo : moonshotLightLogo;
      }
      return moonshotLightLogo;
    case "z-ai":
      return zAiLogo;
    default:
      return null;
  }
};

/**
 * Get provider color classes for fallback display
 */
export const getProviderColor = (provider: string): string => {
  switch (provider) {
    case "anthropic":
      return "text-orange-600 dark:text-orange-400";
    case "openai":
      return "text-green-600 dark:text-green-400";
    case "deepseek":
      return "text-blue-600 dark:text-blue-400";
    case "google":
      return "text-red-600 dark:text-red-400";
    case "mistral":
      return "text-orange-500 dark:text-orange-400";
    case "ollama":
      return "text-gray-600 dark:text-gray-400";
    case "xai":
      return "text-purple-600 dark:text-purple-400";
    case "litellm":
      return "bg-gradient-to-br from-blue-500 to-purple-600";
    case "meta":
      return "text-blue-500 dark:text-blue-400";
    case "openrouter":
      return "text-purple-500 dark:text-purple-400";
    case "moonshotai":
      return "text-indigo-600 dark:text-indigo-400";
    case "z-ai":
      return "text-cyan-600 dark:text-cyan-400";
    default:
      return "text-gray-600 dark:text-gray-400";
  }
};
