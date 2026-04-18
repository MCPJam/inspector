import React, { useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
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

interface GuideBubble {
  message: string;
  subMessage?: string;
  onDismiss?: () => void;
}

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
  /** Show a guide bubble on the App Builder item */
  appBuilderBubble?: GuideBubble | null;
  /** Learn more hover card integration */
  learnMore?: LearnMoreProps | null;
}

export function NavMain({
  items,
  onItemClick,
  appBuilderBubble,
  learnMore,
}: NavMainProps) {
  const { open: sidebarOpen } = useSidebar();

  const handleClick = (url: string) => {
    if (onItemClick) {
      onItemClick(url);
    }
  };

  const isItemActive = (item: NavMainItem) => item.isActive || false;

  // Check if this item should show the guide bubble (App Builder when bubble is provided)
  const shouldShowBubble = (item: NavMainItem) =>
    appBuilderBubble && item.url === "#app-builder";

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
    if (shouldShowBubble(item)) return false;
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
                {shouldShowBubble(item) ? (
                  <GuideBubbleWrapper guideBubble={appBuilderBubble!}>
                    {wrapWithHoverCard(item, button)}
                  </GuideBubbleWrapper>
                ) : (
                  wrapWithHoverCard(item, button)
                )}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

interface GuideBubbleWrapperProps {
  children: React.ReactNode;
  guideBubble: GuideBubble;
}

function GuideBubbleWrapper({
  children,
  guideBubble,
}: GuideBubbleWrapperProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);

  useEffect(() => {
    const updatePosition = () => {
      if (ref.current) {
        const rect = ref.current.getBoundingClientRect();
        setPosition({
          top: rect.top + rect.height / 2,
          left: rect.right + 12,
        });
      }
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, []);

  return (
    <div ref={ref}>
      {children}
      {/* Persistent guide bubble rendered via portal */}
      {position &&
        createPortal(
          <div
            className="fixed z-50 animate-in fade-in-0 slide-in-from-left-2 duration-300"
            style={{
              top: position.top,
              left: position.left,
              transform: "translateY(-50%)",
              pointerEvents: "none",
            }}
          >
            <div className="relative bg-primary text-primary-foreground px-3 py-2 rounded-xl shadow-lg whitespace-nowrap">
              {/* Speech bubble tail pointing left */}
              <div className="absolute left-0 top-1/2 -translate-x-[6px] -translate-y-1/2">
                <div className="w-3 h-3 bg-primary rotate-45 rounded-sm" />
              </div>
              {guideBubble.onDismiss && (
                <button
                  onClick={guideBubble.onDismiss}
                  className="absolute -top-2 -right-2 w-5 h-5 flex items-center justify-center rounded-full bg-primary-foreground text-primary text-xs leading-none shadow-md hover:opacity-80 transition-opacity"
                  style={{ pointerEvents: "auto" }}
                  aria-label="Dismiss"
                >
                  ✕
                </button>
              )}
              <div className="relative z-10">
                <p className="text-sm font-medium leading-snug">
                  {guideBubble.message}
                </p>
                {guideBubble.subMessage && (
                  <p className="text-xs opacity-80 mt-0.5">
                    {guideBubble.subMessage}
                  </p>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
