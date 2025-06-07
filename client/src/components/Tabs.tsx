import {
  Zap,
  Database,
  Network,
  Wrench,
  TrendingUp,
  Shield,
  MessageCircle,
  Bot,
  Sliders,
} from "lucide-react";
import { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { PendingRequest } from "./SamplingTab";

interface TabsProps {
  currentPage: string;
  onPageChange: (page: string) => void;
  serverCapabilities?: ServerCapabilities | null;
  pendingSampleRequests: PendingRequest[];
  shouldDisableAll: boolean;
}

const Tabs = ({
  currentPage,
  onPageChange,
  serverCapabilities,
  pendingSampleRequests,
  shouldDisableAll,
}: TabsProps) => {
  const handlePageChange = (page: string) => {
    onPageChange(page);
    window.location.hash = page;
  };

  const tabs = [
    {
      id: "tools",
      label: "Tools",
      icon: Wrench,
      disabled: !serverCapabilities?.tools || shouldDisableAll,
      color: "text-blue-500",
    },
    {
      id: "chat",
      label: "Chat",
      icon: Bot,
      disabled: shouldDisableAll,
      color: "text-purple-500",
    },
    {
      id: "ping",
      label: "Ping",
      icon: Zap,
      disabled: shouldDisableAll,
      color: "text-yellow-500",
    },
    {
      id: "resources",
      label: "Resources",
      icon: Database,
      disabled: !serverCapabilities?.resources || shouldDisableAll,
      color: "text-green-500",
    },
    {
      id: "prompts",
      label: "Prompts",
      icon: MessageCircle,
      disabled: !serverCapabilities?.prompts || shouldDisableAll,
      color: "text-indigo-500",
    },
    {
      id: "sampling",
      label: "Sampling",
      icon: TrendingUp,
      disabled: shouldDisableAll,
      color: "text-red-500",
      badge:
        pendingSampleRequests.length > 0
          ? pendingSampleRequests.length
          : undefined,
    },
    {
      id: "roots",
      label: "Roots",
      icon: Network,
      disabled: shouldDisableAll,
      color: "text-teal-500",
    },
    {
      id: "auth",
      label: "Auth",
      icon: Shield,
      disabled: shouldDisableAll,
      color: "text-amber-500",
    },
    {
      id: "settings",
      label: "Settings",
      icon: Sliders,
      disabled: shouldDisableAll,
      color: "text-gray-500",
    },
  ];

  return (
    <div className="border-b border-border/50 bg-background">
      <div className="flex items-end justify-center overflow-x-auto px-4">
        {tabs.map((tab) => {
          const IconComponent = tab.icon;
          const isActive = currentPage === tab.id;

          return (
            <button
              key={tab.id}
              onClick={() => handlePageChange(tab.id)}
              disabled={tab.disabled}
              className={`relative flex items-center gap-2 px-4 py-2 text-sm font-medium transition-all duration-200 whitespace-nowrap border-b-2 ${
                isActive
                  ? "bg-background text-foreground border-primary shadow-sm"
                  : "bg-muted/30 text-muted-foreground border-transparent hover:bg-muted/60 hover:text-foreground"
              } disabled:opacity-40 disabled:cursor-not-allowed first:rounded-tl-md last:rounded-tr-md border-l border-r border-t border-border/30 ${
                isActive ? "border-primary/20" : "border-border/20"
              }`}
            >
              <IconComponent
                className={`w-4 h-4 ${isActive ? tab.color : ""}`}
              />
              <span>{tab.label}</span>
              {tab.badge && (
                <span className="bg-red-500 text-white text-xs font-bold rounded-full h-5 w-5 flex items-center justify-center ml-1">
                  {tab.badge}
                </span>
              )}

              {/* Tab connector line */}
              {isActive && (
                <div className="absolute -bottom-0.5 left-0 right-0 h-0.5 bg-primary"></div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default Tabs;
