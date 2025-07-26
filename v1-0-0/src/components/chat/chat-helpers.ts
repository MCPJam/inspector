import { SUPPORTED_MODELS } from "@/lib/types";
import claudeLogo from "../../../public/claude_logo.png";
import openaiLogo from "../../../public/openai_logo.png";
import ollamaLogo from "../../../public/ollama_logo.svg";
import ollamaDarkLogo from "../../../public/ollama_dark.png";

export const getProviderLogoFromProvider = (
  provider: string,
  themeMode?: "light" | "dark" | "system",
): string | null => {
  switch (provider) {
    case "anthropic":
      return claudeLogo.src;
    case "openai":
      return openaiLogo.src;
    case "ollama":
      // Return dark logo when in dark mode
      if (themeMode === "dark") {
        return ollamaDarkLogo.src;
      }
      // For system theme, check if document has dark class
      if (themeMode === "system" && typeof document !== "undefined") {
        const isDark = document.documentElement.classList.contains("dark");
        return isDark ? ollamaDarkLogo.src : ollamaLogo.src;
      }
      // Default to light logo for light mode or when themeMode is not provided
      return ollamaLogo.src;
    default:
      return null;
  }
};

export const getProviderLogoFromModel = (
  model: string,
  themeMode?: "light" | "dark" | "system",
): string | null => {
  const provider = SUPPORTED_MODELS.find((m) => m.id === model);
  return getProviderLogoFromProvider(provider?.provider || "", themeMode);
};

export const getProviderColor = (provider: string) => {
  switch (provider) {
    case "anthropic":
      return "text-orange-600 dark:text-orange-400";
    case "openai":
      return "text-green-600 dark:text-green-400";
    default:
      return "text-blue-600 dark:text-blue-400";
  }
};
