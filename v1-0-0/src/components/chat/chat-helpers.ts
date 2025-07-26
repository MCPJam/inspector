import { SUPPORTED_MODELS } from "@/lib/types";
import claudeLogo from "../../../public/claude_logo.png";
import openaiLogo from "../../../public/openai_logo.png";

export const getProviderLogoFromProvider = (
  provider: string,
): string | null => {
  switch (provider) {
    case "anthropic":
      return claudeLogo.src;
    case "openai":
      return openaiLogo.src;
    default:
      return null;
  }
};

export const getProviderLogoFromModel = (model: string): string | null => {
  const provider = SUPPORTED_MODELS.find((m) => m.id === model);
  return getProviderLogoFromProvider(provider?.provider || "");
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
