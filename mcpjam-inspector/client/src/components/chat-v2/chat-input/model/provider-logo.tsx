// The one provider logo/monogram badge, shared by chat + evals.
import { useEffect } from "react";
import { getProviderColor, getProviderLogo } from "@/lib/provider-registry";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/chat-utils";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { useChatboxHostTheme } from "@/contexts/chatbox-client-style-context";

interface ProviderLogoProps {
  provider: string;
  /** For custom providers, the display name used to derive the first-letter icon */
  customProviderName?: string;
  /** Box/img size — twMerge lets callers override the default `h-3 w-3`. */
  className?: string;
  /** Monogram letter size — override alongside a larger `className`. */
  letterClassName?: string;
  /**
   * Whether this is a MCPJam-hosted model. When a hosted model's provider has
   * no logo (monogram path), emit a one-time telemetry event so a brand-new
   * vendor added by the hourly catalog is noticed between snapshot regens.
   */
  hosted?: boolean;
}

// Providers we've already reported a missing logo for (throttle: once each).
const reportedMissingLogos = new Set<string>();

export function ProviderLogo({
  provider,
  customProviderName,
  className,
  letterClassName,
  hosted,
}: ProviderLogoProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const chatboxHostTheme = useChatboxHostTheme();
  const resolvedThemeMode = chatboxHostTheme ?? themeMode;
  const logoSrc = getProviderLogo(provider, resolvedThemeMode);

  // A hosted model whose provider has no logo → monogram. Report it once so a
  // brand-new vendor added by the hourly catalog is noticed between snapshot
  // regens. In an effect (not render) — telemetry is a side effect.
  const missingHostedLogo =
    !!hosted && !!provider && provider !== "custom" && !logoSrc;
  useEffect(() => {
    if (missingHostedLogo && !reportedMissingLogos.has(provider)) {
      reportedMissingLogos.add(provider);
      try {
        track("hosted_provider_logo_missing", {
          location: "provider_logo",
          provider,
        });
      } catch {
        // Telemetry must never break rendering.
      }
    }
  }, [missingHostedLogo, provider]);

  // No provider at all (e.g. a placeholder model while config loads):
  // render nothing rather than a misleading badge.
  if (!provider) {
    return null;
  }

  if (!logoSrc) {
    // No logo asset — first-letter monogram. Covers custom providers AND
    // unknown catalog providers (e.g. "thinkingmachines") that ship no bundled
    // logo, so a brand-new provider renders a legible badge with no code change.
    const source = provider === "custom" ? customProviderName : provider;
    const letter = source?.[0]?.toUpperCase() || "?";
    const color = getProviderColor(provider);
    // `custom` uses a background gradient (+ white letter); branded providers
    // color the letter itself on a neutral tint.
    const isBackgroundColor = color.startsWith("bg-");
    return (
      <div
        className={cn(
          "flex h-3 w-3 items-center justify-center rounded-sm",
          isBackgroundColor ? color : "bg-primary/10",
          className
        )}
      >
        <span
          className={cn(
            "font-bold text-[6px]",
            isBackgroundColor ? "text-white" : color,
            letterClassName
          )}
        >
          {letter}
        </span>
      </div>
    );
  }

  return (
    <img
      src={logoSrc}
      alt={`${provider} logo`}
      className={cn("h-3 w-3 object-contain", className)}
    />
  );
}
