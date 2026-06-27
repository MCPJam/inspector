import { createBrowserRouter, RouterProvider, redirect } from "react-router";
import App, {
  ApiKeysSettingsRoute,
  AuthRoute,
  ChatAliasRoute,
  ChatboxesRoute,
  CiEvalsRoute,
  ConformanceRoute,
  CompatibilityRoute,
  ComputerRoute,
  EvalsRoute,
  HostCompareRoute,
  HostsRoute,
  HomeRoute,
  LearningRoute,
  OAuthFlowRoute,
  OrganizationsRoute,
  PlaygroundRoute,
  ProfileRoute,
  ProjectSettingsRoute,
  PromptsRoute,
  RegistryRoute,
  ResourcesRoute,
  ServersRedirectRoute,
  ServersRoute,
  SettingsRoute,
  SkillsRoute,
  SupportRoute,
  TasksRoute,
  ToolsRoute,
  TracingRoute,
  ViewsRoute,
  XAAFlowRoute,
} from "./App";
import { getAppRouter, setAppRouter } from "./router-ref";
import { buildHostsPath } from "./lib/app-navigation";

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
    ...(import.meta.env.DEV
      ? [
          {
            path: "__e2e/oauth-debugger",
            lazy: async () => {
              const { OAuthDebuggerE2EHarness } = await import(
                "./components/e2e/OAuthDebuggerE2EHarness"
              );
              return { Component: OAuthDebuggerE2EHarness };
            },
          },
        ]
      : []),
    {
      element: <App />,
      children: [
        { index: true, element: <HomeRoute /> },
        { path: "home", element: <HomeRoute /> },
        { path: "servers", element: <ServersRoute /> },
        // Legacy `/clients` URLs redirect to canonical `/hosts` (the tab was
        // renamed Client → Host). Route through `buildHostsPath` so the
        // `:hostId` deep-link is re-encoded exactly like canonical links
        // (router params arrive decoded; ids with reserved chars would
        // otherwise split into extra path segments and fail to match).
        { path: "clients", loader: () => redirect(buildHostsPath()) },
        {
          path: "clients/:hostId",
          loader: ({ params }) => redirect(buildHostsPath(params.hostId)),
        },
        { path: "host-compare", element: <HostCompareRoute /> },
        { path: "computer", element: <ComputerRoute /> },
        { path: "hosts", element: <HostsRoute /> },
        { path: "hosts/:hostId", element: <HostsRoute /> },
        { path: "registry", element: <RegistryRoute /> },
        { path: "tools", element: <ToolsRoute /> },
        { path: "resources", element: <ResourcesRoute /> },
        { path: "prompts", element: <PromptsRoute /> },
        { path: "tasks", element: <TasksRoute /> },
        { path: "auth", element: <AuthRoute /> },
        { path: "skills", element: <SkillsRoute /> },
        { path: "learning", element: <LearningRoute /> },
        { path: "conformance", element: <ConformanceRoute /> },
        { path: "compatibility", element: <CompatibilityRoute /> },
        { path: "oauth-flow", element: <OAuthFlowRoute /> },
        { path: "xaa-flow", element: <XAAFlowRoute /> },
        { path: "tracing", element: <TracingRoute /> },
        { path: "chat", element: <ChatAliasRoute /> },
        // Catch sub-paths like `/chat/thread-1` so old bookmarks land on
        // Playground instead of the router's `*` catch-all (which would
        // render ServersRoute while `pathnameToActiveTab` still resolves
        // "chat" → "playground" — sidebar/content mismatch).
        { path: "chat/*", element: <ChatAliasRoute /> },
        // `/chatboxes` — publish-surface tab (Publish / Sessions / Clusters)
        // for the chatbox bound 1:1 to the currently-selected host. The
        // Hosts hub at `/hosts` is the primary navigation entry; tests
        // exercise the hosted-OAuth callback path via `/hosts` rather
        // than this route directly.
        { path: "chatboxes", element: <ChatboxesRoute /> },
        { path: "playground", element: <PlaygroundRoute /> },
        { path: "views", element: <ViewsRoute /> },
        { path: "support", element: <SupportRoute /> },
        { path: "settings", element: <SettingsRoute /> },
        { path: "settings/api-keys", element: <ApiKeysSettingsRoute /> },
        { path: "profile", element: <ProfileRoute /> },
        { path: "project-settings", element: <ProjectSettingsRoute /> },
        { path: "client-config", element: <ServersRedirectRoute /> },
        { path: "organizations", element: <OrganizationsRoute /> },
        { path: "organizations/:orgId", element: <OrganizationsRoute /> },
        {
          path: "organizations/:orgId/billing",
          element: <OrganizationsRoute />,
        },
        {
          path: "organizations/:orgId/models",
          element: <OrganizationsRoute />,
        },
        { path: "evals", element: <EvalsRoute /> },
        { path: "evals/create", element: <EvalsRoute /> },
        { path: "evals/suite/:suiteId", element: <EvalsRoute /> },
        {
          path: "evals/suite/:suiteId/runs/:runId",
          element: <EvalsRoute />,
        },
        {
          path: "evals/suite/:suiteId/test/:testId",
          element: <EvalsRoute />,
        },
        {
          path: "evals/suite/:suiteId/test/:testId/edit",
          element: <EvalsRoute />,
        },
        { path: "evals/suite/:suiteId/edit", element: <EvalsRoute /> },
        { path: "ci-evals", element: <CiEvalsRoute /> },
        { path: "ci-evals/create", element: <CiEvalsRoute /> },
        {
          path: "ci-evals/commit/:commitSha",
          element: <CiEvalsRoute />,
        },
        { path: "ci-evals/suite/:suiteId", element: <CiEvalsRoute /> },
        {
          path: "ci-evals/suite/:suiteId/runs/:runId",
          element: <CiEvalsRoute />,
        },
        {
          path: "ci-evals/suite/:suiteId/test/:testId",
          element: <CiEvalsRoute />,
        },
        {
          path: "ci-evals/suite/:suiteId/test/:testId/edit",
          element: <CiEvalsRoute />,
        },
        { path: "ci-evals/suite/:suiteId/edit", element: <CiEvalsRoute /> },
        { path: "billing", element: <ServersRoute /> },
        { path: "callback", element: <ServersRoute /> },
        { path: "oauth/callback/*", element: <ServersRoute /> },
        { path: "*", element: <ServersRoute /> },
      ],
    },
  ]);
  setAppRouter(router);
  return router;
}

export function AppRouterProvider() {
  const router = createAppRouter();
  return <RouterProvider router={router} />;
}
