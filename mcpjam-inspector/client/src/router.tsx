import { createBrowserRouter, RouterProvider, redirect } from "react-router";
import { RouteErrorScreen } from "./components/RouteErrorScreen";
import App, {
  ApiKeysSettingsRoute,
  GithubChecksSettingsRoute,
  GithubInstallCallbackSettingsRoute,
  IntegrationsSettingsRoute,
  ChatAliasRoute,
  ScenariosRoute,
  ConformanceRoute,
  ConformanceRunDetailRoute,
  ConformanceSharedRoute,
  CaniuseCapabilityRoute,
  EnvironmentsRoute,
  CompatibilityRoute,
  ComputerRoute,
  EvalRunSharedRoute,
  EvalsRoute,
  EvaluateRoute,
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
  SessionsRoute,
  SettingsRoute,
  SkillsRoute,
  SupportRoute,
  SwarmsRoute,
  TasksRoute,
  ToolsRoute,
  TracingRoute,
  XAAFlowRoute,
} from "./App";
import { LoginInitiationRoute } from "./components/auth/login-initiation-route";
import { getAppRouter, setAppRouter } from "./router-ref";
import {
  buildHostsPath,
  legacyCiEvalsPathToRunsPath,
  routePaths,
} from "./lib/app-navigation";
import { APP_ROUTES } from "./lib/app-routes";

export { getAppRouter };

type AppRouter = ReturnType<typeof createBrowserRouter>;

function ciEvalsRedirect({ request }: { request: Request }) {
  const url = new URL(request.url);
  return redirect(
    legacyCiEvalsPathToRunsPath(url.pathname, url.search, url.hash)
  );
}

/**
 * The element each route renders, keyed by the path declared in
 * `app-routes.ts`. The table owns WHICH routes exist and what surface each
 * one belongs to; this map owns WHAT they render, because elements can't
 * live in a module the coverage tests import.
 *
 * Loaders (redirects) live here for the same reason.
 */
/**
 * EVERY key here must also be a path in `APP_ROUTES`.
 *
 * `buildRouteChildren` iterates `APP_ROUTES`, not this map, so a route
 * registered ONLY here is never mounted — the URL falls through to the `"*"`
 * catch-all and renders something else entirely, with no error anywhere.
 * The reverse direction throws loudly; this one fails silently, which is why
 * `router.test.tsx` asserts it.
 */
const ROUTE_ELEMENTS: Record<
  string,
  { element?: React.ReactElement; loader?: (args: any) => unknown }
