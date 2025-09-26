import { ModelDefinition } from "@/shared/types.js";
import claudeLogo from "/claude_logo.png";
import openaiLogo from "/openai_logo.png";
import deepseekLogo from "/deepseek_logo.svg";
import googleLogo from "/google_logo.png";
import metaLogo from "/meta_logo.svg";
import ollamaLogo from "/ollama_logo.svg";
import ollamaDarkLogo from "/ollama_dark.png";

export const getProviderLogoFromProvider = (
  provider: string,
  themeMode?: "light" | "dark" | "system",
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
      return metaLogo;
    default:
      return null;
  }
};

export const getProviderLogoFromModel = (
  model: ModelDefinition,
  themeMode?: "light" | "dark" | "system",
): string | null => {
  return getProviderLogoFromProvider(model.provider, themeMode);
};

export const getProviderColor = (provider: string) => {
  switch (provider) {
    case "anthropic":
      return "text-orange-600 dark:text-orange-400";
    case "openai":
      return "text-green-600 dark:text-green-400";
    case "deepseek":
      return "text-blue-600 dark:text-blue-400";
    case "google":
      return "text-red-600 dark:text-red-400";
    case "ollama":
      return "text-gray-600 dark:text-gray-400";
    default:
      return "text-blue-600 dark:text-blue-400";
  }
};
