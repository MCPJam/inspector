import { cn } from "@/lib/utils";
import { buildOrganizationPath, useAppNavigate } from "@/lib/app-navigation";

export type SettingsNavSection =
  | "general"
  | "api-keys"
  | "integrations"
  | "organization";

interface SettingsNavProps {
  active: SettingsNavSection;
  /**
   * Enables the Organization tab. Without an active org there is nothing to
   * manage, so the tab is omitted rather than disabled.
   */
  activeOrganizationId?: string | null;
}

interface TabDescriptor {
  id: SettingsNavSection;
  label: string;
  path: string;
}

function SettingsNavTab({
  tab,
  active,
  onSelect,
}: {
  tab: TabDescriptor;
  active: SettingsNavSection;
  onSelect: (path: string) => void;
}) {
  const isActive = active === tab.id;
  return (
    <button
      type="button"
      onClick={() => {
        if (!isActive) onSelect(tab.path);
      }}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
        isActive
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      )}
    >
      {tab.label}
    </button>
  );
}

/**
 * Top-level Settings sections, shared across `/settings`,
 * `/settings/api-keys`, and the organization page so they read as one
 * Settings surface. Styling mirrors the org page's section tabs.
 */
export function SettingsNav({
  active,
  activeOrganizationId,
}: SettingsNavProps) {
  const appNavigate = useAppNavigate();

  // Integrations is UNCONDITIONAL, and nothing here asks the backend anything.
  // The GitHub Checks tab used to live here behind an availability query; that
  // gate now sits on the GitHub CARD inside the page (`IntegrationsRoute`).
  //
  // The move is deliberate, not tidying. Slack is an integration every org has,
  // so gating the tab on GitHub's beta would hide Slack from everyone outside
  // it — and a nav that asks a per-service question to decide whether a
  // multi-service page exists gets that wrong again with every service added.
  // The page decides which cards it can show; the nav just points at the page.
  const tabs: TabDescriptor[] = [
    { id: "general", label: "General", path: "/settings" },
    { id: "api-keys", label: "API Keys", path: "/settings/api-keys" },
    {
      id: "integrations",
      label: "Integrations",
      path: "/settings/integrations",
    },
  ];

  const organizationTab: TabDescriptor | null = activeOrganizationId
    ? {
        id: "organization",
        label: "Organization",
        path: buildOrganizationPath(activeOrganizationId),
      }
    : null;

  return (
    <nav
      aria-label="Settings sections"
      className="flex items-end gap-1 border-b border-border/60"
    >
      {tabs.map((tab) => (
        <SettingsNavTab
          key={tab.id}
          tab={tab}
          active={active}
          onSelect={appNavigate}
        />
      ))}

      {organizationTab ? (
        <SettingsNavTab
          tab={organizationTab}
          active={active}
          onSelect={appNavigate}
        />
      ) : null}
    </nav>
  );
}
