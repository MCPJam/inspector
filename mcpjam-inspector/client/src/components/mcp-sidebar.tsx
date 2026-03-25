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
  GitBranch,
  GraduationCap,
  Box,
  Network,
} from "lucide-react";
import { usePostHog, useFeatureFlagEnabled } from "posthog-js/react";

import { NavMain } from "@/components/sidebar/nav-main";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar";
import { useConvexAuth } from "convex/react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { MCPIcon } from "@/components/ui/mcp-icon";
import { SidebarUser } from "@/components/sidebar/sidebar-user";
import { SidebarWorkspaceSelector } from "@/components/sidebar/sidebar-workspace-selector";
import { useUpdateNotification } from "@/hooks/useUpdateNotification";
import { Button } from "@/components/ui/button";
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
import { HOSTED_LOCAL_ONLY_TOOLTIP } from "@/lib/hosted-ui";
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

export function filterByBillingEntitlements(
  sections: NavSection[],
  billingFeatureAvailability: Partial<Record<BillingFeatureName, boolean>>,
  enforcementActive: boolean,
): NavSection[] {
  if (!enforcementActive) {
    return sections;
  }

  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        if (!item.billingFeature) return true;
        return billingFeatureAvailability[item.billingFeature] !== false;
      }),
    }))
    .filter((section) => section.items.length > 0);
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
        icon: Network,
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
        billingFeature: "sandboxes",
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
        title: "Generate Evals",
        url: "#evals",
        icon: FlaskConical,
        hiddenByFlag: "ci-evals-enabled",
        billingFeature: "evals",
      },
      {
        title: "Evals CI/CD",
        url: "#ci-evals",
        icon: GitBranch,
        featureFlag: "ci-evals-enabled",
        billingFeature: "cicd",
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
  billingFeatureAvailability?: Partial<Record<BillingFeatureName, boolean>>;
  billingEnforcementActive?: boolean;
}

const APP_BUILDER_VISITED_KEY = "mcp-app-builder-visited";

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
  billingFeatureAvailability = {},
  billingEnforcementActive = false,
  ...props
}: MCPSidebarProps) {
  const posthog = usePostHog();
  const ciEvalsEnabled = useFeatureFlagEnabled("ci-evals-enabled");
  const learningFlagEnabled = useFeatureFlagEnabled("mcpjam-learning");
  const sandboxesEnabled = useFeatureFlagEnabled("sandboxes-enabled");
  const clientConfigEnabled = useFeatureFlagEnabled("client-config-enabled");
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
      "ci-evals-enabled": !!ciEvalsEnabled && isAuthenticated,
      "mcpjam-learning": !!learningEnabled,
      "sandboxes-enabled": !!sandboxesEnabled && isAuthenticated,
      "client-config-enabled": !!clientConfigEnabled && isAuthenticated,
    }),
    [
      ciEvalsEnabled,
      learningEnabled,
      sandboxesEnabled,
      clientConfigEnabled,
      isAuthenticated,
    ],
  );
  const visibleNavigationSections = filterByBillingEntitlements(
    filterByFeatureFlags(
      HOSTED_MODE ? hostedNavigationSections : navigationSections,
      featureFlags,
    ),
    billingFeatureAvailability,
    billingEnforcementActive,
  );

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <button
          onClick={() => handleNavClick("#servers")}
          className="flex items-center justify-center px-4 py-4 w-full cursor-pointer hover:opacity-80 transition-opacity"
        >
          <img
            src={
              themeMode === "dark" ? "/mcp_jam_dark.png" : "/mcp_jam_light.png"
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
        />
      </SidebarHeader>
      <SidebarContent>
        {visibleNavigationSections.map((section, sectionIndex) => (
          <React.Fragment key={section.id}>
            <NavMain
              items={section.items.map((item) => ({
                ...item,
                isActive: item.url === `#${activeTab}`,
              }))}
              onItemClick={handleNavClick}
              appBuilderBubble={
                section.id === "mcp-apps" ? appBuilderBubble : null
              }
            />
            {/* Add subtle divider between sections (except after the last section) */}
            {sectionIndex < visibleNavigationSections.length - 1 && (
              <div className="mx-4 my-2 border-t border-border/50" />
            )}
          </React.Fragment>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarUser activeOrganizationId={activeOrganizationId} />
      </SidebarFooter>
    </Sidebar>
  );
}
