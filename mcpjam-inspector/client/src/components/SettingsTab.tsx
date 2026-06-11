import { useByokAllowed } from "@/hooks/use-byok-allowed";
import { useAuth } from "@workos-inc/authkit-react";
import { usePostHog } from "posthog-js/react";
import { SettingsSection } from "./setting/SettingsSection";
import { SettingsRow } from "./setting/SettingsRow";
import { EmptyState } from "./ui/empty-state";
import { Switch } from "@mcpjam/design-system/switch";
import { Button } from "@mcpjam/design-system/button";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { updateThemeMode } from "@/lib/theme-utils";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { Info, KeyRound } from "lucide-react";
import { HOSTED_MODE } from "@/lib/config";

interface SettingsTabProps {
  activeOrganizationId?: string;
  onNavigate?: (section: string) => void;
}

export function SettingsTab({
  activeOrganizationId,
  onNavigate,
}: SettingsTabProps = {}) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const setThemeMode = usePreferencesStore((s) => s.setThemeMode);
  const byokAllowed = useByokAllowed();
  const { signIn } = useAuth();
  const posthog = usePostHog();

  // Model providers are tied to organizations. The Settings tab only points
  // users at the right place to configure them — it does not store keys
  // locally. Hosted mode hides the section entirely (the surface lives in
  // the org dashboard); local OSS either signs the user in, points them at
  // their active org, or nudges them to create one.
  const isOrgBacked = !!activeOrganizationId;

  const handleThemeToggle = (checked: boolean) => {
    const newTheme = checked ? "dark" : "light";
    updateThemeMode(newTheme);
    setThemeMode(newTheme);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-10 space-y-8 max-w-3xl">
        <h1 className="text-2xl font-semibold">Settings</h1>

        {/* About */}
        <SettingsSection title="About">
          <SettingsRow label="Version" value={`v${__APP_VERSION__}`} />
        </SettingsSection>

        {/* Appearance */}
        <SettingsSection title="Appearance">
          <SettingsRow
            label="Theme"
            value={
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {themeMode === "dark" ? "Dark" : "Light"}
                </span>
                <Switch
                  checked={themeMode === "dark"}
                  onCheckedChange={handleThemeToggle}
                  aria-label="Toggle dark mode"
                />
              </div>
            }
          />
        </SettingsSection>

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
                  posthog.capture("login_button_clicked", {
                    location: "byok_signin_gate",
                    platform: detectPlatform(),
                    environment: detectEnvironment(),
                  });
                  signIn();
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
      </div>
    </div>
  );
}
