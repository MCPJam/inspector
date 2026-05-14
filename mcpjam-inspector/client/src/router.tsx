import { createBrowserRouter, RouterProvider } from "react-router";
import App from "./App";

/**
 * Module-level router reference. Used by non-React callers (IPC bridge,
 * OAuth callback) that need to navigate outside of hook contexts.
 *
 * Populated on first creation by createAppRouter().
 */
type AppRouter = ReturnType<typeof createBrowserRouter>;

let routerRef: AppRouter | null = null;

export function getAppRouter(): AppRouter | null {
  return routerRef;
}

/**
 * Phase 1 router: a single catch-all route renders the existing App.
 * Subsequent phases will replace the catch-all with a real route tree
 * (chrome layout + tab outlets + nested evals/orgs).
 */
export function createAppRouter(): AppRouter {
  if (routerRef) return routerRef;
  routerRef = createBrowserRouter([
    {
      path: "*",
      element: <App />,
    },
  ]);
  return routerRef;
}

export function AppRouterProvider() {
  const router = createAppRouter();
  return <RouterProvider router={router} />;
}
