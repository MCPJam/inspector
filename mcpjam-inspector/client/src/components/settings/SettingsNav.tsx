import { buildOrganizationPath, useAppNavigate } from "@/lib/app-navigation";
import { SectionTab } from "./SectionTab";

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

/**
 * Top-level Settings sections, shared across `/settings`,
 * `/settings/api-keys`, and the organization page so they read as one
 * Settings surface. Render it through `SettingsPageShell` rather than
 * directly, so the strip lands in the same place on every section.
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

  // The tabs never shrink, so on a phone they overflow the column rather than
  // wrapping — four of them need ~380px against the ~343px a 375px viewport
  // leaves. Scrolling the strip keeps every section reachable. The border stays
  // on the nav so it scrolls with the tabs, and `w-max min-w-full` lets the nav
  // grow past the scroller while still spanning it when the tabs fit.
  return (
    <div className="overflow-x-auto scrollbar-hidden">
      <nav
        aria-label="Settings sections"
        className="flex w-max min-w-full items-end gap-1 border-b border-border/60"
      >
        {(organizationTab ? [...tabs, organizationTab] : tabs).map((tab) => (
          <SectionTab
            key={tab.id}
            label={tab.label}
            isActive={active === tab.id}
            onSelect={() => appNavigate(tab.path)}
          />
        ))}
      </nav>
    </div>
  );
}
