// Standard React component for Vite
import { getProviderLogoFromProvider } from "../../shared/chat-helpers";
import { cn } from "@/lib/chat-utils";
import { getProviderColor } from "../../shared/chat-helpers";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

interface ProviderLogoProps {
  provider: string;
  /** For custom providers, the display name used to derive the first-letter icon */
  customProviderName?: string;
}

export function ProviderLogo({
  provider,
  customProviderName,
}: ProviderLogoProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const logoSrc = getProviderLogoFromProvider(provider, themeMode);

  if (!logoSrc) {
    // Custom providers: first-letter badge matching the Settings tab style
    if (provider === "custom") {
      const letter = customProviderName?.[0]?.toUpperCase() || "C";
      return (
        <div className="h-3 w-3 rounded-sm bg-primary/10 flex items-center justify-center">
          <span className="text-primary font-bold text-[6px]">{letter}</span>
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
