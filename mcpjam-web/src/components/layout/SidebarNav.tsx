import type { AppRoute } from "../../App";

interface SidebarNavProps {
  route: AppRoute;
  onNavigate: (route: AppRoute) => void;
  compact?: boolean;
}

const NAV_ITEMS: Array<{ route: AppRoute; label: string }> = [
  { route: "servers", label: "Server Connections" },
  { route: "playground", label: "LLM Playground" },
];

export function SidebarNav({
  route,
  onNavigate,
  compact = false,
}: SidebarNavProps) {
  return (
    <nav
      aria-label="Primary"
      className={compact ? "compact-nav" : "sidebar-nav"}
    >
      {NAV_ITEMS.map((item) => {
        const isActive = item.route === route;
        return (
          <button
            key={item.route}
            type="button"
            className={isActive ? "nav-btn nav-btn--active" : "nav-btn"}
            onClick={() => onNavigate(item.route)}
          >
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
