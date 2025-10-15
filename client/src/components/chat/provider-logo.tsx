// Standard React component for Vite
import { getProviderLogoFromProvider } from "./chat-helpers";
import { cn } from "@/lib/chat-utils";
import { getProviderColor } from "./chat-helpers";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

interface ProviderLogoProps {
  provider: string;
}

export function ProviderLogo({ provider }: ProviderLogoProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const logoSrc = getProviderLogoFromProvider(provider, themeMode);

  if (!logoSrc) {
    // Special rendering for LiteLLM with gradient badge
    if (provider === "litellm") {
      return (
        <div
          className={cn(
            "h-3 w-3 rounded-sm flex items-center justify-center",
            getProviderColor(provider),
          )}
        >
          <span className="text-white font-bold text-[6px]">L</span>
        </div>
      );
    }
    return (
      <div className={cn("h-3 w-3 rounded-sm", getProviderColor(provider))} />
    );
  } else {
    return (
      <img
        src={logoSrc}
        width={12}
        height={12}
        alt={`${provider} logo`}
        className={"h-3 w-3 object-contain"}
      />
    );
  }
}
