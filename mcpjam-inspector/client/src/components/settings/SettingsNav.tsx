import { cn } from "@/lib/utils";
import { buildOrganizationPath, useAppNavigate } from "@/lib/app-navigation";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useGithubChecksAvailability } from "@/hooks/useGithubChecksSettings";

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
}

interface TabDescriptor {
  id: SettingsNavSection;
  label: string;
  path: string;
}

const GITHUB_CHECKS_TAB: TabDescriptor = {
  id: "github-checks",
  label: "GitHub Checks",
  path: "/settings/github-checks",
};

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
 * The GitHub Checks tab, isolated behind its own boundary.
 *
 * `useQuery` THROWS when its query errors, and this one errors in two ordinary
 * situations — neither of them exotic:
 *
 *  - **The backend function is not deployed yet.** The Inspector and the Convex
 *    backend release independently, so there is always a window where this
 *    client is newer than the deployment it talks to.
 *  - **The caller is not a member of the active organization.** The backend
 *    throws there deliberately rather than answering `disabled`, because
 *    `disabled` would confirm the org exists. A stale active-org id in local
 *    storage is enough to land on it.
 *
 * Unhandled, either one blanks EVERY settings page, because this nav renders on
 * all of them. So an error means exactly what an explicit `disabled` means: not
 * available. That is the same fail-closed rule the backend's own flag helper
 * applies to `undefined` and to a throw — a surface that cannot confirm it is
 * available is not available.
 */
function GithubChecksNavTab({
  activeOrganizationId,
  active,
  onSelect,
}: {
  activeOrganizationId?: string | null;
  active: SettingsNavSection;
  onSelect: (path: string) => void;
}) {
  const availability = useGithubChecksAvailability(activeOrganizationId);
  if (availability?.state !== "enabled") return null;
  return (
    <SettingsNavTab
      tab={GITHUB_CHECKS_TAB}
      active={active}
      onSelect={onSelect}
    />
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

  // Availability is resolved HERE rather than passed in by each caller. This
  // nav is shared by every settings page, so a prop would have to be threaded
  // through all of them — miss one and the tab silently vanishes from that
  // page, which is the reachability bug that costs you the whole surface. The
  // backend is still the only authority; this just asks it in one place.
  //
  // Omitted rather than disabled when unavailable, like the Organization tab: a
  // disabled tab advertises a surface the viewer cannot reach.
  const tabs: TabDescriptor[] = [
    { id: "general", label: "General", path: "/settings" },
    { id: "api-keys", label: "API Keys", path: "/settings/api-keys" },
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

      {/*
       * `fallback={null}` is the documented "hide this on error" contract of
       * the boundary primitive. The always-present tabs render outside it, so
       * Settings stays navigable even when availability cannot be resolved.
       */}
      <ErrorBoundary fallback={null}>
        <GithubChecksNavTab
          activeOrganizationId={activeOrganizationId}
          active={active}
          onSelect={appNavigate}
        />
      </ErrorBoundary>

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
