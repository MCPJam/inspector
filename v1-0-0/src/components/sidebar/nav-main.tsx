"use client";

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
  items?: NavMainItem[];
  isHeader?: boolean;
  isSubItem?: boolean;
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

  const isItemActive = (item: NavMainItem) => {
    return item.isActive || false;
  };

  // Flatten all items including sub-items
  const flattenItems = (items: NavMainItem[]): NavMainItem[] => {
    const flattened: NavMainItem[] = [];
    
    items.forEach((item) => {
      // Add parent item as a section header
      flattened.push({ ...item, isHeader: true });
      
      // Add sub-items
      if (item.items) {
        item.items.forEach((subItem) => {
          flattened.push({ ...subItem, isSubItem: true });
        });
      }
    });
    
    return flattened;
  };

  const flatItems = flattenItems(items);

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {flatItems.map((item, index) => (
            <SidebarMenuItem key={`${item.title}-${index}`}>
              {item.isHeader ? (
                <div className="flex items-center gap-2 px-3 py-2 text-sm font-semibold text-muted-foreground">
                  {item.icon && <item.icon className="h-4 w-4" />}
                  <span>{item.title}</span>
                </div>
              ) : (
                <SidebarMenuButton
                  className={item.isSubItem ? "pl-9" : ""}
                  tooltip={item.title}
                  isActive={isItemActive(item)}
                  onClick={() => handleClick(item.url)}
                >
                  {item.icon && <item.icon />}
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