> = {
  "/": { element: <HomeRoute /> },
  home: { element: <HomeRoute /> },
  servers: { element: <ServersRoute /> },
  // Same element as `servers`: the route param selects, and re-mounting a
  // different component for the deep-linked case would lose the connection
  // state Connect has already built.
  "servers/plugins/:pluginId": { element: <ServersRoute /> },
  "servers/:serverId": { element: <ServersRoute /> },
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
  skills: { element: <SkillsRoute /> },
  learning: { element: <LearningRoute /> },
  conformance: { element: <ConformanceRoute /> },
  "conformance/runs/:runId": { element: <ConformanceRunDetailRoute /> },
  "conformance/shared/:token": { element: <ConformanceSharedRoute /> },
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
  // `/user-testing` — the scenario list; `/user-testing/:scenarioId` detail
  // (Insights | Sessions); `/user-testing/:scenarioId/edit` setup/share.
  // Same element: the route param is what selects the view, so a deep-linked
  // scenario survives the auth-gate remounts a cold boot puts it through.
  "user-testing": { element: <ScenariosRoute /> },
  // Static segment, so it outranks `:scenarioId` in React Router's matcher.
  "user-testing/new": { element: <ScenariosRoute /> },
  "user-testing/:scenarioId/edit": { element: <ScenariosRoute /> },
  "user-testing/:scenarioId": { element: <ScenariosRoute /> },
  // Old bookmarks and every session link copied before the rename. Search and
  // hash come along: `/scenarios?host=X&session=Y` has to land on that
  // scenario's session, not just on the list.
  scenarios: {
    loader: ({ request }: { request: Request }) => {
      const url = new URL(request.url);
      return redirect(`${routePaths.userTesting}${url.search}${url.hash}`);
    },
  },
  // `/swarms` — project-scoped Persona → Journey → Run surface (`SwarmsTab`)
  // with Journeys + Sessions views. Same billing feature as scenarios.
  // `/swarms/:swarmId` — one Swarm Run (wave) detail; same surface element.
  swarms: { element: <SwarmsRoute /> },
  // Static segment, so it outranks `:swarmId`.
  "swarms/new": { element: <SwarmsRoute /> },
  "swarms/:swarmId": { element: <SwarmsRoute /> },
  // `/environments` — project environments management. The route component
  // enforces the `project-environments-enabled` flag itself (redirects when
  // off), so registration here does not expose the dark feature.
  environments: { element: <EnvironmentsRoute /> },
  "environments/:environmentId": { element: <EnvironmentsRoute /> },
  // `/sessions` — cross-surface project session feed. The route component
  // enforces the `unified-sessions-enabled` flag itself (redirects when off),
  // so registration here does not expose the dark feature.
  sessions: { element: <SessionsRoute /> },
  playground: { element: <PlaygroundRoute /> },
  support: { element: <SupportRoute /> },
  settings: { element: <SettingsRoute /> },
  "settings/api-keys": { element: <ApiKeysSettingsRoute /> },
  "settings/integrations": { element: <IntegrationsSettingsRoute /> },
  "settings/integrations/github": { element: <GithubChecksSettingsRoute /> },
  // Where GitHub sends the browser back — BOTH the App's setup URL and its
  // OAuth callback point here, and the page tells them apart by which query
  // parameters arrived. One path because GitHub App settings take one of
  // each, and because a second route would be a second place to keep the
  // "pass everything through verbatim" rule.
  "settings/integrations/github/callback": {
    element: <GithubInstallCallbackSettingsRoute />,
  },
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
  "organizations/:orgId/discord": { element: <OrganizationsRoute /> },
  "evals/shared/:token": { element: <EvalRunSharedRoute /> },
  evals: { element: <EvalsRoute /> },
  "evals/create": { element: <EvalsRoute /> },
  "evals/suite/:suiteId": { element: <EvalsRoute /> },
  "evals/suite/:suiteId/runs/:runId": { element: <EvalsRoute /> },
  "evals/suite/:suiteId/test/:testId": { element: <EvalsRoute /> },
  "evals/suite/:suiteId/test/:testId/edit": { element: <EvalsRoute /> },
  "evals/suite/:suiteId/edit": { element: <EvalsRoute /> },
  // Runs mode. `mode` comes from the route table rather than sniffing the URL
  // inside the component, so the two lenses stay one route element with one
  // billing gate.
  "evals/runs": { element: <EvalsRoute mode="runs" /> },
  "evals/runs/create": { element: <EvalsRoute mode="runs" /> },
  "evals/runs/commit/:commitSha": { element: <EvalsRoute mode="runs" /> },
  "evals/runs/suite/:suiteId": { element: <EvalsRoute mode="runs" /> },
  "evals/runs/suite/:suiteId/runs/:runId": {
    element: <EvalsRoute mode="runs" />,
  },
  "evals/runs/suite/:suiteId/test/:testId": {
    element: <EvalsRoute mode="runs" />,
  },
  "evals/runs/suite/:suiteId/test/:testId/edit": {
    element: <EvalsRoute mode="runs" />,
  },
  "evals/runs/suite/:suiteId/edit": { element: <EvalsRoute mode="runs" /> },
  // Evaluate (New). Its own element, so nothing about the shipped Evaluate
  // routes above changes while the redesign is behind a flag.
  evaluate: { element: <EvaluateRoute /> },
  "evaluate/create": { element: <EvaluateRoute /> },
  "evaluate/suite/:suiteId": { element: <EvaluateRoute /> },
  "evaluate/suite/:suiteId/runs/:runId": { element: <EvaluateRoute /> },
  "evaluate/suite/:suiteId/test/:testId": { element: <EvaluateRoute /> },
  "evaluate/suite/:suiteId/test/:testId/edit": {
    element: <EvaluateRoute />,
  },
  "evaluate/suite/:suiteId/edit": { element: <EvaluateRoute /> },
  // Legacy `/ci-evals/*` → `/evals/runs/*`. Rewrite the raw pathname rather
  // than rebuilding from params: the sub-tree is matched with a splat, and the
  // string form preserves commit SHAs and suite ids exactly as encoded.
  // Search and hash come along — commit links carry `?suite=&iteration=`, run
  // links carry `?iteration=&case=&compareTo=`, and anything can carry
  // `?project=`.
  "ci-evals": { loader: ciEvalsRedirect },
  "ci-evals/*": { loader: ciEvalsRedirect },
  billing: { element: <ServersRoute /> },
  // The WorkOS Initiate Login URL. Unlike the entries around it this renders a
  // component of its own rather than Servers: it must call `signIn()` so
  // authkit-js writes a PKCE verifier before the code lands on `/callback`.
  login: { element: <LoginInitiationRoute /> },
  callback: { element: <ServersRoute /> },
  "oauth/callback/*": { element: <ServersRoute /> },
  "*": { element: <ServersRoute /> },
};

/** Route table → react-router children, preserving declaration order. */
function buildRouteChildren() {
  // THE OTHER DIRECTION, and the one that used to fail silently. This function
  // iterates `APP_ROUTES`, so a path registered only in `ROUTE_ELEMENTS` is
  // never mounted: the URL falls through to the `"*"` catch-all and renders a
  // different screen, with nothing in the console and no failing test — a
  // component test mounts the component directly, so it never notices.
  //
  // Checked here rather than only in a test because this is where the asymmetry
  // lives, and because a route that cannot be reached should stop the app at
  // startup rather than reach a user as a wrong page.
  const tablePaths = new Set(APP_ROUTES.map((route) => route.path));
  for (const path of Object.keys(ROUTE_ELEMENTS)) {
    if (!tablePaths.has(path)) {
      throw new Error(
        `[router] element registered for "${path}", which is not in APP_ROUTES — it would never be mounted`
      );
    }
  }

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
      // The data router catches route render errors itself and renders the
      // nearest errorElement — the throw never reaches a React boundary above
      // <RouterProvider>. Without this a crashing route just blanks the app.
      errorElement: <RouteErrorScreen />,
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
