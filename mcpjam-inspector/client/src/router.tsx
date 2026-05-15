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
  // Flat route entries intentionally render the same App shell. App does not
  // render an Outlet yet, so nested child routes would not make params visible.
  const router = createBrowserRouter([
    { path: "/", element: <App /> },
    { path: "organizations/:orgId", element: <App /> },
    { path: "organizations/:orgId/billing", element: <App /> },
    { path: "organizations/:orgId/models", element: <App /> },
    { path: "evals", element: <App /> },
    { path: "evals/create", element: <App /> },
    { path: "evals/suite/:suiteId", element: <App /> },
    { path: "evals/suite/:suiteId/runs/:runId", element: <App /> },
    { path: "evals/suite/:suiteId/test/:testId", element: <App /> },
    { path: "evals/suite/:suiteId/test/:testId/edit", element: <App /> },
    { path: "evals/suite/:suiteId/edit", element: <App /> },
    { path: "ci-evals", element: <App /> },
    { path: "ci-evals/create", element: <App /> },
    { path: "ci-evals/commit/:commitSha", element: <App /> },
    { path: "ci-evals/suite/:suiteId", element: <App /> },
    { path: "ci-evals/suite/:suiteId/runs/:runId", element: <App /> },
    { path: "ci-evals/suite/:suiteId/test/:testId", element: <App /> },
    { path: "ci-evals/suite/:suiteId/test/:testId/edit", element: <App /> },
    { path: "ci-evals/suite/:suiteId/edit", element: <App /> },
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
