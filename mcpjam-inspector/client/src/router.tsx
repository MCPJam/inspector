import { createBrowserRouter, RouterProvider } from "react-router";
import App from "./App";
import { getAppRouter, setAppRouter } from "./router-ref";

export { getAppRouter };

type AppRouter = ReturnType<typeof createBrowserRouter>;

/**
 * Phase 1 router: a single catch-all route renders the existing App.
 * Subsequent phases will replace the catch-all with a real route tree
 * (chrome layout + tab outlets + nested evals/orgs).
 */
export function createAppRouter(): AppRouter {
  const existing = getAppRouter();
  if (existing) return existing;
  const router = createBrowserRouter([
    {
      path: "*",
      element: <App />,
    },
  ]);
  setAppRouter(router);
  return router;
}

export function AppRouterProvider() {
  const router = createAppRouter();
  return <RouterProvider router={router} />;
}
