import * as React from "react";
import { useState, useMemo } from "react";
import {
  Hammer,
  House,
  MessageCircle,
  Settings,
  MessageSquareCode,
  BookOpen,
  FlaskConical,
  Boxes,
  Workflow,
  ListTodo,
  MessageCircleQuestionIcon,
  GraduationCap,
  Network,
  LayoutGrid,
  UserPlus,
  Users,
  ShieldCheck,
  Loader2,
  Layers,
  Cable,
  MessagesSquare,
} from "lucide-react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { track } from "@/lib/analytics";

import { NavMain } from "@/components/sidebar/nav-main";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { MCPIcon } from "@/components/ui/mcp-icon";
import { SidebarUser } from "@/components/sidebar/sidebar-user";
import { SidebarContextSwitcher } from "@/components/sidebar/sidebar-context-switcher";
import { SidebarTrialCountdown } from "@/components/sidebar/sidebar-trial-countdown";
import { ShareProjectDialog } from "@/components/project/ShareProjectDialog";
import { useUpdateNotification } from "@/hooks/useUpdateNotification";
import { Button } from "@mcpjam/design-system/button";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { HOSTED_MODE } from "@/lib/config";
import {
  isHostedTabBlocked,
  normalizeHostedHashTab,
} from "@/lib/hosted-tab-policy";
import { useAppNavigate } from "@/lib/app-navigation";
import { useLearnMore } from "@/hooks/use-learn-more";
import { LearnMoreExpandedPanel } from "@/components/learn-more/LearnMoreExpandedPanel";
import {
  useOrganizationBillingStatus,
  type BillingFeatureName,
} from "@/hooks/useOrganizationBilling";
import type { Project } from "@/state/app-types";
import type { OrganizationRouteSection } from "@/lib/app-navigation";

interface NavItem {
  title: string;
  url: string;
  icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
  disabledTooltip?: string;
  /** Optional pill shown next to the label, e.g. "New" */
  badge?: string;
  /** Only show this item when the named feature flag is enabled */
  featureFlag?: string;
  /** Hide this item when the named feature flag is enabled */
  hiddenByFlag?: string;
  /** Extra tab ids that should also highlight this item as active */
  matchTabs?: string[];
  /** Hide this item when billing enforcement is active and the org lacks this feature */
  billingFeature?: BillingFeatureName;
}

interface NavSection {
  id: string;
  /**
   * Section heading rendered above the items ("Explore", "Measure", …).
   * The nav is grouped by what you do with a feature, not by internals.
   */
  label: string;
  items: NavItem[];
}

/**
 * Every flag key the sidebar actually RESOLVES into the `featureFlags` map
 * inside `MCPSidebar`. A nav item's `featureFlag` / `hiddenByFlag` must appear
 * here or the item is invisible forever: `filterByFeatureFlags` reads
 * `flags[key]` as `undefined`, treats it as off, and nothing ever calls the
 * flag — so PostHog shows it as never evaluated and the cause looks like a
 * rollout problem rather than a missing map entry. The Sessions item shipped
 * exactly that way. `mcp-sidebar-feature-flags.test.ts` fails if the two lists
 * drift again.
 */
export const SIDEBAR_RESOLVED_FLAG_KEYS = [
  "mcpjam-learning",
  "sandboxes-enabled",
  "registry-enabled",
  "mcpjam-conformance",
  "mcpjam-compatibility",
  "hosts-enabled",
  "home-page-enabled",
  "xaa",
  "project-environments-enabled",
  "unified-sessions-enabled",
  "evaluate-enabled",
] as const;

/**
 * Filter navigation items based on active feature flags.
 * Items with `featureFlag` are shown only when that flag is enabled.
 * Items with `hiddenByFlag` are hidden when that flag is enabled.
 *
 * A key missing from `flags` counts as OFF — see
 * {@link SIDEBAR_RESOLVED_FLAG_KEYS}.
 */
export function filterByFeatureFlags(
  sections: NavSection[],
  flags: Record<string, boolean>
): NavSection[] {
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        if (item.featureFlag && !flags[item.featureFlag]) return false;
        if (item.hiddenByFlag && flags[item.hiddenByFlag]) return false;
        return true;
      }),
    }))
    .filter((section) => section.items.length > 0);
}

/**
 * Keeps billed nav items visible; marks them disabled when the gate denies access
 * and enforcement is enabled (not soft/disabled).
 *
 * Not used in the main sidebar pipeline — items stay clickable so the shell can
 * show the billing upsell gate. Retained for tests and optional future use.
 */
