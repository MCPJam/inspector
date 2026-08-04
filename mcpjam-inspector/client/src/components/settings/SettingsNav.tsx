import { cn } from "@/lib/utils";
import { buildOrganizationPath, useAppNavigate } from "@/lib/app-navigation";

export type SettingsNavSection =
  | "general"
  | "api-keys"
  | "github-checks"
  | "organization";

interface SettingsNavProps {
  active: SettingsNavSection;
  /**
   * Enables the Organization tab. Without an active org there is nothing to
   * manage, so the tab is omitted rather than disabled.
   */
  activeOrganizationId?: string | null;
  /**
   * Enables the GitHub Checks tab. Availability is decided by the BACKEND
   * (`getGithubChecksSettingsAvailability`), so the caller passes the answer
   * in rather than this component asking. Omitted rather than disabled when
   * unavailable — same reasoning as the Organization tab: a disabled tab
   * advertises a surface the viewer cannot reach.
   */
  githubChecksAvailable?: boolean;
}

/**
 * Top-level Settings sections, shared across `/settings`,
 * `/settings/api-keys`, and the organization page so they read as one
 * Settings surface. Styling mirrors the org page's section tabs.
 */
export function SettingsNav({
  active,
  activeOrganizationId,
  githubChecksAvailable = false,
}: SettingsNavProps) {
  const appNavigate = useAppNavigate();

  const tabs: Array<{
    id: SettingsNavSection;
    label: string;
    path: string;
  }> = [
    { id: "general", label: "General", path: "/settings" },
    { id: "api-keys", label: "API Keys", path: "/settings/api-keys" },
    ...(githubChecksAvailable
      ? [
          {
            id: "github-checks" as const,
            label: "GitHub Checks",
            path: "/settings/github-checks",
          },
        ]
      : []),
    ...(activeOrganizationId
      ? [
          {
            id: "organization" as const,
            label: "Organization",
            path: buildOrganizationPath(activeOrganizationId),
          },
        ]
      : []),
  ];

  return (
    <nav
      aria-label="Settings sections"
      className="flex items-end gap-1 border-b border-border/60"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => {
            if (tab.id !== active) appNavigate(tab.path);
          }}
          aria-current={active === tab.id ? "page" : undefined}
          className={cn(
            "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
            active === tab.id
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
