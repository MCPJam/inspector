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
  WebmcpInspectorRoute,
  XAAFlowRoute,
} from "./App";
import { LoginInitiationRoute } from "./components/auth/login-initiation-route";
import LoadingScreen from "./components/LoadingScreen";
import { ProjectRouteBoundary } from "./components/routing/project-route-boundary";
import { LegacyProjectRouteNormalizer } from "./components/routing/legacy-project-route-normalizer";
import { NotFoundRoute } from "./components/routing/not-found-route";
import { getAppRouter, setAppRouter } from "./router-ref";
import {
  buildHostsPath,
  legacyCiEvalsPathToRunsPath,
  routePaths,
} from "./lib/app-navigation";
import { APP_ROUTES, type AppRouteEntry } from "./lib/app-routes";
import {
  buildProjectPath,
  isProjectIdShape,
  parseProjectPath,
  PROJECT_HOME_RELATIVE_PATH,
} from "./lib/project-route";

export { getAppRouter };

type AppRouter = ReturnType<typeof createBrowserRouter>;

/**
 * Legacy `/ci-evals/*` → `/evals/runs/*`, under a project or not.
 *
 * The project prefix comes off before the rewrite and goes back on after: the
 * rewrite is an anchored `^/ci-evals` replacement, so running it against
 * `/p/<id>/ci-evals/...` would match nothing, return the path unchanged, and
 * redirect the route to itself forever.
 */
function ciEvalsRedirect({ request }: { request: Request }) {
  const url = new URL(request.url);
  const scoped = parseProjectPath(url.pathname);
  const logical = scoped ? scoped.relativePath : url.pathname;
  const target = legacyCiEvalsPathToRunsPath(logical, url.search, url.hash);
  return redirect(scoped ? buildProjectPath(scoped.projectId, target) : target);
}

/**
 * A neutral landing for the routes that exist only to be redirected away
 * from (`/callback`, `/billing`, the MCP OAuth callback). They used to render
 * Servers, which meant a sign-in or a checkout return flashed one project's
 * server list before App restored the destination the user actually asked
 * for. App gates all three behind its own loading states anyway.
 */
function AppEntryLandingRoute() {
  return <LoadingScreen />;
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
 * catch-all, with no error anywhere. The reverse direction throws loudly;
 * this one fails silently, which is why `route-elements-coverage.test.ts`
 * asserts it.
 *
 * The elements here are LOGICAL: the same entry is mounted twice, once below
 * `p/:projectId` and once at the root behind the legacy normalizer, so
 * nothing in this map knows about the project prefix.
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
  webmcp: { element: <WebmcpInspectorRoute /> },
  chat: { element: <ChatAliasRoute /> },
  // Catch sub-paths like `/chat/thread-1` so old bookmarks land on
  // Playground instead of the router's `*` catch-all (now an explicit
  // not-found, which is at least honest — it used to render Servers while
  // `pathnameToActiveTab` resolved "chat" → "playground", so the sidebar and
  // the content disagreed).
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
  billing: { element: <AppEntryLandingRoute /> },
  // The WorkOS Initiate Login URL. Unlike the entries around it this renders a
  // component of its own rather than Servers: it must call `signIn()` so
  // authkit-js writes a PKCE verifier before the code lands on `/callback`.
  login: { element: <LoginInitiationRoute /> },
  callback: { element: <AppEntryLandingRoute /> },
  "oauth/callback/*": { element: <AppEntryLandingRoute /> },
  "*": { element: <NotFoundRoute /> },
};

/**
 * The wrapper EVERY loader in the `p/:projectId` sub-tree goes through.
 *
 * It does two things, and both are things a loader gets wrong by omission —
 * which is why this is a wrapper applied to all of them rather than a rule
 * each loader is trusted to remember. Loaders run BEFORE anything renders, so
 * a loader that redirects has already escaped `ProjectRouteBoundary`; nothing
 * downstream can put the user back inside it.
 *
 * 1. A URL claiming a project the path contract rejects gets NO redirect at
 *    all. `/p/none/clients` would otherwise redirect to the unscoped `/hosts`,
 *    the root legacy normalizer would adopt the viewer's own project, and
 *    someone who asked for one project would silently land in another's — while
 *    `/p/none/servers`, which has no loader, correctly reports itself
 *    unavailable. Returning null leaves the URL alone so the boundary renders
 *    the same generic unavailable state for both.
 *
 *    It also breaks a redirect loop: `ciEvalsRedirect` rewrites an anchored
 *    `^/ci-evals`, which matches nothing in `/p/none/ci-evals`, so the loader
 *    handed back the path it was given and redirected the route to itself.
 *
 * 2. A redirect that comes back unscoped is re-scoped to the project in the
 *    URL. A legacy alias under `/p/A` must land WITHIN A: `/p/A/clients` →
 *    `/p/A/hosts`, not `/hosts` (which bounces through the legacy normalizer
 *    and re-resolves the project from persisted state — the long way round to
 *    the same place, with a chance of landing somewhere else).
 *
 * Both read the project from `params`, not from the request URL: the param is
 * what the router matched, and it keeps the wrapper callable without a Request.
 */
