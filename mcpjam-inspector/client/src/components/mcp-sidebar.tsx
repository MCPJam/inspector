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
  Workflow,
  Layers,
  ListTodo,
  SquareSlash,
  MessageCircleQuestionIcon,
  GraduationCap,
  Box,
  LayoutGrid,
  GitBranch,
  UserPlus,
  ShieldCheck,
  Loader2,
} from "lucide-react";
import { usePostHog, useFeatureFlagEnabled } from "posthog-js/react";
import { standardEventProps } from "@/lib/PosthogUtils";

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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
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
import { SidebarCreditUsage } from "@/components/sidebar/sidebar-credit-usage";
import { SidebarTrialCountdown } from "@/components/sidebar/sidebar-trial-countdown";
import { ShareProjectDialog } from "@/components/project/ShareProjectDialog";
import { useUpdateNotification } from "@/hooks/useUpdateNotification";
import { Button } from "@mcpjam/design-system/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { HOSTED_MODE } from "@/lib/config";
import {
  isHostedSidebarTabAllowed,
  normalizeHostedHashTab,
} from "@/lib/hosted-tab-policy";
import {
  buildCiEvalsPath,
  buildEvalsPath,
  navigateApp,
  useAppNavigate,
} from "@/lib/app-navigation";
import { HOSTED_LOCAL_ONLY_TOOLTIP } from "@/lib/hosted-ui";
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
  /** Only show this item when the named feature flag is enabled */
  featureFlag?: string;
  /** Hide this item when the named feature flag is enabled */
  hiddenByFlag?: string;
  /** Extra tab ids that should also highlight this item as active */
  matchTabs?: string[];
  /** Hide this item when billing enforcement is active and the org lacks this feature */
  billingFeature?: BillingFeatureName;
  /** Nested Playground / Runs entries; omit from the flat main menu */
  evalsSubnav?: boolean;
}

interface NavSection {
  id: string;
  items: NavItem[];
}

