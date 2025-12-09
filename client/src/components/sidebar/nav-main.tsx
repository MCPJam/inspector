import React from "react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

interface NavMainItem {
  title: string;
  url: string;
  icon?: React.ElementType;
  isActive?: boolean;
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

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
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
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
