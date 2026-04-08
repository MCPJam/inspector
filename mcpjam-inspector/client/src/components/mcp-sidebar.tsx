import * as React from "react";
import { useState, useEffect, useMemo } from "react";
import {
  Hammer,
  MessageCircle,
  Settings,
  MessageSquareCode,
  BookOpen,
  FlaskConical,
  Workflow,
  Anvil,
  Layers,
  ListTodo,
  SquareSlash,
  MessageCircleQuestionIcon,
  GraduationCap,
  Box,
  LayoutGrid,
  GitBranch,
  Puzzle,
} from "lucide-react";
import { usePostHog, useFeatureFlagEnabled } from "posthog-js/react";

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
} from "@/components/ui/sidebar";
import { useConvexAuth } from "convex/react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { MCPIcon } from "@/components/ui/mcp-icon";
import { SidebarUser } from "@/components/sidebar/sidebar-user";
import { SidebarWorkspaceSelector } from "@/components/sidebar/sidebar-workspace-selector";
import { useUpdateNotification } from "@/hooks/useUpdateNotification";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { HOSTED_MODE } from "@/lib/config";
import {
  listTools,
  type ListToolsResultWithMetadata,
} from "@/lib/apis/mcp-tools-api";
import {
  isMCPApp,
  isOpenAIApp,
  isOpenAIAppAndMCPApp,
} from "@/lib/mcp-ui/mcp-apps-utils";
import {
  isHostedSidebarTabAllowed,
  normalizeHostedHashTab,
} from "@/lib/hosted-tab-policy";
import { buildEvalsHash } from "@/lib/evals-router";
import { navigateToCiEvalsRoute } from "@/lib/ci-evals-router";
import { withTestingSurface } from "@/lib/testing-surface";
import { HOSTED_LOCAL_ONLY_TOOLTIP } from "@/lib/hosted-ui";
import { useLearnMore } from "@/hooks/use-learn-more";
import { LearnMoreExpandedPanel } from "@/components/learn-more/LearnMoreExpandedPanel";
import type { BillingFeatureName } from "@/hooks/useOrganizationBilling";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { Workspace } from "@/state/app-types";

interface NavItem {
  title: string;
  url: string;
  icon: React.ComponentType;
  disabled?: boolean;
  disabledTooltip?: string;
  /** Only show this item when the named feature flag is enabled */
  featureFlag?: string;
  /** Hide this item when the named feature flag is enabled */
  hiddenByFlag?: string;
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
  flags: Record<string, boolean>,
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
  },
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

export function shouldPrefetchSidebarTools(options: {
  hostedMode: boolean;
  isAuthenticated: boolean;
}): boolean {
  const { hostedMode, isAuthenticated } = options;
  // Hosted guests can briefly hydrate stale "connected" local servers before
  // runtime status sync clears them, which causes speculative tools/list calls
  // against guest server configs. Only signed-in hosted users should prefetch.
  return !hostedMode || isAuthenticated;
}

// Define sections with their respective items
const navigationSections: NavSection[] = [
  {
    id: "connection",
    items: [
      {
        title: "Servers",
        url: "#servers",
        icon: MCPIcon,
      },
      {
        title: "Registry",
        url: "#registry",
        icon: LayoutGrid,
        featureFlag: "registry-enabled",
      },
      {
        title: "Chat",
        url: "#chat-v2",
        icon: MessageCircle,
      },
      {
        title: "Sandboxes",
        url: "#sandboxes",
        icon: Box,
        featureFlag: "sandboxes-enabled",
      },
    ],
  },
  {
    id: "mcp-apps",
    items: [
      {
        title: "App Builder",
        url: "#app-builder",
        icon: Anvil,
      },
      {
        title: "Views",
        url: "#views",
        icon: Layers,
      },
      {
        title: "Client Config",
        url: "#client-config",
        icon: Settings,
        featureFlag: "client-config-enabled",
      },
      {
        title: "Evaluate",
        url: "#evals",
        icon: FlaskConical,
        billingFeature: "evals",
        evalsSubnav: true,
        featureFlag: "evals-enabled",
      },
    ],
  },
  {
    id: "others",
    items: [
      {
        title: "Skills",
        url: "#skills",
        icon: SquareSlash,
      },
      {
        title: "Learning",
        url: "#learning",
        icon: GraduationCap,
        featureFlag: "mcpjam-learning",
      },
      {
        title: "OAuth Debugger",
        url: "#oauth-flow",
        icon: Workflow,
      },
      // {
      //   title: "Tracing",
      //   url: "#tracing",
      //   icon: Activity,
      // },
    ],
  },
  {
    id: "primitives",
    items: [
      {
        title: "Tools",
        url: "#tools",
        icon: Hammer,
      },
      {
        title: "Resources",
        url: "#resources",
        icon: BookOpen,
      },
      {
        title: "Prompts",
        url: "#prompts",
        icon: MessageSquareCode,
      },
      {
        title: "Tasks",
        url: "#tasks",
        icon: ListTodo,
      },
    ],
  },
  {
    id: "settings",
    items: [
      {
        title: "Support",
        url: "#support",
        icon: MessageCircleQuestionIcon,
      },
      {
        title: "Settings",
        url: "#settings",
        icon: Settings,
      },
    ],
  },
];

