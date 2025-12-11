import * as React from "react";
import {
  Hammer,
  MessageCircle,
  Settings,
  MessageSquareCode,
  BookOpen,
  FlaskConical,
  HandMetal,
  Workflow,
  Box,
  FileCode,
  Activity,
  Fish,
} from "lucide-react";

import { NavMain } from "@/components/sidebar/nav-main";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { MCPIcon } from "@/components/ui/mcp-icon";
import { ThemeSwitcher } from "@/components/sidebar/theme-switcher";
import { DiscordIcon } from "./ui/discord-icon";
import { GitHubIcon } from "./ui/github-icon";

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
      {
        title: "App Builder",
        url: "#app-builder",
        icon: Fish,
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
    ],
  },
  {
    id: "others",
    items: [
      {
        title: "Tracing",
        url: "#tracing",
        icon: Activity,
      },
      {
        title: "OAuth Debugger",
        url: "#oauth-flow",
        icon: Workflow,
      },
      {
        title: "Evals",
        url: "#evals",
        icon: FlaskConical,
      },
      {
        title: "MCP Registry",
        url: "#registry",
        icon: Box,
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
}

export function MCPSidebar({
  onNavigate,
  activeTab,
  ...props
}: MCPSidebarProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);

  const handleNavClick = (url: string) => {
    if (onNavigate && url.startsWith("#")) {
      onNavigate(url.slice(1));
    } else {
      window.open(url, "_blank");
    }
  };

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
            />
            {/* Add subtle divider between sections (except after the last section) */}
            {sectionIndex < navigationSections.length - 1 && (
              <div className="mx-4 my-2 border-t border-border/50" />
            )}
          </React.Fragment>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <ThemeSwitcher />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
