import { createBrowserRouter, RouterProvider, redirect } from "react-router";
import App, {
  ApiKeysSettingsRoute,
  GithubChecksSettingsRoute,
  IntegrationsSettingsRoute,
  AuthRoute,
  ChatAliasRoute,
  ChatboxesRoute,
  CiEvalsRoute,
  ConformanceRoute,
  CaniuseCapabilityRoute,
  EnvironmentsRoute,
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
  ScoreResultsRoute,
  ScoreRunnerRoute,
  ServersRedirectRoute,
  ServersRoute,
  SettingsRoute,
  SkillsRoute,
  SupportRoute,
  SwarmsRoute,
  TasksRoute,
  ToolsRoute,
  TracingRoute,
  XAAFlowRoute,
} from "./App";
import { getAppRouter, setAppRouter } from "./router-ref";
import { buildHostsPath, routePaths } from "./lib/app-navigation";
import { APP_ROUTES } from "./lib/app-routes";

export { getAppRouter };

type AppRouter = ReturnType<typeof createBrowserRouter>;

/**
 * The element each route renders, keyed by the path declared in
 * `app-routes.ts`. The table owns WHICH routes exist and what surface each
 * one belongs to; this map owns WHAT they render, because elements can't
 * live in a module the coverage tests import.
 *
 * Loaders (redirects) live here for the same reason.
 */
const ROUTE_ELEMENTS: Record<
  string,
  { element?: React.ReactElement; loader?: (args: any) => unknown }