export function applyBillingGateNavState(
  sections: NavSection[],
  options: {
    billingUiEnabled: boolean;
    /** When true, feature is denied by premiumness (locked). */
    gateDenied: Partial<Record<BillingFeatureName, boolean>>;
    enforcementActive: boolean;
  }
): NavSection[] {
  const { billingUiEnabled, gateDenied, enforcementActive } = options;
  if (!billingUiEnabled || !enforcementActive) {
    return sections;
  }

  return sections.map((section) => ({
    ...section,
    items: section.items.map((item) => {
      if (!item.billingFeature) {
        return item;
      }
      const denied = gateDenied[item.billingFeature] === true;
      if (!denied) {
        return item;
      }
      return {
        ...item,
        disabled: true,
        disabledTooltip: `${item.title} requires a plan upgrade.`,
      };
    }),
  }));
}

// Define sections with their respective items.
// Grouped by intent (Explore / Measure / Verify / Inspect / Educate) per the
// Production Redesign, so the nav reads as five short lists instead of one flat
// column. Flag-gated items that the design didn't enumerate are placed in the
// section that matches what they do: Registry + Environments under Explore,
// Sessions under Measure (it's the cross-surface run feed), Compatibility under
// Verify next to its sibling Conformance.
// Exported so tests can assert against the real nav data (e.g. that Skills is
// not a sidebar item — it lives in the Connect tab switcher).
export const navigationSections: NavSection[] = [
  {
    id: "explore",
    label: "Explore",
    items: [
      {
        title: "Home",
        url: "/home",
        icon: House,
        featureFlag: "home-page-enabled",
      },
      {
        title: "Connect",
        url: "/servers",
        icon: Cable,
        featureFlag: "hosts-enabled",
        matchTabs: ["clients", "host-compare", "computer", "skills"],
      },
      {
        // Legacy fallback for signed-out users (pre-hosts-enabled nav).
        title: "Servers",
        url: "/servers",
        icon: Cable,
        hiddenByFlag: "hosts-enabled",
      },
      {
        title: "Registry",
        url: "/registry",
        icon: LayoutGrid,
        featureFlag: "registry-enabled",
      },
      {
        title: "Playground",
        url: "/playground",
        icon: MessageCircle,
      },
      {
        title: "Environments",
        url: "/environments",
        icon: Layers,
        featureFlag: "project-environments-enabled",
      },
    ],
  },
  {
    id: "measure",
    label: "Measure",
    items: [
      {
        title: "User Testing",
        url: "/user-testing",
        icon: Users,
        featureFlag: "sandboxes-enabled",
        billingFeature: "scenarios",
      },
      {
        title: "Swarms",
        url: "/swarms",
        icon: Network,
        featureFlag: "sandboxes-enabled",
        billingFeature: "scenarios",
      },
      {
        title: "Evaluate",
        url: "/evals",
        icon: FlaskConical,
        billingFeature: "evals",
      },
      {
        // The redesigned Evaluate tab, shown ALONGSIDE the original while it
        // is dogfooded — the point of a second tab is being able to compare
        // them. When the redesign wins, this item takes the "Evaluate" name
        // and the one above is deleted.
        title: "Evaluate (New)",
        url: "/evaluate",
        icon: FlaskConical,
        featureFlag: "evaluate-enabled",
        billingFeature: "evals",
      },
      {
        // Cross-surface session feed (Playground + User Testing + Evals +
        // Swarms). Route-guarded on the same flag (`SessionsRoute`).
        title: "Sessions",
        url: "/sessions",
        icon: MessagesSquare,
        featureFlag: "unified-sessions-enabled",
      },
    ],
  },
  {
    // Auth-flow debuggers and the spec checkers: everything that answers
    // "is this implementation correct?".
    id: "verify",
    label: "Verify",
    items: [
      {
        title: "OAuth Debugger",
        url: "/oauth-flow",
        icon: Workflow,
      },
      {
        title: "XAA Debugger",
        url: "/xaa-flow",
        icon: ShieldCheck,
        badge: "New",
        featureFlag: "xaa",
      },
      {
        title: "Conformance",
        url: "/conformance",
        icon: MCPIcon,
        // MCPJam-internal flag: rollout is restricted to the MCPJam team in
        // PostHog. Keep the `mcpjam-` prefix so it's obvious at a glance that
        // this is an internal-only flag (same convention as `mcpjam-learning`).
        featureFlag: "mcpjam-conformance",
      },
      {
        title: "Compatibility",
        url: "/compatibility",
        icon: Boxes,
        // MCPJam-internal flag (same convention as `mcpjam-conformance`).
        featureFlag: "mcpjam-compatibility",
      },
    ],
  },
  {
    // Raw MCP primitives. Skills is deliberately absent: it's execution-context
    // config, so it lives as a Connect tab (Servers | Client | Computer |
    // Skills) and is reached through that switcher.
    id: "inspect",
    label: "Inspect",
    items: [
      {
        title: "Tools",
        url: "/tools",
        icon: Hammer,
      },
      {
        title: "Resources",
        url: "/resources",
        icon: BookOpen,
      },
      {
        title: "Prompts",
        url: "/prompts",
        icon: MessageSquareCode,
      },
      {
        title: "Tasks",
        url: "/tasks",
        icon: ListTodo,
      },
    ],
  },
  {
    id: "educate",
    label: "Educate",
    items: [
      {
        title: "Learning",
        url: "/learning",
        icon: GraduationCap,
        featureFlag: "mcpjam-learning",
      },
    ],
  },
];

