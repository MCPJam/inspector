import { useState } from "react";
import { useOllamaConfig } from "@/hooks/use-ollama-config";
import { OllamaConfigDialog } from "./setting/OllamaConfigDialog";
import { SettingsSection } from "./setting/SettingsSection";
import { SettingsRow } from "./setting/SettingsRow";
import { ProviderRow } from "./setting/ProviderRow";
import { Switch } from "@mcpjam/design-system/switch";
import { Button } from "@mcpjam/design-system/button";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { updateThemeMode } from "@/lib/theme-utils";
import { Info } from "lucide-react";

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
  const { getOllamaBaseUrl, setOllamaBaseUrl } = useOllamaConfig();

  const [ollamaDialogOpen, setOllamaDialogOpen] = useState(false);
  const [ollamaUrl, setOllamaUrl] = useState("");

  const selfHostedProviders: Array<{
    id: string;
    name: string;
    logo: string;
    isConfigured: boolean;
    onEdit: () => void;
    configType?: "api-key" | "base-url";
  }> = [
    {
      id: "ollama",
      name: "Ollama",
      logo: "/ollama_logo.svg",
      isConfigured: Boolean(getOllamaBaseUrl()),
      configType: "base-url",
      onEdit: () => {
        setOllamaUrl(getOllamaBaseUrl());
        setOllamaDialogOpen(true);
      },
    },
  ];

  const handleOllamaSave = () => {
    setOllamaBaseUrl(ollamaUrl);
    setOllamaDialogOpen(false);
    setOllamaUrl("");
  };

  const handleOllamaCancel = () => {
    setOllamaDialogOpen(false);
    setOllamaUrl("");
  };

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

        <SettingsSection title="LLM Providers">
          <div className="flex items-start gap-3 px-4 py-3 rounded-md border border-border/40 bg-muted/30">
            <Info className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
            <div className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">
                Cloud, private-network, and custom model providers are managed
                in organization settings. Solo users can configure providers in
                their personal organization.
              </span>
              {activeOrganizationId ? (
                <Button
                  variant="link"
                  className="h-auto p-0 text-sm justify-start"
                  onClick={() =>
                    onNavigate?.(`organizations/${activeOrganizationId}/models`)
                  }
                >
                  Go to Organization Models
                </Button>
              ) : null}
            </div>
          </div>
          {selfHostedProviders.map((provider) => (
            <ProviderRow
              key={provider.id}
              logo={provider.logo}
              logoAlt={provider.name}
              name={provider.name}
              isConfigured={provider.isConfigured}
              onEdit={provider.onEdit}
              configType={provider.configType}
            />
          ))}
        </SettingsSection>

        {/* Dialogs */}
        <OllamaConfigDialog
          open={ollamaDialogOpen}
          onOpenChange={setOllamaDialogOpen}
          value={ollamaUrl}
          onValueChange={setOllamaUrl}
          onSave={handleOllamaSave}
          onCancel={handleOllamaCancel}
        />
      </div>
    </div>
  );
}
