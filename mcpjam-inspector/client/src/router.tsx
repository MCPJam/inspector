import { createBrowserRouter, RouterProvider } from "react-router";
import App, {
  AppBuilderRoute,
  AuthRoute,
  ChatAliasRoute,
  ChatboxesRoute,
  ChatV2Route,
  CiEvalsRoute,
  ConformanceRoute,
  EvalsRoute,
  HostsRoute,
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
      element: <App />,
      children: [
        { index: true, element: <ServersRoute /> },
        { path: "servers", element: <ServersRoute /> },
        { path: "hosts", element: <HostsRoute /> },
        { path: "registry", element: <RegistryRoute /> },
        { path: "tools", element: <ToolsRoute /> },
        { path: "resources", element: <ResourcesRoute /> },
        { path: "prompts", element: <PromptsRoute /> },
        { path: "tasks", element: <TasksRoute /> },
        { path: "auth", element: <AuthRoute /> },
        { path: "skills", element: <SkillsRoute /> },
        { path: "learning", element: <LearningRoute /> },
        { path: "conformance", element: <ConformanceRoute /> },
        { path: "oauth-flow", element: <OAuthFlowRoute /> },
        { path: "xaa-flow", element: <XAAFlowRoute /> },
        { path: "tracing", element: <TracingRoute /> },
        { path: "chat", element: <ChatAliasRoute /> },
        { path: "chat-v2", element: <ChatV2Route /> },
        // `/chatboxes` — the publish-surface tab. Shows
        // Publish / Sessions / Clusters for the chatbox bound 1:1 to
        // the currently-selected host. Navigation between chatboxes
        // flows through the global host bar.
        { path: "chatboxes", element: <ChatboxesRoute /> },
        { path: "app-builder", element: <AppBuilderRoute /> },
        { path: "playground", element: <PlaygroundRoute /> },
        { path: "views", element: <ViewsRoute /> },
        { path: "support", element: <SupportRoute /> },
        { path: "settings", element: <SettingsRoute /> },
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
