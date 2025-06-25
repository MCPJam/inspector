import React from "react";
import { SupportedProvider } from "@/lib/providers";

interface ProviderLogoProps {
  provider: SupportedProvider;
  className?: string;
  size?: number;
}

const getProviderLogo = (provider: SupportedProvider): string => {
  switch (provider) {
    case "anthropic":
      return "/claude_logo.png";
    case "openai":
      return "/openai_logo.png";
    case "deepseek":
      return "/deepseek_logo.png";
    default:
      return "/claude_logo.png"; // fallback
  }
};

const getProviderAlt = (provider: SupportedProvider): string => {
  switch (provider) {
    case "anthropic":
      return "Claude Logo";
    case "openai":
      return "OpenAI Logo";
    case "deepseek":
      return "DeepSeek Logo";
    default:
      return "AI Provider Logo";
  }
};

export const ProviderLogo: React.FC<ProviderLogoProps> = ({
  provider,
  className = "",
  size = 32,
}) => {
  return (
    <img
      src={getProviderLogo(provider)}
      alt={getProviderAlt(provider)}
      width={size}
      height={size}
      className={className}
      style={{
        width: size,
        height: size,
        objectFit: "contain",
      }}
    />
  );
};

// Keep backward compatibility - export ClaudeLogo for existing usage
export const ClaudeLogo: React.FC<Omit<ProviderLogoProps, 'provider'> & { className?: string; size?: number }> = (props) => {
  return <ProviderLogo provider="anthropic" {...props} />;
};
