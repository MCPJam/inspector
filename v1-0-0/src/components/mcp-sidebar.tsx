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
import { SearchDialog } from "@/components/sidebar/search-dialog";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar";

const data = {
  user: {
    name: "MCP Inspector",
    email: "inspector@example.com",
    avatar: "/avatars/shadcn.jpg",
  },
  navMain: [
    {
      title: "Server Management",
      url: "#",
      icon: Server,
      isActive: true,
      items: [
        {
          title: "Connections",
          url: "#servers",
        },
        {
          title: "Configuration",
          url: "#config",
        },
      ],
    },
    {
      title: "MCP Tools",
      url: "#",
      icon: Wrench,
      items: [
        {
          title: "Available Tools",
          url: "#tools",
        },
        {
          title: "Tool History",
          url: "#history",
        },
      ],
    },
    {
      title: "Resources",
      url: "#",
      icon: FolderOpen,
      items: [
        {
          title: "Browse Resources",
          url: "#resources",
        },
        {
          title: "Resource Templates",
          url: "#templates",
        },
      ],
    },
    {
      title: "Prompts",
      url: "#",
      icon: MessageSquare,
      items: [
        {
          title: "Prompt Library",
          url: "#prompts",
        },
        {
          title: "Custom Prompts",
          url: "#custom",
        },
      ],
    },
    {
      title: "Chat Interface",
      url: "#",
      icon: MessageCircle,
      items: [
        {
          title: "Chat Console",
          url: "#chat",
        },
        {
          title: "Chat History",
          url: "#chat-history",
        },
      ],
    },
  ],
};

interface MCPSidebarProps extends React.ComponentProps<typeof Sidebar> {
  onNavigate?: (section: string) => void;
}

export function MCPSidebar({ onNavigate, ...props }: MCPSidebarProps) {
  const handleNavClick = (url: string) => {
    if (onNavigate && url.startsWith("#")) {
      onNavigate(url.slice(1));
    }
  };

  return (
    <Sidebar collapsible="icon" {...props}>
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
        <SearchDialog />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} onItemClick={handleNavClick} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={data.user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}