import React from "react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface NavMainItem {
  title: string;
  url: string;
  icon?: React.ElementType;
  isActive?: boolean;
  disabled?: boolean;
  disabledTooltip?: string;
}

interface NavMainProps {
  items: NavMainItem[];
  onItemClick?: (url: string) => void;
}

export function NavMain({ items, onItemClick }: NavMainProps) {
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

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const button = (
              <SidebarMenuButton
                tooltip={!item.disabled ? item.title : undefined}
                isActive={!item.disabled && isItemActive(item)}
                onClick={
                  item.disabled ? undefined : () => handleClick(item.url)
                }
                aria-disabled={item.disabled || undefined}
                tabIndex={item.disabled ? -1 : undefined}
                className={getButtonClassName(item)}
              >
                {item.icon && <item.icon className="h-4 w-4" />}
                <span>{item.title}</span>
              </SidebarMenuButton>
            );

            if (item.disabled) {
              return (
                <SidebarMenuItem key={item.title}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        className="w-full cursor-not-allowed"
                        title={item.disabledTooltip}
                      >
                        {button}
                      </div>
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

            return <SidebarMenuItem key={item.title}>{button}</SidebarMenuItem>;
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
