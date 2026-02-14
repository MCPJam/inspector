import type { ReactNode } from "react";
import type { AppRoute } from "../../App";
import { SidebarNav } from "./SidebarNav";
import { TopHeader } from "./TopHeader";

interface AppShellProps {
  route: AppRoute;
  onNavigate: (route: AppRoute) => void;
  children: ReactNode;
}

export function AppShell({ route, onNavigate, children }: AppShellProps) {
  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">
        <div className="app-shell__logo-wrap">
          <span className="app-shell__logo">MCPJam</span>
        </div>
        <SidebarNav route={route} onNavigate={onNavigate} />
      </aside>
      <div className="app-shell__main">
        <TopHeader route={route} />
        <div className="app-shell__mobile-nav">
          <SidebarNav route={route} onNavigate={onNavigate} compact />
        </div>
        <main className="app-shell__content">{children}</main>
      </div>
    </div>
  );
}
