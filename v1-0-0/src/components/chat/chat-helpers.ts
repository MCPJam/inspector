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
