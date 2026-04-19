import React from "react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import { learnMoreContent } from "@/lib/learn-more-content";
import { LearnMoreHoverCard } from "@/components/learn-more/LearnMoreHoverCard";

interface NavMainItem {
  title: string;
  url: string;
  icon?: React.ElementType;
  isActive?: boolean;
  disabled?: boolean;
  disabledTooltip?: string;
}

interface LearnMoreProps {
  onExpand: (tabId: string, sourceRect?: DOMRect | null) => void;
}

interface NavMainProps {
  items: NavMainItem[];
  onItemClick?: (url: string) => void;
  /** Learn more hover card integration */
  learnMore?: LearnMoreProps | null;
}

export function NavMain({ items, onItemClick, learnMore }: NavMainProps) {
  const { open: sidebarOpen } = useSidebar();

  const handleClick = (url: string) => {
    if (onItemClick) {
      onItemClick(url);
    }
  };

  const isItemActive = (item: NavMainItem) => item.isActive || false;

  const getButtonClassName = (item: NavMainItem) =>
    cn(
      item.disabled
        ? "cursor-not-allowed text-muted-foreground opacity-50 hover:bg-transparent hover:text-muted-foreground active:bg-transparent active:text-muted-foreground"
        : isItemActive(item)
          ? "[&[data-active=true]]:bg-accent cursor-pointer"
          : "cursor-pointer",
    );

  const shouldShowHoverCard = (item: NavMainItem): boolean => {
    if (!learnMore) return false;
    const tabId = item.url.replace("#", "");
    const entry = learnMoreContent[tabId];
    return !!entry?.previewVideoUrl;
  };

  const wrapWithHoverCard = (item: NavMainItem, child: React.ReactNode) => {
    if (!shouldShowHoverCard(item) || !learnMore) return child;
    const tabId = item.url.replace("#", "");
    return (
      <LearnMoreHoverCard
        tabId={tabId}
        onExpand={learnMore.onExpand}
        triggerTooltip={!sidebarOpen ? item.title : undefined}
        triggerTooltipDelayMs={!sidebarOpen ? 1000 : undefined}
        disabledMessage={item.disabled ? item.disabledTooltip : undefined}
      >
        {child}
      </LearnMoreHoverCard>
    );
  };

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const button = (
              <SidebarMenuButton
                tooltip={
                  !item.disabled && (!shouldShowHoverCard(item) || sidebarOpen)
                    ? item.title
                    : undefined
                }
                isActive={!item.disabled && isItemActive(item)}
                onClick={
                  item.disabled ? undefined : () => handleClick(item.url)
                }
                aria-disabled={item.disabled || undefined}
                tabIndex={item.disabled ? -1 : undefined}
                className={getButtonClassName(item)}
              >
                {item.icon && <item.icon className="h-4 w-4" />}
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="truncate">{item.title}</span>
                </span>
              </SidebarMenuButton>
            );

            if (item.disabled) {
              if (shouldShowHoverCard(item)) {
                return (
                  <SidebarMenuItem key={item.title}>
                    {wrapWithHoverCard(
                      item,
                      <div className="w-full cursor-not-allowed">{button}</div>,
                    )}
                  </SidebarMenuItem>
                );
              }

              return (
                <SidebarMenuItem key={item.title}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="w-full cursor-not-allowed">{button}</div>
                    </TooltipTrigger>
                    {item.disabledTooltip && (
                      <TooltipContent side="right" align="center">
                        {item.disabledTooltip}
                      </TooltipContent>
                    )}
                  </Tooltip>
                </SidebarMenuItem>
              );
            }

            return (
              <SidebarMenuItem key={item.title}>
                {wrapWithHoverCard(item, button)}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