> = {
  "/": { element: <HomeRoute /> },
  home: { element: <HomeRoute /> },
  servers: { element: <ServersRoute /> },
  // Legacy `/clients` URLs redirect to canonical `/hosts` (the tab was
  // renamed Client → Host). Route through `buildHostsPath` so the
  // `:hostId` deep-link is re-encoded exactly like canonical links
  // (router params arrive decoded; ids with reserved chars would
  // otherwise split into extra path segments and fail to match).
  clients: { loader: () => redirect(buildHostsPath()) },
  "clients/:hostId": {
    loader: ({ params }: any) => redirect(buildHostsPath(params.hostId)),
  },
  "host-compare": { element: <HostCompareRoute /> },
  // Chrome-less host-compare surface for vanity domains (caniuse.dev):
  // App renders this full-bleed (no sidebar/header) and skips the
  // first-run onboarding redirect. `bare` forces the no-sub-nav render
  // even for signed-in users.
  "embed/host-compare": { element: <HostCompareRoute bare /> },
  // score.mcpjam.com: paste a server URL, run the four conformance suites,
  // get one 0-100 number on a private shareable link. Chrome-less like the
  // caniuse surface above, and reachable by guests with no sign-in.
  "embed/score": { element: <ScoreRunnerRoute /> },
  // A stored run, addressable only by its secret token. Deliberately
  // readable with no session at all — the link IS the credential.
  "results/:runToken": { element: <ScoreResultsRoute /> },
  "capabilities/:capabilitySlug": { element: <CaniuseCapabilityRoute /> },
  computer: { element: <ComputerRoute /> },
  hosts: { element: <HostsRoute /> },
  "hosts/:hostId": { element: <HostsRoute /> },
  registry: { element: <RegistryRoute /> },
  tools: { element: <ToolsRoute /> },
  resources: { element: <ResourcesRoute /> },
  prompts: { element: <PromptsRoute /> },
  tasks: { element: <TasksRoute /> },
  auth: { element: <AuthRoute /> },
  skills: { element: <SkillsRoute /> },
  learning: { element: <LearningRoute /> },
  conformance: { element: <ConformanceRoute /> },
  compatibility: { element: <CompatibilityRoute /> },
  "oauth-flow": { element: <OAuthFlowRoute /> },
  "xaa-flow": { element: <XAAFlowRoute /> },
  tracing: { element: <TracingRoute /> },
  chat: { element: <ChatAliasRoute /> },
  // Catch sub-paths like `/chat/thread-1` so old bookmarks land on
  // Playground instead of the router's `*` catch-all (which would
  // render ServersRoute while `pathnameToActiveTab` still resolves
  // "chat" → "playground" — sidebar/content mismatch).
  "chat/*": { element: <ChatAliasRoute /> },
  // `/user-testing` — the scenario list; `/user-testing/:scenarioId` one
  // scenario's detail (share band + Sessions | Clusters). Same element: the
  // route param is what selects the view, so a deep-linked scenario survives
  // the auth-gate remounts a cold boot puts it through.
  "user-testing": { element: <ChatboxesRoute /> },
  // Static segment, so it outranks `:scenarioId` in React Router's matcher.
  "user-testing/new": { element: <ChatboxesRoute /> },
  "user-testing/:scenarioId": { element: <ChatboxesRoute /> },
  // Old bookmarks and every session link copied before the rename. Search and
  // hash come along: `/chatboxes?host=X&session=Y` has to land on that
  // scenario's session, not just on the list.
  chatboxes: {
    loader: ({ request }: { request: Request }) => {
      const url = new URL(request.url);
      return redirect(`${routePaths.userTesting}${url.search}${url.hash}`);
    },
  },
  // `/swarms` — project-scoped Persona → Journey → Run surface (`SwarmsTab`)
  // with Journeys + Sessions views. Same billing feature as chatboxes.
  // `/swarms/:swarmId` — one Swarm Run (wave) detail; same surface element.
  swarms: { element: <SwarmsRoute /> },
  // Static segment, so it outranks `:swarmId`.
  "swarms/new": { element: <SwarmsRoute /> },
  "swarms/:swarmId": { element: <SwarmsRoute /> },
  // `/environments` — project environments management. The route component
  // enforces the `project-environments-enabled` flag itself (redirects when
  // off), so registration here does not expose the dark feature.
  environments: { element: <EnvironmentsRoute /> },
  playground: { element: <PlaygroundRoute /> },
  support: { element: <SupportRoute /> },
  settings: { element: <SettingsRoute /> },
  "settings/api-keys": { element: <ApiKeysSettingsRoute /> },
  "settings/integrations": { element: <IntegrationsSettingsRoute /> },
  "settings/integrations/github": { element: <GithubChecksSettingsRoute /> },
  // Legacy: the page moved under Integrations. Kept as a redirect because the
  // path shipped in docs and in the backend runbook, so links to it exist
  // outside this app. A loader redirect (not an element) so it resolves before
  // anything renders — same shape as the `/clients` → `/hosts` rename above.
  "settings/github-checks": {
    loader: () => redirect("/settings/integrations/github"),
  },
  profile: { element: <ProfileRoute /> },
  "project-settings": { element: <ProjectSettingsRoute /> },
  "client-config": { element: <ServersRedirectRoute /> },
  organizations: { element: <OrganizationsRoute /> },
  "organizations/:orgId": { element: <OrganizationsRoute /> },
  "organizations/:orgId/billing": { element: <OrganizationsRoute /> },
  "organizations/:orgId/models": { element: <OrganizationsRoute /> },
  "organizations/:orgId/slack": { element: <OrganizationsRoute /> },
  evals: { element: <EvalsRoute /> },
  "evals/create": { element: <EvalsRoute /> },
  "evals/suite/:suiteId": { element: <EvalsRoute /> },
  "evals/suite/:suiteId/runs/:runId": { element: <EvalsRoute /> },
  "evals/suite/:suiteId/test/:testId": { element: <EvalsRoute /> },
  "evals/suite/:suiteId/test/:testId/edit": { element: <EvalsRoute /> },
  "evals/suite/:suiteId/edit": { element: <EvalsRoute /> },
  "ci-evals": { element: <CiEvalsRoute /> },
  "ci-evals/create": { element: <CiEvalsRoute /> },
  "ci-evals/commit/:commitSha": { element: <CiEvalsRoute /> },
  "ci-evals/suite/:suiteId": { element: <CiEvalsRoute /> },
  "ci-evals/suite/:suiteId/runs/:runId": { element: <CiEvalsRoute /> },
  "ci-evals/suite/:suiteId/test/:testId": { element: <CiEvalsRoute /> },
  "ci-evals/suite/:suiteId/test/:testId/edit": { element: <CiEvalsRoute /> },
  "ci-evals/suite/:suiteId/edit": { element: <CiEvalsRoute /> },
  billing: { element: <ServersRoute /> },
  callback: { element: <ServersRoute /> },
  "oauth/callback/*": { element: <ServersRoute /> },
  "*": { element: <ServersRoute /> },
};

/** Route table → react-router children, preserving declaration order. */
function buildRouteChildren() {
  return APP_ROUTES.map((route) => {
    const rendered = ROUTE_ELEMENTS[route.path];
    if (!rendered) {
      // A route table entry with nothing to render is a first-party bug —
      // the coverage test catches it, but fail loudly if one slips through.
      throw new Error(
        `[router] no element registered for route "${route.path}"`
      );
    }
    const isIndex = route.path === "/";
    return {
      ...(isIndex ? { index: true as const } : { path: route.path }),
      ...rendered,
    };
  });
}

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
      children: buildRouteChildren(),
    },
  ]);
  setAppRouter(router);
  return router;
}

export function AppRouterProvider() {
  const router = createAppRouter();
  return <RouterProvider router={router} />;
}