// Footer utility icons for users without an account menu (signed-out): the
// account dropdown normally hosts Settings/Support, so signed-in users only
// see the notification bell here. Same list for local and hosted guests.
const signedOutUtilityItems: NavItem[] = [
  {
    title: "Support",
    url: "/support",
    icon: MessageCircleQuestionIcon,
  },
  {
    title: "Settings",
    url: "/settings",
    icon: Settings,
  },
];

// Neutral placeholder shown while auth is resolving, so signed-in users don't
// see the signed-out nav list flash before their authed items appear.
function SidebarNavSkeleton() {
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {Array.from({ length: 8 }).map((_, i) => (
            <SidebarMenuItem key={i}>
              <SidebarMenuButton disabled>
                <Skeleton className="size-4 rounded" />
                <Skeleton className="h-3.5 w-24 group-data-[collapsible=icon]:hidden" />
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/**
 * Drop the nav items a hosted deployment cannot serve. Only `hostedBlocked`
 * surfaces are dropped: this filter runs BEFORE `filterByFeatureFlags`, so
 * anything it removes is gone with no flag able to bring it back — which is
 * how the Sessions item stayed invisible on app.mcpjam.com (#4210) while it
 * was an allow-list.
 */
export function getHostedNavigationSections(
  sections: NavSection[]
): NavSection[] {
  return sections
    .map((section) => ({
      ...section,
      items: section.items.flatMap((item) => {
        const normalizedTab = normalizeHostedHashTab(
          item.url.replace(/^[#/]+/, "")
        );

        if (isHostedTabBlocked(normalizedTab)) {
          return [];
        }

        return [item];
      }),
    }))
    .filter((section) => section.items.length > 0);
}

const hostedNavigationSections =
  getHostedNavigationSections(navigationSections);

interface MCPSidebarProps extends React.ComponentProps<typeof Sidebar> {
  onNavigate?: (section: string) => void;
  activeTab?: string;
  /** Project state for the sidebar project picker */
  projects: Record<string, Project>;
  activeProjectId: string;
  onSwitchProject: (projectId: string) => void;
  onCreateProject: (name: string, switchTo?: boolean) => Promise<string>;
  onDeleteProject: (projectId: string) => void;
  isLoadingProjects?: boolean;
  activeOrganizationId?: string;
  activeOrganizationName?: string;
  onSwitchOrganization?: (
    organizationId: string,
    section?: OrganizationRouteSection
  ) => void;
  onSwitchActiveOrganization?: (organizationId: string) => void;
  onProjectShared?: (sharedProjectId: string, sourceProjectId?: string) => void;
  billingGateDenied?: Partial<Record<BillingFeatureName, boolean>>;
  billingGateEnforcementActive?: boolean;
  billingUiEnabled?: boolean;
  isCreateProjectDisabled?: boolean;
  createProjectDisabledReason?: string;
  onBeforeSignOut?: () => void | Promise<void>;
}

export function MCPSidebar({
  onNavigate,
  activeTab,
  projects,
  activeProjectId,
  onSwitchProject,
  onCreateProject,
  onDeleteProject,
  isLoadingProjects,
  activeOrganizationId,
  activeOrganizationName,
  onSwitchOrganization,
  onSwitchActiveOrganization,
  onProjectShared,
  billingGateDenied = {},
  billingGateEnforcementActive = false,
  billingUiEnabled = false,
  isCreateProjectDisabled = false,
  createProjectDisabledReason,
  onBeforeSignOut,
  ...props
}: MCPSidebarProps) {
  const learningFlagEnabled = useFeatureFlagEnabled("mcpjam-learning");
  const sandboxesEnabled = useFeatureFlagEnabled("sandboxes-enabled");
  const registryEnabled = useFeatureFlagEnabled("registry-enabled");
  const xaaEnabled = useFeatureFlagEnabled("xaa");
  const learnMoreEnabled = useFeatureFlagEnabled("learn-more-enabled");
  const conformanceEnabled = useFeatureFlagEnabled("mcpjam-conformance");
  const compatibilityEnabled = useFeatureFlagEnabled("mcpjam-compatibility");
  const projectEnvironmentsEnabled = useFeatureFlagEnabled(
    "project-environments-enabled"
  );
  const unifiedSessionsEnabled = useFeatureFlagEnabled(
    "unified-sessions-enabled"
  );
  const evaluateEnabled = useFeatureFlagEnabled("evaluate-enabled");
  const { isAuthenticated, isLoading: isConvexAuthLoading } = useConvexAuth();
  const { user, isLoading: isWorkOsAuthLoading } = useAuth();
  // Until WorkOS + Convex resolve the session we don't yet know guest-vs-authed
  // (`user` is null and `isAuthenticated` is false even for signed-in users).
  // Treat that window as "unknown" so the sidebar renders neutral skeletons
  // instead of flashing the signed-out layout for users who are signed in.
  const authResolving =
    HOSTED_MODE && !user && (isWorkOsAuthLoading || isConvexAuthLoading);
  const learningEnabled = !!learningFlagEnabled && isAuthenticated;
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const { status: updateStatus, restartAndInstall } = useUpdateNotification();
  const showUpdateButton =
    updateStatus.kind === "pending" || updateStatus.kind === "downloaded";
  const updateInstalling =
    updateStatus.kind === "pending" && updateStatus.installRequested;
  const handleUpdateClick = () => {
    if (!updateInstalling) {
      restartAndInstall();
    }
  };
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const learnMore = useLearnMore();
  const appNavigate = useAppNavigate();
  const { state, isMobile } = useSidebar();
  const activeProject = projects[activeProjectId];
  const inviteableProjects = useMemo(() => {
    if (!activeProject?.organizationId) {
      return projects;
    }

    return Object.fromEntries(
      Object.entries(projects).filter(
        ([, project]) => project.organizationId === activeProject.organizationId
      )
    );
  }, [activeProject?.organizationId, projects]);
  const shouldShowInviteCta = isAuthenticated && !!user && !!activeProject;
  const trialBilling = useOrganizationBillingStatus(
    activeProject?.organizationId ?? null,
    { enabled: billingUiEnabled && !!activeProject?.organizationId }
  );
  const trialActive =
    billingUiEnabled &&
    trialBilling?.trialStatus === "active" &&
    !!trialBilling.trialEndsAt;
  const handleTrialUpgradeClick = () => {
    if (!activeProject?.organizationId) return;
    appNavigate(`/organizations/${activeProject.organizationId}/billing`);
  };

  const handleNavClick = (url: string) => {
    if (onNavigate && /^[#/]/.test(url)) {
      const section = url.replace(/^[#/]+/, "");
      track("sidebar_nav_clicked", {
        location: "mcp_sidebar",
        section,
      });
      onNavigate(section);
    } else {
      window.open(url, "_blank");
    }
  };
  const featureFlags = useMemo(
    () => ({
      "mcpjam-learning": !!learningEnabled,
      "sandboxes-enabled": !!sandboxesEnabled && isAuthenticated,
      "registry-enabled": registryEnabled === true,
      "mcpjam-conformance": conformanceEnabled === true,
      "mcpjam-compatibility": compatibilityEnabled === true,
      // Hosts/Connect and Home are fully rolled out; their nav visibility is
      // purely auth-driven (signed-out users keep the legacy Servers item).
      "hosts-enabled": isAuthenticated,
      "home-page-enabled": isAuthenticated,
      xaa: xaaEnabled === true,
      "project-environments-enabled":
        projectEnvironmentsEnabled === true && isAuthenticated,
      // Project-scoped like the two above: the feed needs a project, and
      // `SessionsRoute` renders a "needs a project" empty state without one.
      "unified-sessions-enabled":
        unifiedSessionsEnabled === true && isAuthenticated,
      // Project-scoped like the rows above: every screen behind it needs a
      // project to resolve suites against.
      "evaluate-enabled": evaluateEnabled === true && isAuthenticated,
    }),
    [
      learningEnabled,
      sandboxesEnabled,
      registryEnabled,
      conformanceEnabled,
      compatibilityEnabled,
      xaaEnabled,
      projectEnvironmentsEnabled,
      unifiedSessionsEnabled,
      evaluateEnabled,
      isAuthenticated,
    ]
  );
  const hubNavHash = "#servers";
  const visibleNavigationSections = filterByFeatureFlags(
    HOSTED_MODE ? hostedNavigationSections : navigationSections,
    featureFlags
  );

  // Signed-in users reach Settings/Support via the account menu; only
  // signed-out users (no account menu) get utility icons in the footer.
  // Suppress them while auth is resolving so they don't flash for signed-in users.
  const utilityItems = user || authResolving ? [] : signedOutUtilityItems;

  const isNavItemActive = (item: NavItem) =>
    normalizeHostedHashTab(
      item.url.replace(/^[#/]+/, "").split("/")[0] || "servers"
    ) === activeTab ||
    (activeTab !== undefined && (item.matchTabs?.includes(activeTab) ?? false));

  return (
    <>
      {/* Production Redesign chrome (BB-127): no divider between the linen
          sidebar and the linen top bar — the inset panel's rounded top edge and
          shadow are what separate chrome from content.
          Drop the width, not the color: the border sits on sidebar-container,
          which has no fill of its own (the linen is on sidebar-inner), so a
          transparent border still reveals a 1px strip of the page behind it.
          The variant prefix has to match the primitive's
          `group-data-[side=left]:border-r` or tailwind-merge keeps both and the
          more specific variant rule wins. */}
      <Sidebar
        collapsible="icon"
        className="group-data-[side=left]:border-r-0"
        {...props}
      >
        <SidebarHeader className="gap-1 px-2 pt-1.5 pb-2">
          <div
            className={cn(
              "no-drag",
              state === "collapsed" && !isMobile && "flex justify-center px-0"
            )}
          >
            {isMobile ? (
              <button
                type="button"
                onClick={() => handleNavClick(hubNavHash)}
                className="flex w-full cursor-pointer items-center justify-center px-4 py-3 transition-opacity hover:opacity-80"
              >
                <img
                  src={
                    themeMode === "dark"
                      ? "/mcp_jam_dark.png"
                      : "/mcp_jam_light.png"
                  }
                  alt="MCP Jam"
                  className="h-4 w-auto"
                />
              </button>
            ) : state === "expanded" ? (
              <div className="relative isolate w-full">
                <button
                  type="button"
                  onClick={() => handleNavClick(hubNavHash)}
                  className={cn(
                    "relative z-0 flex w-full cursor-pointer items-center justify-start py-2 transition-opacity duration-200",
                    /* Left-aligned, which lands the mark 16px from the sidebar edge — the
                       same inset the nav rows and the divider use, so the whole rail shares
                       one left margin. It used to be centered, which read as pushed right.
                       `pr-10` still reserves the collapse control's slot so a wider logo
                       can never slide under its hit target. */
                    "px-2 pr-10 hover:opacity-80"
                  )}
                >
                  <img
                    src={
                      themeMode === "dark"
                        ? "/mcp_jam_dark.png"
                        : "/mcp_jam_light.png"
                    }
                    alt="MCP Jam"
                    className="h-4 w-auto"
                  />
                </button>
                <SidebarTrigger
                  className={cn(
                    "absolute top-1/2 right-0 z-20 size-7 -translate-y-1/2 shrink-0",
                    /* pointer-events must stay enabled: if we use pointer-events-none until hover,
                       a click can lose :hover before mouseup/click (Electron / fast moves) and the
                       event never reaches this button. Touch has no hover — use coarse-pointer rule. */
                    "pointer-events-auto opacity-0 transition-opacity duration-200",
                    /* Named group avoids ambiguous group-hover when SidebarProvider also uses group/sidebar-wrapper */
                    "group-hover/sidebar-rail:opacity-100 focus-visible:opacity-100",
                    "[@media(hover:none)]:opacity-100"
                  )}
                  aria-label="Collapse sidebar"
                />
              </div>
            ) : (
              <SidebarTrigger
                className="size-7 shrink-0"
                aria-label="Expand sidebar"
              />
            )}
          </div>
          <SidebarContextSwitcher
            activeProjectId={activeProjectId}
            projects={projects}
            onSwitchProject={onSwitchProject}
            onCreateProject={onCreateProject}
            onDeleteProject={onDeleteProject}
            isLoading={isLoadingProjects || authResolving}
            onNavigateToSettings={() => handleNavClick("#project-settings")}
            isCreateDisabled={isCreateProjectDisabled}
            createDisabledReason={createProjectDisabledReason}
            onLearnMoreExpand={
              learnMoreEnabled ? learnMore.openExpandedModal : undefined
            }
            activeOrganizationId={activeOrganizationId}
            onSwitchOrganization={onSwitchOrganization}
            onSwitchActiveOrganization={onSwitchActiveOrganization}
          />
          {showUpdateButton && (
            <div className="px-3 pt-2">
              <Button
                size="sm"
                onClick={handleUpdateClick}
                aria-disabled={updateInstalling}
                className={cn(
                  "h-5 w-full gap-1 rounded-full bg-primary px-2 text-[11px] font-medium text-primary-foreground hover:bg-primary/90",
                  updateInstalling && "pointer-events-none hover:bg-primary"
                )}
              >
                {updateInstalling && (
                  <Loader2 className="size-2.5 animate-spin" aria-hidden />
                )}
                {updateInstalling ? "Updating…" : "Update"}
              </Button>
            </div>
          )}
        </SidebarHeader>
        <SidebarContent className="gap-0">
          {authResolving ? (
            <SidebarNavSkeleton />
          ) : (
            visibleNavigationSections.map((section, sectionIndex) => {
              return (
                <React.Fragment key={section.id}>
                  <NavMain
                    label={section.label}
                    items={section.items.map((item) => ({
                      ...item,
                      isActive: isNavItemActive(item),
                    }))}
                    onItemClick={handleNavClick}
                    learnMore={
                      learnMoreEnabled
                        ? {
                            onExpand: learnMore.openExpandedModal,
                          }
                        : null
                    }
                  />
                  {/* Add subtle divider between sections (except after the last section) */}
                  {sectionIndex < visibleNavigationSections.length - 1 && (
                    <div className="mx-4 my-1 border-t border-border/50" />
                  )}
                </React.Fragment>
              );
            })
          )}
        </SidebarContent>
        <SidebarFooter>
          {utilityItems.length > 0 ? (
            <div className="flex items-center gap-1 px-1 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:px-0">
              {utilityItems.map((item) => (
                <Tooltip key={item.title}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={item.title}
                      onClick={() => handleNavClick(item.url)}
                      className={cn(
                        "flex size-7 items-center justify-center rounded-md text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                        isNavItemActive(item) &&
                          "bg-sidebar-accent text-sidebar-accent-foreground"
                      )}
                    >
                      {item.icon ? <item.icon className="size-4" /> : null}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{item.title}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          ) : null}
          {shouldShowInviteCta ? (
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Invite team members"
                  onClick={() => setShowInviteDialog(true)}
                >
                  <UserPlus className="h-4 w-4" />
                  <span className="group-data-[collapsible=icon]:hidden">
                    Invite team members
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          ) : null}
          {shouldShowInviteCta && trialActive && trialBilling?.trialEndsAt ? (
            <SidebarTrialCountdown
              trialEndsAt={trialBilling.trialEndsAt}
              trialStartedAt={trialBilling.trialStartedAt}
              onUpgradeClick={handleTrialUpgradeClick}
              className="mt-1"
            />
          ) : null}
          <SidebarUser onBeforeSignOut={onBeforeSignOut} />
        </SidebarFooter>
      </Sidebar>
      {shouldShowInviteCta && user && activeProject ? (
        <ShareProjectDialog
          isOpen={showInviteDialog}
          onClose={() => setShowInviteDialog(false)}
          projectName={activeProject.name}
          projectServers={activeProject.servers}
          sharedProjectId={activeProject.sharedProjectId}
          organizationId={activeProject.organizationId}
          visibility={activeProject.visibility}
          organizationName={activeOrganizationName}
          currentUser={user}
          onProjectShared={onProjectShared}
          availableProjects={inviteableProjects}
          activeProjectId={activeProjectId}
        />
      ) : null}
      {learnMoreEnabled && (
        <LearnMoreExpandedPanel
          tabId={learnMore.expandedTabId}
          sourceRect={learnMore.sourceRect}
          onClose={learnMore.closeExpandedModal}
        />
      )}
    </>
  );
}
