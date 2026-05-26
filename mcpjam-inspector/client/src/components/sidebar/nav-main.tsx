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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import { learnMoreContent } from "@/lib/learn-more-content";
import { LearnMoreHoverCard } from "@/components/learn-more/LearnMoreHoverCard";
import { useDismissibleAnnouncement } from "@/hooks/use-dismissible-announcement";

interface NavMainItemAnnouncement {
  id: string;
  badge: string;
  title: string;
  body: string;
}

interface NavMainItem {
  title: string;
  url: string;
  icon?: React.ElementType;
  isActive?: boolean;
  disabled?: boolean;
  disabledTooltip?: string;
  announcement?: NavMainItemAnnouncement;
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
    const tabId = item.url.replace(/^[#/]+/, "");
    const entry = learnMoreContent[tabId];
    return !!entry?.previewVideoUrl;
  };

  const wrapWithHoverCard = (item: NavMainItem, child: React.ReactNode) => {
    if (!shouldShowHoverCard(item) || !learnMore) return child;
    const tabId = item.url.replace(/^[#/]+/, "");
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

  const renderButton = (
    item: NavMainItem,
    options: { suppressTooltip?: boolean; badge?: React.ReactNode } = {},
  ) => (
    <SidebarMenuButton
      tooltip={
        !item.disabled &&
        !options.suppressTooltip &&
        (!shouldShowHoverCard(item) || sidebarOpen)
          ? item.title
          : undefined
      }
      isActive={!item.disabled && isItemActive(item)}
      onClick={item.disabled ? undefined : () => handleClick(item.url)}
      aria-disabled={item.disabled || undefined}
      tabIndex={item.disabled ? -1 : undefined}
      className={getButtonClassName(item)}
    >
      {item.icon && <item.icon className="h-4 w-4" />}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate">{item.title}</span>
        {options.badge}
      </span>
    </SidebarMenuButton>
  );

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            if (item.announcement && !item.disabled) {
              return (
                <AnnouncementNavRow
                  key={item.title}
                  item={{ ...item, announcement: item.announcement }}
                  sidebarOpen={sidebarOpen}
                  renderButton={renderButton}
                />
              );
            }

            const button = renderButton(item);

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

interface AnnouncementNavRowProps {
  item: NavMainItem & { announcement: NavMainItemAnnouncement };
  sidebarOpen: boolean;
  renderButton: (
    item: NavMainItem,
    options?: { suppressTooltip?: boolean; badge?: React.ReactNode },
  ) => React.ReactNode;
}

function AnnouncementNavRow({
  item,
  sidebarOpen,
  renderButton,
}: AnnouncementNavRowProps) {
  const { announcement } = item;
  const { dismissed, dismiss } = useDismissibleAnnouncement(announcement.id);

  const badge = !dismissed ? (
    <Badge
      variant="secondary"
      className="ml-1 px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide"
    >
      {announcement.badge}
    </Badge>
  ) : null;

  const button = renderButton(item, {
    suppressTooltip: !dismissed && sidebarOpen,
    badge,
  });

  if (dismissed || !sidebarOpen) {
    return <SidebarMenuItem>{button}</SidebarMenuItem>;
  }

  // Radix Popover treats a click on the trigger (the nav button) as a request
  // to toggle open → onOpenChange(false) fires, which dismisses. So navigating
  // away by clicking the row also marks the announcement seen.
  return (
    <SidebarMenuItem>
      <Popover
        open
        onOpenChange={(next) => {
          if (!next) dismiss();
        }}
      >
        <PopoverTrigger asChild>{button}</PopoverTrigger>
        <PopoverContent
          side="right"
          align="start"
          sideOffset={12}
          className="w-72"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onFocusOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <div className="font-medium">{announcement.title}</div>
          <p className="mt-1 text-sm text-muted-foreground">
            {announcement.body}
          </p>
          <div className="mt-3 flex justify-end">
            <Button size="sm" onClick={dismiss}>
              Got it
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  );
}