function withProjectScopedLoader(
  loader: (args: any) => unknown
): (args: any) => unknown {
  return async (args: any) => {
    const projectId = String(args.params?.projectId ?? "");
    if (!isProjectIdShape(projectId)) return null;
    const result = await loader(args);
    if (!(result instanceof Response)) return result;
    if (result.status < 300 || result.status >= 400) return result;
    const location = result.headers.get("Location");
    if (!location) return result;
    if (parseProjectPath(location)) return result;
    return redirect(buildProjectPath(projectId, location));
  };
}

/**
 * `APP_ROUTES` is still the ONLY catalog. Project routes are filtered out of
 * the root level and mounted twice from the same entries: canonically below
 * `p/:projectId`, and again at the root as legacy normalizers. Copying a
 * second hand-written list into this file is what the scope field exists to
 * avoid.
 */
function routeChildFor(
  route: AppRouteEntry,
  rendered: { element?: React.ReactElement; loader?: (args: any) => unknown }
) {
  const isIndex = route.path === "/";
  return {
    ...(isIndex ? { index: true as const } : { path: route.path }),
    ...rendered,
  };
}

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

  const elementFor = (route: AppRouteEntry) => {
    const rendered = ROUTE_ELEMENTS[route.path];
    if (!rendered) {
      // A route table entry with nothing to render is a first-party bug —
      // the coverage test catches it, but fail loudly if one slips through.
      throw new Error(
        `[router] no element registered for route "${route.path}"`
      );
    }
    return rendered;
  };

  const projectRoutes = APP_ROUTES.filter((route) => route.scope === "project");

  // 1. The canonical registration of every project-owned screen.
  const projectChildren = projectRoutes.map((route) => {
    const rendered = elementFor(route);
    if (route.path === "/") {
      // `/p/<id>` alone is not a destination — project HOME is. Redirecting
      // rather than rendering Home here keeps one canonical URL per screen.
      //
      // Through the same wrapper as every other loader here, so the malformed
      // case cannot drift between them: it was fixed on this loader first and
      // was still live on `clients` and `ci-evals` until the guard moved into
      // the wrapper.
      return {
        index: true as const,
        loader: withProjectScopedLoader(({ params }: any) =>
          redirect(
            buildProjectPath(
              String(params.projectId),
              PROJECT_HOME_RELATIVE_PATH
            )
          )
        ),
      };
    }
    return routeChildFor(route, {
      ...rendered,
      ...(rendered.loader
        ? { loader: withProjectScopedLoader(rendered.loader) }
        : {}),
    });
  });

  // 2. The same paths at the root, rendering a NORMALIZER rather than the
  //    screen. An old link resolves its project first and lands on the
  //    canonical URL; nothing project-owned renders in the meantime, so the
  //    wrong project's screen can never flash.
  const legacyChildren = projectRoutes.map((route) => {
    const rendered = elementFor(route);
    if (rendered.loader) {
      // A redirect renders nothing of its own, so there is nothing to hold
      // back: let it rewrite the path, and the normalizer for the target
      // route adds the project.
      return routeChildFor(route, rendered);
    }
    return routeChildFor(route, {
      element: (
        <LegacyProjectRouteNormalizer>
          {rendered.element}
        </LegacyProjectRouteNormalizer>
      ),
    });
  });

  const unscopedChildren = APP_ROUTES.filter(
    (route) => route.scope !== "project"
  ).map((route) => routeChildFor(route, elementFor(route)));

  return [
    {
      path: "p/:projectId",
      element: <ProjectRouteBoundary />,
      children: [
        ...projectChildren,
        // An unknown path under a real project is still not found. Without
        // this it would fall through to the root `"*"`, which renders the
        // not-found screen outside the project boundary — same message, but
        // the project chrome disappears mid-navigation.
        { path: "*", element: <NotFoundRoute /> },
      ],
    },
    ...legacyChildren,
    ...unscopedChildren,
  ];
}

/**
 * The app router.
 *
 * One shell (`<App>`) over three groups of children:
 *
 *   - `p/:projectId` — every project-owned screen, gated by
 *     `ProjectRouteBoundary`. This is the canonical home of those routes, and
 *     the reason a project is in the address bar at all.
 *   - the same paths at the root, rendering `LegacyProjectRouteNormalizer`,
 *     so links minted before the migration still open and then normalize.
 *   - global and public routes, which never gain a project prefix.
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
