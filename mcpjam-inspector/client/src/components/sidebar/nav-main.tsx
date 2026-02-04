import React, { useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

interface GuideBubble {
  message: string;
  subMessage?: string;
}

interface NavMainItem {
  title: string;
  url: string;
  icon?: React.ElementType;
  isActive?: boolean;
}

interface NavMainProps {
  items: NavMainItem[];
  onItemClick?: (url: string) => void;
  /** Show a guide bubble on the App Builder item */
  appBuilderBubble?: GuideBubble | null;
}

export function NavMain({
  items,
  onItemClick,
  appBuilderBubble,
}: NavMainProps) {
  const handleClick = (url: string) => {
    if (onItemClick) {
      onItemClick(url);
    }
  };

  const isItemActive = (item: NavMainItem) => item.isActive || false;

  // Check if this item should show the guide bubble (App Builder when bubble is provided)
  const shouldShowBubble = (item: NavMainItem) =>
    appBuilderBubble && item.url === "#app-builder";

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              {shouldShowBubble(item) ? (
                <GuideBubbleWrapper guideBubble={appBuilderBubble!}>
                  <SidebarMenuButton
                    isActive={isItemActive(item)}
                    onClick={() => handleClick(item.url)}
                    className={
                      isItemActive(item)
                        ? "[&[data-active=true]]:bg-accent cursor-pointer"
                        : "cursor-pointer"
                    }
                  >
                    {item.icon && <item.icon className="h-4 w-4" />}
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </GuideBubbleWrapper>
              ) : (
                <SidebarMenuButton
                  tooltip={item.title}
                  isActive={isItemActive(item)}
                  onClick={() => handleClick(item.url)}
                  className={
                    isItemActive(item)
                      ? "[&[data-active=true]]:bg-accent cursor-pointer"
                      : "cursor-pointer"
                  }
                >
                  {item.icon && <item.icon className="h-4 w-4" />}
                  <span>{item.title}</span>
                </SidebarMenuButton>
              )}
            </SidebarMenuItem>
          ))}
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
            className="fixed z-50 pointer-events-none animate-in fade-in-0 slide-in-from-left-2 duration-300"
            style={{
              top: position.top,
              left: position.left,
              transform: "translateY(-50%)",
            }}
          >
            <div className="relative bg-primary text-primary-foreground px-3 py-2 rounded-xl shadow-lg whitespace-nowrap">
              {/* Speech bubble tail pointing left */}
              <div className="absolute left-0 top-1/2 -translate-x-[6px] -translate-y-1/2">
                <div className="w-3 h-3 bg-primary rotate-45 rounded-sm" />
              </div>
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
