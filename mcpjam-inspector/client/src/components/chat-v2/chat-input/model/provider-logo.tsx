// Standard React component for Vite
import { getProviderLogoFromProvider } from "../../shared/chat-helpers";
import { cn } from "@/lib/chat-utils";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { useChatboxHostTheme } from "@/contexts/chatbox-client-style-context";

interface ProviderLogoProps {
  provider: string;
  /** For custom providers, the display name used to derive the first-letter icon */
  customProviderName?: string;
  className?: string;
}

export function ProviderLogo({
  provider,
  customProviderName,
  className,
}: ProviderLogoProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const chatboxHostTheme = useChatboxHostTheme();
  const resolvedThemeMode = chatboxHostTheme ?? themeMode;
  const logoSrc = getProviderLogoFromProvider(provider, resolvedThemeMode);

  // No provider at all (e.g. a placeholder model while config loads):
  // render nothing rather than a misleading badge.
  if (!provider) {
    return null;
  }

  if (!logoSrc) {
    // No logo asset — render a first-letter monogram badge (Settings-tab
    // style). Covers custom providers AND unknown catalog providers (e.g.
    // "alibaba", "nvidia") that ship no bundled logo, so a brand-new provider
    // renders a legible badge with no code change.
    const source = provider === "custom" ? customProviderName : provider;
    const letter = source?.[0]?.toUpperCase() || "?";
    return (
      <div
        className={cn(
          "flex h-3 w-3 items-center justify-center rounded-sm bg-primary/10",
          className,
        )}
      >
        <span className="text-primary font-bold text-[6px]">{letter}</span>
      </div>
    );
  } else {
    return (
      <img
        src={logoSrc}
        alt={`${provider} logo`}
        className={cn("h-3 w-3 object-contain", className)}
      />
    );
  }
}
