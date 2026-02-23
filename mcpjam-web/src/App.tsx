import { useEffect, useState } from "react";
import { AppShell } from "./components/layout/AppShell";
import { PlaygroundPage } from "./pages/PlaygroundPage";
import { ServerConnectionsPage } from "./pages/ServerConnectionsPage";

export type AppRoute = "servers" | "playground";

const DEFAULT_ROUTE: AppRoute = "servers";

function getRouteFromHash(hash: string): AppRoute {
  const normalized = hash.replace(/^#/, "");
  if (normalized === "playground") {
    return "playground";
  }
  return DEFAULT_ROUTE;
}

function App() {
  const [route, setRoute] = useState<AppRoute>(() =>
    getRouteFromHash(window.location.hash),
  );

  useEffect(() => {
    if (!window.location.hash) {
      window.location.hash = DEFAULT_ROUTE;
    }

    const onHashChange = () => {
      setRoute(getRouteFromHash(window.location.hash));
    };

    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const handleNavigate = (nextRoute: AppRoute) => {
    window.location.hash = nextRoute;
  };

  return (
    <AppShell route={route} onNavigate={handleNavigate}>
      {route === "servers" ? <ServerConnectionsPage /> : <PlaygroundPage />}
    </AppShell>
  );
}

export default App;
