// Standard React component for Vite
import { getProviderLogoFromProvider } from "../../shared/chat-helpers";
import { cn } from "@/lib/chat-utils";
import { getProviderColorForTheme } from "../../shared/chat-helpers";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { useChatboxHostTheme } from "@/contexts/chatbox-host-style-context";

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

  if (!logoSrc) {
    // Custom providers: first-letter badge matching the Settings tab style
    if (provider === "custom") {
      const letter = customProviderName?.[0]?.toUpperCase() || "C";
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
    }
    return (
      <div
        className={cn(
          "h-3 w-3 rounded-sm",
          getProviderColorForTheme(provider, resolvedThemeMode),
          className,
        )}
      />
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
