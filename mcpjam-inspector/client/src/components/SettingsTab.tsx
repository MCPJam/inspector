import { SettingsPageDescription } from "@/components/settings/SettingsPageDescription";
import { ThemePreview } from "./settings/ThemePreview";
import { useCurrentPathname } from "@/lib/app-navigation";
import { useByokAllowed } from "@/hooks/use-byok-allowed";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import { useAuth } from "@workos-inc/authkit-react";
import { SettingsSection } from "./setting/SettingsSection";
import { AboutSettings } from "./settings/AboutSettings";
import { EmptyState } from "./ui/empty-state";

import { Button } from "@mcpjam/design-system/button";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

import { track } from "@/lib/analytics";
import { Info, KeyRound, Sun, Moon, Monitor } from "lucide-react";
import { HOSTED_MODE } from "@/lib/config";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { SettingsPageShell } from "./settings/SettingsPageShell";

interface SettingsTabProps {
  activeOrganizationId?: string;
  onNavigate?: (section: string) => void;
}

export function SettingsTab({
  activeOrganizationId,
  onNavigate,
}: SettingsTabProps = {}) {
  const about = useCurrentPathname() === "/settings/about";
  const themePreference = usePreferencesStore((s) => s.themePreference);
  const setThemePreference = usePreferencesStore((s) => s.setThemePreference);
  const byokAllowed = useByokAllowed();
  const { signIn } = useAuth();

  // Model providers are tied to organizations. The Settings tab only points
  // users at the right place to configure them — it does not store keys
  // locally. Hosted mode hides the section entirely (the surface lives in
  // the org dashboard); local OSS either signs the user in, points them at
  // their active org, or nudges them to create one.
  const isOrgBacked = !!activeOrganizationId;

  return (
    <SettingsPageShell>
      {about && <AboutSettings />}

      {!about && (
        <>
          <div className="w-full space-y-8 text-accent-foreground">
            <header className="space-y-1">
              <h1 className="text-2xl font-semibold">Appearance</h1>
              <SettingsPageDescription>
                Choose how MCPJam looks on this device.
              </SettingsPageDescription>
            </header>
            <fieldset className="space-y-4">
              <legend className="text-base font-semibold">Theme</legend>
              <p className="text-sm text-foreground">
                Use a light or dark theme, or follow your device’s appearance.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {(
                  [
                    {
                      value: "light",
                      label: "Light",
                      description: "A bright appearance.",
                      icon: Sun,
                    },
                    {
                      value: "dark",
                      label: "Dark",
                      description: "A darker appearance.",
                      icon: Moon,
                    },
                    {
                      value: "system",
                      label: "System",
                      description: "Matches your device.",
                      icon: Monitor,
                    },
                  ] as const
                ).map(({ value, label, description, icon: Icon }) => (
                  <label key={value} className="relative cursor-pointer">
                    <input
                      type="radio"
                      aria-label={label}
                      name="theme-preference"
                      value={value}
                      checked={themePreference === value}
                      onChange={() => setThemePreference(value)}
                      className="peer sr-only"
                    />
                    <span className="flex h-full flex-col gap-3 rounded-lg border border-input bg-background p-2 peer-checked:border-ring peer-checked:bg-accent peer-checked:ring-1 peer-checked:ring-ring peer-focus-visible:ring-2 peer-focus-visible:ring-ring hover:bg-accent/50">
                      <ThemePreview mode={value} />
                      <span className="flex items-center justify-center gap-2 py-1 font-semibold">
                        <Icon aria-hidden="true" className="size-4" />
                        {label}
                      </span>
                      <span className="sr-only">{description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>

          {!HOSTED_MODE && !byokAllowed && (
            <SettingsSection title="LLM Providers">
              <EmptyState
                icon={KeyRound}
                title="Sign in to configure model providers"
                description="Provider keys are managed at the organization level. Sign in to set up your organization's models and use them in chat, evals, and the playground."
                className="py-10"
              >
                <Button
                  type="button"
                  onClick={() => {
                    track("login_button_clicked", {
                      location: "byok_signin_gate",
                    });
                    captureAppSignInReturnPath();
                    signIn(permalinkSignInOptions());
                  }}
                  size="sm"
                >
                  Sign in
                </Button>
              </EmptyState>
            </SettingsSection>
          )}

          {!HOSTED_MODE && byokAllowed && isOrgBacked && (
            <SettingsSection title="LLM Providers">
              <div className="flex items-start gap-3 px-4 py-3 rounded-md border border-border/40 bg-muted/30">
                <Info className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                <div className="flex flex-col gap-1">
                  <span className="text-sm text-muted-foreground">
                    Model providers are managed in your organization settings.
                  </span>
                  <Button
                    variant="link"
                    className="h-auto p-0 text-sm justify-start"
                    onClick={() =>
                      onNavigate?.(
                        `organizations/${activeOrganizationId}/models`,
                      )
                    }
                  >
                    Go to Organization Models
                  </Button>
                </div>
              </div>
            </SettingsSection>
          )}

          {!HOSTED_MODE && byokAllowed && !isOrgBacked && (
            <SettingsSection title="LLM Providers">
              <div className="flex items-start gap-3 px-4 py-3 rounded-md border border-border/40 bg-muted/30">
                <Info className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                <div className="flex flex-col gap-1">
                  <span className="text-sm text-muted-foreground">
                    Model providers are configured at the organization level.
                    Create or join an organization on mcpjam.com to set them up.
                  </span>
                  <Button
                    variant="link"
                    className="h-auto p-0 text-sm justify-start"
                    onClick={() =>
                      window.open(
                        "https://app.mcpjam.com/organizations",
                        "_blank",
                        "noopener,noreferrer",
                      )
                    }
                  >
                    Open mcpjam.com
                  </Button>
                </div>
              </div>
            </SettingsSection>
          )}
        </>
      )}
    </SettingsPageShell>
  );
}