/**
 * Filter navigation items based on active feature flags.
 * Items with `featureFlag` are shown only when that flag is enabled.
 * Items with `hiddenByFlag` are hidden when that flag is enabled.
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

// Define sections with their respective items
const navigationSections: NavSection[] = [
  {
    id: "connection",
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
        icon: MCPIcon,
        featureFlag: "hosts-enabled",
        matchTabs: ["clients", "host-compare", "computer"],
      },
      {
        title: "Servers",
        url: "/servers",
        icon: MCPIcon,
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
    ],
  },
  {
    id: "mcp-apps",
    items: [
      {
        title: "Views",
        url: "/views",
        icon: Layers,
      },
      {
        title: "Chatboxes",
        url: "/chatboxes",
        icon: Box,
        featureFlag: "sandboxes-enabled",
        billingFeature: "chatboxes",
      },
      {
        title: "Evaluate",
        url: "/evals",
        icon: FlaskConical,
        billingFeature: "evals",
        evalsSubnav: true,
      },
    ],
  },
  {
    id: "others",
    items: [
      {
        title: "Skills",
        url: "/skills",
        icon: SquareSlash,
      },
      {
        title: "Learning",
        url: "/learning",
        icon: GraduationCap,
        featureFlag: "mcpjam-learning",
      },
      {
        title: "Conformance",
        url: "/conformance",
        icon: FlaskConical,
        // MCPJam-internal flag: rollout is restricted to the MCPJam team in
        // PostHog. Keep the `mcpjam-` prefix so it's obvious at a glance that
        // this is an internal-only flag (same convention as `mcpjam-learning`).
        featureFlag: "mcpjam-conformance",
      },
      {
        title: "OAuth Debugger",
        url: "/oauth-flow",
        icon: Workflow,
      },
      {
        title: "XAA Debugger",
        url: "/xaa-flow",
        icon: ShieldCheck,
        featureFlag: "xaa",
      },
      // {
      //   title: "Tracing",
      //   url: "/tracing",
      //   icon: Activity,
      // },
    ],
  },
  {
    id: "primitives",
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

        if (isHostedSidebarTabAllowed(normalizedTab)) {
          return [item];
        }

        if (normalizedTab === "skills") {
          return [
            {
              ...item,
              disabled: true,
              disabledTooltip: HOSTED_LOCAL_ONLY_TOOLTIP,
              hiddenByFlag: undefined,
            },
          ];
        }

        return [];
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

function navigateToEvalsExploreList() {
  navigateApp(buildEvalsPath({ type: "list" }));
}

function navigateToEvalsRunsList() {
  navigateApp(buildCiEvalsPath({ type: "list" }));
}

type EvalsSubnavItem = {
  title: "Runs";
  href: string;
  icon: typeof GitBranch;
  isActive: (activeTab?: string) => boolean;
  onClick: () => void;
};

export function getEvalsSubnavItems(options: {
  evaluateRunsEnabled: boolean;
}): EvalsSubnavItem[] {
  if (!options.evaluateRunsEnabled) return [];
  return [
    {
      title: "Runs",
      href: "/ci-evals",
      icon: GitBranch,
      isActive: (activeTab) => activeTab === "ci-evals",
      onClick: navigateToEvalsRunsList,
    },
  ];
}

export function SidebarEvalsNavGroup({
  title,
  Icon,
  disabled,
  disabledTooltip,
  activeTab,
  showRuns = true,
}: {
  title: string;
  Icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
  disabledTooltip?: string;
  activeTab?: string;
  showRuns?: boolean;
}) {
  const isEvalsFamily = activeTab === "evals" || activeTab === "ci-evals";
  const subnavItems = getEvalsSubnavItems({
    evaluateRunsEnabled: showRuns,
  });
  const hasSubnav = subnavItems.length > 0;

  const parentButton = (
    <SidebarMenuButton
      tooltip={title}
      isActive={!disabled && isEvalsFamily}
      onClick={() => {
        if (disabled) return;
        navigateToEvalsExploreList();
      }}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : undefined}
      className={
        disabled
          ? "cursor-not-allowed text-muted-foreground opacity-50 hover:bg-transparent hover:text-muted-foreground active:bg-transparent active:text-muted-foreground"
          : isEvalsFamily
          ? "[&[data-active=true]]:bg-accent cursor-pointer"
          : "cursor-pointer"
      }
    >
      <Icon className="h-4 w-4" />
      <span>{title}</span>
    </SidebarMenuButton>
  );

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            {disabled ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className="w-full cursor-not-allowed"
                    title={disabledTooltip}
                  >
                    {parentButton}
                  </div>
                </TooltipTrigger>
                {disabledTooltip ? (
                  <TooltipContent side="right" align="center">
                    {disabledTooltip}
                  </TooltipContent>
                ) : null}
              </Tooltip>
            ) : (
              parentButton
            )}
            {hasSubnav ? (
              <SidebarMenuSub>
                {subnavItems.map((item) => {
                  const ItemIcon = item.icon;

                  return (
                    <SidebarMenuSubItem key={item.title}>
                      <SidebarMenuSubButton
                        isActive={!disabled && item.isActive(activeTab)}
                        href={item.href}
                        onClick={(e) => {
                          e.preventDefault();
                          if (disabled) return;
                          item.onClick();
                        }}
                        aria-disabled={disabled || undefined}
                        className={cn(
                          disabled &&
                            "pointer-events-none cursor-not-allowed text-muted-foreground opacity-50 hover:bg-transparent hover:text-muted-foreground active:bg-transparent active:text-muted-foreground"
                        )}
                      >
                        <ItemIcon className="h-4 w-4" />
                        <span className="min-w-0 truncate">{item.title}</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  );
                })}
              </SidebarMenuSub>
            ) : null}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
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
  const posthog = usePostHog();
  const learningFlagEnabled = useFeatureFlagEnabled("mcpjam-learning");
  const sandboxesEnabled = useFeatureFlagEnabled("sandboxes-enabled");
  const registryEnabled = useFeatureFlagEnabled("registry-enabled");
  const evaluateRunsEnabled = useFeatureFlagEnabled("evaluate-ci");
  const xaaEnabled = useFeatureFlagEnabled("xaa");
  const learnMoreEnabled = useFeatureFlagEnabled("learn-more-enabled");
  const conformanceEnabled = useFeatureFlagEnabled("mcpjam-conformance");
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();
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
      posthog.capture("sidebar_nav_clicked", {
        ...standardEventProps("mcp_sidebar"),
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
      // Hosts/Connect and Home are fully rolled out; their nav visibility is
      // purely auth-driven (signed-out users keep the legacy Servers item).
      "hosts-enabled": isAuthenticated,
      "home-page-enabled": isAuthenticated,
      xaa: xaaEnabled === true,
    }),
    [
      learningEnabled,
      sandboxesEnabled,
      registryEnabled,
      conformanceEnabled,
      xaaEnabled,
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
  const utilityItems = user ? [] : signedOutUtilityItems;

  const isNavItemActive = (item: NavItem) =>
    normalizeHostedHashTab(
      item.url.replace(/^[#/]+/, "").split("/")[0] || "servers"
    ) === activeTab ||
    (activeTab !== undefined && (item.matchTabs?.includes(activeTab) ?? false));

  return (
    <>
      <Sidebar collapsible="icon" {...props}>
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
                    "relative z-0 flex w-full cursor-pointer items-center justify-center py-2 transition-opacity duration-200",
                    /* Reserve space for the collapse control so the logo stays visually centered and
                       clicks on the logo never compete with the invisible hit target. */
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
            isLoading={isLoadingProjects}
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
          {visibleNavigationSections.map((section, sectionIndex) => {
            const rawEvalsEntry = section.items.find(
              (item) => item.evalsSubnav
            );
            // Only render Evaluate through the SidebarEvalsNavGroup wrapper
            // (which adds its own SidebarGroup padding) when there's actually
            // a Runs sub-item to nest. Otherwise, fold Evaluate into flatItems
            // so it sits flush with Views and matches sibling spacing.
            const useEvalsSubnavWrapper =
              !!rawEvalsEntry && evaluateRunsEnabled === true;
            const evalsEntry = useEvalsSubnavWrapper
              ? rawEvalsEntry
              : undefined;
            const flatItems = section.items.filter(
              (item) => !item.evalsSubnav || !useEvalsSubnavWrapper
            );

            return (
              <React.Fragment key={section.id}>
                <NavMain
                  items={flatItems.map((item) => ({
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
                {evalsEntry ? (
                  <SidebarEvalsNavGroup
                    title={evalsEntry.title}
                    Icon={evalsEntry.icon}
                    disabled={evalsEntry.disabled}
                    disabledTooltip={evalsEntry.disabledTooltip}
                    activeTab={activeTab}
                    showRuns={evaluateRunsEnabled === true}
                  />
                ) : null}
                {/* Add subtle divider between sections (except after the last section) */}
                {sectionIndex < visibleNavigationSections.length - 1 && (
                  <div className="mx-4 my-1 border-t border-border/50" />
                )}
              </React.Fragment>
            );
          })}
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
                        "flex size-7 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
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
          {!user ? <SidebarCreditUsage className="px-1" includeGuests /> : null}
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
