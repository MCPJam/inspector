"use client";

import * as React from "react";
import {
  Wrench,
  FolderOpen,
  MessageSquare,
  MessageCircle,
  Server,
  Database,
  Bot,
  Monitor,
} from "lucide-react";

import { NavMain } from "@/components/sidebar/nav-main";
import { NavUser } from "@/components/sidebar/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar";

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
];

interface MCPSidebarProps extends React.ComponentProps<typeof Sidebar> {
  onNavigate?: (section: string) => void;
  activeTab?: string;
}

export function MCPSidebar({ onNavigate, activeTab, ...props }: MCPSidebarProps) {
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
    navMain: navMainItems.map(item => ({
      ...item,
      isActive: item.url === `#${activeTab}`
    }))
  };

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-4 py-2">
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <Monitor className="size-4" />
          </div>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-semibold">MCP Inspector</span>
            <span className="truncate text-xs">Model Context Protocol</span>
          </div>
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