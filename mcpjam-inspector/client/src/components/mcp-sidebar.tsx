import * as React from "react";
import { useState, useEffect, useMemo } from "react";
import {
  Hammer,
  MessageCircle,
  Settings,
  MessageSquareCode,
  BookOpen,
  FlaskConical,
  HandMetal,
  Workflow,
  FileCode,
  Activity,
  Fish,
  ListTodo,
} from "lucide-react";

import { NavMain } from "@/components/sidebar/nav-main";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { MCPIcon } from "@/components/ui/mcp-icon";
import { SidebarUser } from "@/components/sidebar/sidebar-user";
import {
  listTools,
  type ListToolsResultWithMetadata,
} from "@/lib/apis/mcp-tools-api";
import {
  isMCPApp,
  isOpenAIApp,
  isOpenAIAppAndMCPApp,
} from "@/lib/mcp-ui/mcp-apps-utils";
import type { ServerWithName } from "@/hooks/use-app-state";

// Define sections with their respective items
const navigationSections = [
  {
    id: "connection",
    items: [
      {
        title: "Servers",
        url: "#servers",
        icon: MCPIcon,
      },
      {
        title: "Chat",
        url: "#chat-v2",
        icon: MessageCircle,
      },
    ],
  },
  {
    id: "mcp-apps",
    items: [
      {
        title: "App Builder",
        url: "#app-builder",
        icon: Fish,
      },
      {
        title: "Test Cases",
        url: "#evals",
        icon: FlaskConical,
      },
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
        title: "Resource Templates",
        url: "#resource-templates",
        icon: FileCode,
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
    id: "others",
    items: [
      {
        title: "OAuth Debugger",
        url: "#oauth-flow",
        icon: Workflow,
      },
      {
        title: "Tracing",
        url: "#tracing",
        icon: Activity,
      },
    ],
  },
  {
    id: "settings",
    items: [
      {
        title: "Feedback",
        url: "https://github.com/MCPJam/inspector/issues/new",
        icon: HandMetal,
      },
      {
        title: "Settings",
        url: "#settings",
        icon: Settings,
      },
    ],
  },
];

interface MCPSidebarProps extends React.ComponentProps<typeof Sidebar> {
  onNavigate?: (section: string) => void;
  activeTab?: string;
  /** Servers to check for app capabilities */
  servers?: Record<string, ServerWithName>;
}

const APP_BUILDER_VISITED_KEY = "mcp-app-builder-visited";

export function MCPSidebar({
  onNavigate,
  activeTab,
  servers = {},
  ...props
}: MCPSidebarProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
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
      if (connectedServerNames.length === 0) {
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
            const result = await listTools(serverName);
            newToolsDataMap[serverName] = result;
          } catch {
            newToolsDataMap[serverName] = null;
          }
        }),
      );

      setToolsDataMap(newToolsDataMap);
    };

    fetchToolsData();
  }, [connectedServerNames.join(",")]);

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
      onNavigate(section);
    } else {
      window.open(url, "_blank");
    }
  };

  const appBuilderBubble = showAppBuilderBubble
    ? {
        message: "Build your UI app with App Builder.",
        subMessage: "Get started",
      }
    : null;

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
      </SidebarHeader>
      <SidebarContent>
        {navigationSections.map((section, sectionIndex) => (
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
            {sectionIndex < navigationSections.length - 1 && (
              <div className="mx-4 my-2 border-t border-border/50" />
            )}
          </React.Fragment>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarUser />
      </SidebarFooter>
    </Sidebar>
  );
}
