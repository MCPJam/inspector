import type { AppRoute } from "../../App";

interface TopHeaderProps {
  route: AppRoute;
}

const ROUTE_TITLES: Record<AppRoute, string> = {
  servers: "Server Connections",
  playground: "LLM Playground",
};

export function TopHeader({ route }: TopHeaderProps) {
  return (
    <header className="top-header">
      <div className="top-header__brand">MCPJam Web</div>
      <div className="top-header__title">{ROUTE_TITLES[route]}</div>
    </header>
  );
}
