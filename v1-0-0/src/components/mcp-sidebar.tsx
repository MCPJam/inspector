"use client";

import * as React from "react";
import { MessageCircle, Settings, Telescope } from "lucide-react";

import { NavMain } from "@/components/sidebar/nav-main";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

// Custom MCP Icon component that works with light/dark modes
const MCPIcon = React.forwardRef<
  React.ElementRef<"svg">,
  React.ComponentProps<"svg">
>(({ className, ...props }, ref) => (
  <svg
    ref={ref}
    fill="currentColor"
    fillRule="evenodd"
    height="1em"
    style={{ flex: "none", lineHeight: 1 }}
    viewBox="0 0 24 24"
    width="1em"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    {...props}
  >
    <title>ModelContextProtocol</title>
    <path d="M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z" />
    <path d="M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z" />
  </svg>
));
MCPIcon.displayName = "MCPIcon";

// Define sections with their respective items
const navigationSections = [
  {
    id: "connection",
    items: [
      {
        title: "MCP Servers",
        url: "#servers",
        icon: Telescope,
      },
      {
        title: "Chat",
        url: "#chat",
        icon: MessageCircle,
      },
    ],
  },
  {
    id: "tools",
    items: [
      {
        title: "Tools",
        url: "#tools",
        icon: MCPIcon,
      },
      {
        title: "Resources",
        url: "#resources",
        icon: MCPIcon,
      },
      {
        title: "Prompts",
        url: "#prompts",
        icon: MCPIcon,
      },
    ],
  },
  {
    id: "settings",
    items: [
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
    }
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
      <SidebarFooter>{/* <NavUser user={data.user} /> */}</SidebarFooter>
    </Sidebar>
  );
}
