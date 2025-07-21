"use client";

import * as React from "react";
import {
  Wrench,
  FolderOpen,
  MessageSquare,
  MessageCircle,
  Server,
  Monitor,
  Settings,
} from "lucide-react";

import { NavMain } from "@/components/sidebar/nav-main";
import { NavUser } from "@/components/sidebar/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

const navMainItems = [
  {
    title: "Servers",
    url: "#servers",
    icon: Server,
  },
  {
    title: "Tools",
    url: "#tools",
    icon: Wrench,
  },
  {
    title: "Resources",
    url: "#resources",
    icon: FolderOpen,
  },
  {
    title: "Prompts",
    url: "#prompts",
    icon: MessageSquare,
  },
  {
    title: "Chat",
    url: "#chat",
    icon: MessageCircle,
  },
  {
    title: "Settings",
    url: "#settings",
    icon: Settings,
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
    }
  };

  const data = {
    user: {
      name: "MCP Inspector",
      email: "inspector@example.com",
      avatar: "/avatars/shadcn.jpg",
    },
    navMain: navMainItems.map((item) => ({
      ...item,
      isActive: item.url === `#${activeTab}`,
    })),
  };

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <div className="flex items-center justify-center px-4 py-4">
          <img
            src={
              themeMode === "dark" ? "/mcp_jam_dark.png" : "/mcp_jam_light.png"
            }
            alt="MCP Jam"
            className="h-4 w-auto"
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} onItemClick={handleNavClick} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={data.user} />
      </SidebarFooter>
    </Sidebar>
  );
}