export function getHostedNavigationSections(
  sections: NavSection[],
): NavSection[] {
  return sections
    .map((section) => ({
      ...section,
      items: section.items.flatMap((item) => {
        const normalizedTab = normalizeHostedHashTab(
          item.url.startsWith("#") ? item.url.slice(1) : item.url,
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
  /** Servers to check for app capabilities */
  servers?: Record<string, ServerWithName>;
  /** Workspace state for the sidebar workspace picker */
  workspaces: Record<string, Workspace>;
  activeWorkspaceId: string;
  onSwitchWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: (name: string, switchTo?: boolean) => Promise<string>;
  onDeleteWorkspace: (workspaceId: string) => void;
  isLoadingWorkspaces?: boolean;
  activeOrganizationId?: string;
  billingGateDenied?: Partial<Record<BillingFeatureName, boolean>>;
  billingGateEnforcementActive?: boolean;
  billingUiEnabled?: boolean;
  isCreateWorkspaceDisabled?: boolean;
  createWorkspaceDisabledReason?: string;
}

const APP_BUILDER_VISITED_KEY = "mcp-app-builder-visited";

function navigateToEvalsExploreList() {
  window.location.hash = withTestingSurface(buildEvalsHash({ type: "list" }));
}

function navigateToEvalsRunsList() {
  navigateToCiEvalsRoute({ type: "list" });
}

function SidebarEvalsNavGroup({
  title,
  Icon,
  disabled,
  disabledTooltip,
  activeTab,
}: {
  title: string;
  Icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
  disabledTooltip?: string;
  activeTab?: string;
}) {
  const isEvalsFamily = activeTab === "evals" || activeTab === "ci-evals";
  const exploreHash = withTestingSurface(buildEvalsHash({ type: "list" }));
  const runsHash = "#/ci-evals";

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
            <SidebarMenuSub>
              <SidebarMenuSubItem>
                <SidebarMenuSubButton
                  isActive={activeTab === "evals"}
                  href={exploreHash}
                  onClick={(e) => {
                    e.preventDefault();
                    if (disabled) return;
                    navigateToEvalsExploreList();
                  }}
                  aria-disabled={disabled || undefined}
                  className={
                    disabled ? "pointer-events-none opacity-50" : undefined
                  }
                >
                  <Puzzle className="h-4 w-4" />
                  <span>Playground</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
              <SidebarMenuSubItem>
                <SidebarMenuSubButton
                  isActive={activeTab === "ci-evals"}
                  href={runsHash}
                  onClick={(e) => {
                    e.preventDefault();
                    if (disabled) return;
                    navigateToEvalsRunsList();
                  }}
                  aria-disabled={disabled || undefined}
                  className={
                    disabled ? "pointer-events-none opacity-50" : undefined
                  }
                >
                  <GitBranch className="h-4 w-4" />
                  <span>Runs</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            </SidebarMenuSub>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function MCPSidebar({
  onNavigate,
  activeTab,
  servers = {},
  workspaces,
  activeWorkspaceId,
  onSwitchWorkspace,
  onCreateWorkspace,
  onDeleteWorkspace,
  isLoadingWorkspaces,
  activeOrganizationId,
  billingGateDenied = {},
  billingGateEnforcementActive = false,
  billingUiEnabled = false,
  isCreateWorkspaceDisabled = false,
  createWorkspaceDisabledReason,
  ...props
}: MCPSidebarProps) {
  const posthog = usePostHog();
  const learningFlagEnabled = useFeatureFlagEnabled("mcpjam-learning");
  const sandboxesEnabled = useFeatureFlagEnabled("sandboxes-enabled");
  const clientConfigEnabled = useFeatureFlagEnabled("client-config-enabled");
  const registryEnabled = useFeatureFlagEnabled("registry-enabled");
  const evalsEnabled = useFeatureFlagEnabled("evals-enabled");
  const learnMoreEnabled = useFeatureFlagEnabled("learn-more-enabled");
  const { isAuthenticated } = useConvexAuth();
  const learningEnabled = !!learningFlagEnabled && isAuthenticated;
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const { updateReady, restartAndInstall } = useUpdateNotification();
  const [toolsDataMap, setToolsDataMap] = useState<
    Record<string, ListToolsResultWithMetadata | null>
  >({});
  const [hasVisitedAppBuilder, setHasVisitedAppBuilder] = useState(() => {
    return localStorage.getItem(APP_BUILDER_VISITED_KEY) === "true";
  });
  const learnMore = useLearnMore();

  // Get list of connected server names
  const connectedServerNames = useMemo(() => {
    return Object.entries(servers)
      .filter(([, server]) => server.connectionStatus === "connected")
      .map(([name]) => name);
  }, [servers]);

  // Fetch tools data for connected servers
  useEffect(() => {
    const fetchToolsData = async () => {
      if (
        !shouldPrefetchSidebarTools({
          hostedMode: HOSTED_MODE,
          isAuthenticated,
        }) ||
        connectedServerNames.length === 0
      ) {
        setToolsDataMap({});
        return;
      }

      const newToolsDataMap: Record<
        string,
        ListToolsResultWithMetadata | null
      > = {};

      await Promise.all(
        connectedServerNames.map(async (serverName) => {
          try {
            const result = await listTools({ serverId: serverName });
            newToolsDataMap[serverName] = result;
          } catch {
            newToolsDataMap[serverName] = null;
          }
        }),
      );

      setToolsDataMap(newToolsDataMap);
    };

    fetchToolsData();
  }, [connectedServerNames.join(","), isAuthenticated]);

  // Check if any connected server is an app
  const hasAppServer = useMemo(() => {
    return Object.values(toolsDataMap).some(
      (toolsData) =>
        isMCPApp(toolsData) ||
        isOpenAIApp(toolsData) ||
        isOpenAIAppAndMCPApp(toolsData),
    );
  }, [toolsDataMap]);

  const showAppBuilderBubble =
    hasAppServer && activeTab !== "app-builder" && !hasVisitedAppBuilder;

  const handleNavClick = (url: string) => {
    if (onNavigate && url.startsWith("#")) {
      const section = url.slice(1);
      // Mark App Builder as visited when clicked (always, not just when bubble is visible)
      if (section === "app-builder" && showAppBuilderBubble) {
        localStorage.setItem(APP_BUILDER_VISITED_KEY, "true");
        setHasVisitedAppBuilder(true);
      }
      // Track skills tab opened
      if (section === "skills") {
        posthog.capture("skills_tab_opened");
      }
      onNavigate(section);
    } else {
      window.open(url, "_blank");
    }
  };

  const dismissAppBuilderBubble = () => {
    localStorage.setItem(APP_BUILDER_VISITED_KEY, "true");
    setHasVisitedAppBuilder(true);
  };

  const appBuilderBubble = showAppBuilderBubble
    ? {
        message: "Build your UI app with App Builder.",
        subMessage: "Get started",
        onDismiss: dismissAppBuilderBubble,
      }
    : null;
  const featureFlags = useMemo(
    () => ({
      "mcpjam-learning": !!learningEnabled,
      "sandboxes-enabled": !!sandboxesEnabled && isAuthenticated,
      "client-config-enabled": !!clientConfigEnabled && isAuthenticated,
      "registry-enabled": registryEnabled === true,
      "evals-enabled": !!evalsEnabled,
    }),
    [
      learningEnabled,
      sandboxesEnabled,
      clientConfigEnabled,
      registryEnabled,
      evalsEnabled,
      isAuthenticated,
    ],
  );
  const visibleNavigationSections = filterByFeatureFlags(
    HOSTED_MODE ? hostedNavigationSections : navigationSections,
    featureFlags,
  );

  return (
    <>
      <Sidebar collapsible="icon" {...props}>
        <SidebarHeader>
          <button
            onClick={() => handleNavClick("#servers")}
            className="flex items-center justify-center px-4 py-4 w-full cursor-pointer hover:opacity-80 transition-opacity"
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
          {updateReady && (
            <div className="px-2 pb-2">
              <Button
                size="sm"
                onClick={restartAndInstall}
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground h-7 text-xs font-medium rounded-md"
              >
                Update & Restart
              </Button>
            </div>
          )}
          <SidebarWorkspaceSelector
            activeWorkspaceId={activeWorkspaceId}
            workspaces={workspaces}
            onSwitchWorkspace={onSwitchWorkspace}
            onCreateWorkspace={onCreateWorkspace}
            onDeleteWorkspace={onDeleteWorkspace}
            isLoading={isLoadingWorkspaces}
            onNavigateToSettings={() => handleNavClick("#workspace-settings")}
            isCreateDisabled={isCreateWorkspaceDisabled}
            createDisabledReason={createWorkspaceDisabledReason}
            onLearnMoreExpand={
              learnMoreEnabled ? learnMore.openExpandedModal : undefined
            }
          />
        </SidebarHeader>
        <SidebarContent>
          {visibleNavigationSections.map((section, sectionIndex) => {
            const evalsEntry = section.items.find((item) => item.evalsSubnav);
            const flatItems = section.items.filter((item) => !item.evalsSubnav);

            return (
              <React.Fragment key={section.id}>
                <NavMain
                  items={flatItems.map((item) => ({
                    ...item,
                    isActive: item.url === `#${activeTab}`,
                  }))}
                  onItemClick={handleNavClick}
                  appBuilderBubble={
                    section.id === "mcp-apps" ? appBuilderBubble : null
                  }
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
                  />
                ) : null}
                {/* Add subtle divider between sections (except after the last section) */}
                {sectionIndex < visibleNavigationSections.length - 1 && (
                  <div className="mx-4 my-2 border-t border-border/50" />
                )}
              </React.Fragment>
            );
          })}
        </SidebarContent>
        <SidebarFooter>
          <SidebarUser activeOrganizationId={activeOrganizationId} />
        </SidebarFooter>
      </Sidebar>
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
