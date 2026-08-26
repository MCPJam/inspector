/**
 * App surface manifests — what screens the inspector has, and what a user
 * does on each.
 *
 * This is the SOURCE OF TRUTH for three things that used to drift apart:
 *   - `KNOWN_APP_TAB_SEGMENTS` (client/src/lib/app-navigation.ts), which
 *     decides where `ui_navigate` can go;
 *   - the app atlas in the agent's system prompt (`buildAppAtlas`), which is
 *     how the model knows the app exists at all;
 *   - the route↔surface coverage tests, which fail CI when a new screen
 *     ships without either of the above.
 *
 * Shared, not client-only: the server builds the atlas into the system
 * prompt and never sees the client bundle.
 *
 * ## Adding a screen
 *
 * Add a manifest here and a `kind: "screen"` entry in the route table
 * (client/src/lib/app-routes.ts) pointing at its `id`. The coverage tests
 * fail both ways — a screen route with no manifest, and a manifest no route
 * renders — so an agent-invisible screen cannot ship by omission.
 *
 * `purpose` and `userActivities` are model-facing prose. Write them for
 * someone who has never seen the app: they are the entire basis on which the
 * agent decides where to go.
 */

/** Stable surface id. Also the atlas key and the snapshot-provider key. */
export type AppSurfaceId = (typeof APP_SURFACES)[number]["id"];

export interface AppSurfaceManifest {
  id: string;
  /**
   * The path `ui_navigate` sends the user to. Must be one of this surface's
   * own `routePatterns`.
   */
  canonicalPath: string;
  /**
   * Every route pattern that renders this surface, including deep links and
   * aliases. One surface legitimately owns many (all `evals/**` detail
   * routes are the Evaluate screen), which is why coverage is by id rather
   * than by a one-route/one-manifest string match.
   */
  routePatterns: readonly string[];
  /**
   * Tab segments that resolve to this surface, POST-normalization (see
   * `normalizeHostedHashTab`). These are the `ui_navigate` targets and the
   * values `pathnameToActiveTab` returns — not necessarily the first path
   * segment (`/hosts` resolves to the `clients` tab).
   */
  navSegments: readonly string[];
  /** Human label, matching the sidebar where one exists. */
  title: string;
  /** One line: what this screen is for. Model-facing. */
  purpose: string;
  /** What users actually do here. Model-facing; keep to real actions. */
  userActivities: readonly string[];
  /**
   * Not reachable in hosted deployments — this field is the SOURCE OF TRUTH
   * for that, and `hosted-tab-policy.ts` derives its block list from it. Set
   * it only when the screen genuinely cannot work hosted (Tracing needs the
   * local OTLP collector); a screen that merely isn't ready yet belongs
   * behind a feature flag instead.
   * Kept out of the atlas when the atlas is built for a hosted surface, so
   * the model isn't handed a map to a door that is locked.
   */
  hostedBlocked?: boolean;
  /** A `snapshotApp` provider is registered while this surface is mounted. */
  hasSnapshotProvider?: boolean;
  /**
   * REQUIRED: this surface's agent-tools decision. A surface cannot ship
   * without one — the field is non-optional, so the client typecheck fails,
   * and `agent-tool-coverage.test.ts` enforces each kind's obligations.
   *
   * - `"global"` — this surface's tools live in the always-on catalog
   *   (`buildUiToolsCatalog`), registered app-wide for the whole session.
   *   FROZEN to servers + playground by the coverage test: their tools
   *   self-navigate, so they must stay advertised from every route. New
   *   surfaces use `"group"` instead.
   * - `"group"` — mount-scoped tools: an entry in `SURFACE_TOOL_GROUPS`
   *   plus a `useSurfaceAgentBridge` call in the surface component.
   * - `"none"` — an explicit, reviewed opt-out with a real reason (≥ 20
   *   chars). "We haven't decided" is not a reason; "read-only review
   *   screen" or "admin surface the agent must not automate" is.
   *
   * Observation is a SEPARATE dimension: `hasSnapshotProvider` may be true
   * on a `kind: "none"` surface — a screen the agent may look at but not
   * operate.
   */
  agentTools:
    | { readonly kind: "global" }
    | { readonly kind: "group" }
    | { readonly kind: "none"; readonly reason: string };
  /** Include in the model-facing atlas. */
  showInAtlas: boolean;
}

export const APP_SURFACES = [
  {
    id: "home",
    canonicalPath: "/home",
    routePatterns: ["/", "home"],
    navSegments: ["home"],
    title: "Home",
    purpose:
      "The landing screen: a chat box plus an overview of the workspace and what changed recently.",
    userActivities: [
      "See workspace counts (teammates, projects, servers, eval suites, recent tool executions)",
      "Start a chat with this assistant",
      "Read What's New updates",
      "Connect a recommended MCP server or create a recommended host",
    ],
    agentTools: {
      kind: "none",
      reason:
        "Overview screen; the primary agent entry is the chat itself — no workflow mutations to drive here.",
    },
    showInAtlas: true,
  },
  {
    id: "servers",
    canonicalPath: "/servers",
    routePatterns: ["servers", "servers/plugins/:pluginId", "servers/:serverId"],
    // `client-config` renders nothing of its own (it redirects here), but it
    // IS still a tab segment that resolves to this surface, so it stays a
    // valid `ui_navigate` target and a valid `pathnameToActiveTab` result.
    navSegments: ["servers", "client-config"],
    title: "Connect",
    purpose:
      "Connect and manage the MCP servers in the current project. The starting point for most work — most other screens act on a server connected here.",
    userActivities: [
      "Add an MCP server by URL (HTTP) or command (STDIO)",
      "Connect, disconnect, reconnect, or remove a server",
      "Authorize a server that requires OAuth",
      "Edit a server's transport, headers, environment variables, or auth method",
      "Inspect a connection's status and configuration",
    ],
    agentTools: { kind: "global" },
    showInAtlas: true,
  },
  {
    id: "hosts",
    canonicalPath: "/hosts",
    routePatterns: ["hosts", "hosts/:hostId"],
    navSegments: ["clients"],
    title: "Hosts",
    purpose:
      "Model an MCP client/host (Claude, ChatGPT, Cursor, …) and configure how it behaves — its model, tools, and capabilities.",
    userActivities: [
      "Create a host from a client template",
      "Open a host's editor to set its model, system prompt, and behavior (tool approval, tool discovery)",
      "Attach or detach the project's servers on a host",
      "Duplicate or delete a host",
      "Deep-link to a specific host's canvas",
    ],
    hasSnapshotProvider: true,
    agentTools: { kind: "group" },
    showInAtlas: true,
  },
  {
    id: "host-compare",
    canonicalPath: "/host-compare",
    routePatterns: ["host-compare", "capabilities/:capabilitySlug"],
    navSegments: ["host-compare"],
    title: "Compare",
    purpose:
      "Compare MCP feature support across hosts — which clients implement which parts of the protocol.",
    userActivities: [
      "Compare capability support across several hosts",
      "Open a single capability's support page",
    ],
    hasSnapshotProvider: true,
    agentTools: {
      kind: "none",
      reason:
        "Read-only comparison matrix; nothing to operate, but snapshot-only for observability so the agent can see which hosts and capabilities are being compared.",
    },
    showInAtlas: true,
  },
  {
    id: "computer",
    canonicalPath: "/computer",
    routePatterns: ["computer"],
    navSegments: ["computer"],
    title: "Computer",
    purpose:
      "A project's cloud sandbox — the environment that runs STDIO servers, skills, and agent harnesses.",
    userActivities: [
      "Start or hibernate the project's computer",
      "Reset or delete the computer",
      "Open a terminal (human-only)",
    ],
    hasSnapshotProvider: true,
    agentTools: { kind: "group" },
    showInAtlas: true,
  },
  {
    id: "registry",
    canonicalPath: "/registry",
    routePatterns: ["registry"],
    navSegments: ["registry"],
    title: "Registry",
    purpose:
      "Browse organization-shared MCP servers and mirrors of the Claude and ChatGPT connector directories, and install them into the current project.",
    userActivities: [
      "Share a server with the organization",
      "Search a mirrored connector directory (Claude or ChatGPT) by name, description, tool or skill name",
      "Switch between the Claude and ChatGPT directories",
      "Install a directory or organization server into the project",
      "Choose which endpoint a multi-region connector uses, or enter their own instance URL",
    ],
    hasSnapshotProvider: true,
    agentTools: { kind: "group" },
    showInAtlas: true,
  },
  {
    id: "playground",
    canonicalPath: "/playground",
    routePatterns: ["playground"],
    // `chat` renders nothing of its own (it redirects here), but it IS still
    // a tab segment that resolves to this surface — so it stays a valid
    // `ui_navigate` target. Same split as `client-config` → Connect.
    navSegments: ["playground", "chat"],
    title: "Playground",
    purpose:
      "Test a connected MCP server against a real model, and preview MCP Apps / ChatGPT apps UI. This is where tool calls are actually run and their results rendered.",
    userActivities: [
      "Chat with a model that has the selected servers' tools",
      "Select a tool and fill in its parameters",
      "Execute a tool and inspect the result",
      "Emulate app context: theme, device, display mode, locale, time zone",
    ],
    hasSnapshotProvider: true,
    agentTools: { kind: "global" },
    showInAtlas: true,
  },
  {
    // The surface id stays `scenarios` — it keys the billing feature, the
    // agent tool group, and the Convex tables. Only the product name and the
    // URL changed.
    id: "scenarios",
    canonicalPath: "/user-testing",
    routePatterns: [
      "user-testing",
      "user-testing/new",
      "user-testing/:scenarioId/edit",
      "user-testing/:scenarioId",
    ],
    navSegments: ["scenarios"],
    title: "User Testing",
    purpose:
      "Share a scenario — one client, one server — with real people, then review the sessions they had with it.",
    userActivities: [
      "Create a scenario (pick a server, a client, and who can open it)",
      "Browse the project's user-testing scenarios and how many testers each has had",
      "Open a scenario to copy its share link or invite testers by email",
      "Review a scenario's tester sessions (trace, chat, raw)",
      "Review the feedback clusters across one scenario's sessions",
      "Delete a scenario (unpublish it; the client stays in Connect)",
    ],
    hasSnapshotProvider: true,
    agentTools: { kind: "group" },
    showInAtlas: true,
  },
  {
    id: "swarms",
    canonicalPath: "/swarms",
    routePatterns: ["swarms", "swarms/new", "swarms/:swarmId"],
    navSegments: ["swarms"],
    title: "Swarms",
    purpose:
      "Run many simulated agent sessions against your hosts at scale: define a persona, give it a goal across one or more hosts, launch a run, and review how each session did.",
    userActivities: [
      "Create a persona (a simulated user with a role and personality)",
      "Set up a goal a persona pursues across one or more hosts",
      "Launch a goal run that fans out many sessions and spends quota",
      "Open a Swarm Run detail to review score, insights, and sessions",
      "Review each run's sessions, readiness, and goal-completion scores",
      "Promote a strong session into an eval test case",
    ],
    hasSnapshotProvider: true,
    agentTools: { kind: "group" },
    showInAtlas: true,
  },
  {
    id: "project-environments",
    canonicalPath: "/environments",
    routePatterns: ["environments", "environments/:environmentId"],
    navSegments: ["environments"],
    title: "Environments",
    purpose:
      "Manage the project's environments — named bundles of one client, an optional server group, and optional pinned skills that eval suites and goals run against.",
    userActivities: [
      "Create or edit an environment (name, client, server group, skills)",
      "Archive or restore an environment",
      "Review which client and server group an environment resolves to",
    ],
    agentTools: {
      kind: "none",
      reason:
        "Admin-flavored configuration surface behind a rollout flag; no agent automation until the feature is generally available.",
    },
    // The Atlas is intentionally STATIC — it cannot read
    // `project-environments-enabled`, so advertising `/environments` would send
    // the agent to a surface that redirects on every flag-off project. Flip to
    // `true` when the flag is retired at GA.
    showInAtlas: false,
  },
  {
    id: "sessions",
    canonicalPath: "/sessions",
    routePatterns: ["sessions"],
    navSegments: ["sessions"],
    title: "Sessions",
    purpose:
      "Browse every conversation in the project in one feed — Playground chats, User Testing sessions, eval iterations, and swarm runs — filter by source, and search by title.",
    userActivities: [
      "Browse the project's sessions across all surfaces, newest first",
      "Filter sessions by source (Playground, User Testing, Eval, Swarm) or status",
      "Search sessions by title",
      "Open a session to review its transcript",
    ],
    agentTools: {
      kind: "none",
      reason:
        "Read-only browse surface behind a rollout flag; no agent automation until the unified feed is generally available.",
    },
    // The Atlas is intentionally STATIC — it cannot read
    // `unified-sessions-enabled`, so advertising `/sessions` would send the
    // agent to a surface that redirects on every flag-off project. Flip to
    // `true` when the flag is retired at GA. (Same rationale as
    // project-environments.)
    showInAtlas: false,
  },
  {
    id: "evals",
    canonicalPath: "/evals",
    routePatterns: [
      "evals",
      "evals/create",
      "evals/suite/:suiteId",
      "evals/suite/:suiteId/edit",
      "evals/suite/:suiteId/runs/:runId",
      "evals/suite/:suiteId/test/:testId",
      "evals/suite/:suiteId/test/:testId/edit",
      "evals/runs",
      "evals/runs/create",
      "evals/runs/commit/:commitSha",
      "evals/runs/suite/:suiteId",
      "evals/runs/suite/:suiteId/edit",
      "evals/runs/suite/:suiteId/runs/:runId",
      "evals/runs/suite/:suiteId/test/:testId",
      "evals/runs/suite/:suiteId/test/:testId/edit",
    ],
    navSegments: ["evals"],
    title: "Evaluate",
    purpose:
      "Build and run eval suites against a host: test cases with expected tool calls, scored over repeated runs. Two lenses over the same suites — Suites (`/evals`) authors and runs them; Runs (`/evals/runs`) reviews the results CI already produced, keyed by commit.",
    userActivities: [
      "Create or edit an eval suite and its test cases",
      "Run a suite and watch its runs",
      "Generate suggested test cases for a suite",
      "Open a run to inspect each step, tool call, and score",
      "Compare runs",
      "Review eval results for a commit under Runs",
      "Open a CI run's details under Runs",
    ],
    hasSnapshotProvider: true,
    // Authoring tools register from Suites mode only. Runs mode is read-only
    // review of results CI already produced (runs start from CI, not this
    // screen), so it contributes its snapshot but no tools.
    agentTools: { kind: "group" },
    showInAtlas: true,
  },
  {
    // Evaluate (New): the redesigned Evaluate tab, behind
    // `evaluate-enabled`. A SEPARATE surface rather than a variant of
    // `evals` so the shipped tab keeps its routes, its agent tools, and its
    // behaviour untouched while this one is dogfooded. It is deleted (and its
    // routes folded into `evals`) once the redesign replaces the original.
    id: "evaluate",
    canonicalPath: "/evaluate",
    routePatterns: [
      "evaluate",
      "evaluate/create",
      "evaluate/suite/:suiteId",
      "evaluate/suite/:suiteId/edit",
      "evaluate/suite/:suiteId/runs/:runId",
      "evaluate/suite/:suiteId/test/:testId",
      "evaluate/suite/:suiteId/test/:testId/edit",
    ],
    navSegments: ["evaluate"],
    title: "Evaluate (New)",
    purpose:
      "Preview of the redesigned Evaluate tab: a suites landing with a Runs view, a full-page create-suite flow, and a suite overview built around run history. Same suites and same data as Evaluate — only the screens differ.",
    userActivities: [
      "Browse eval suites from the landing table",
      "Create a suite on the full-page create flow",
      "Open a suite's overview to see its run history and cases",
      "Open a run to inspect each step, tool call, and score",
    ],
    // No snapshot provider and no tool group of its own: the component
    // bridges as `surfaceId: "evals"`, reusing that surface's group and
    // snapshot. The two tabs are never mounted at once, and duplicating the
    // agent contract for a preview shell would give the model two names for
    // one set of suites.
    hasSnapshotProvider: false,
    agentTools: {
      kind: "none",
      reason:
        'Flag-gated preview of the Evaluate tab. It bridges as surfaceId "evals" and reuses that surface\'s tool group, so declaring a second group would advertise duplicate tools for the same suites.',
    },
    // Flag-gated: the atlas is static and cannot read `evaluate-enabled`,
    // so advertising this path would send the agent to a screen that is
    // unreachable for almost every project. Same rationale as `sessions`.
    showInAtlas: false,
  },
  {
    id: "tools",
    canonicalPath: "/tools",
    routePatterns: ["tools"],
    navSegments: ["tools"],
    title: "Tools",
    purpose:
      "List and invoke the tools a connected MCP server exposes, without a model in the loop.",
    userActivities: ["Browse a server's tools", "Invoke a tool directly"],
    hasSnapshotProvider: true,
    agentTools: {
      kind: "none",
      reason:
        "Snapshot-only: tool EXECUTION is already covered by the global ui_execute_tool, so a screen tool would duplicate it — this surface only exposes state (its tools, selection, last result) via ui_snapshot_app.",
    },
    showInAtlas: true,
  },
  {
    id: "resources",
    canonicalPath: "/resources",
    routePatterns: ["resources"],
    navSegments: ["resources"],
    title: "Resources",
    purpose: "List and read the resources a connected MCP server exposes.",
    userActivities: [
      "Browse a server's resources and resource templates",
      "Read a resource, or resolve and read a template",
    ],
    hasSnapshotProvider: true,
    agentTools: { kind: "group" },
    showInAtlas: true,
  },
  {
    id: "prompts",
    canonicalPath: "/prompts",
    routePatterns: ["prompts"],
    navSegments: ["prompts"],
    title: "Prompts",
    purpose: "List and render the prompts a connected MCP server exposes.",
    userActivities: [
      "Browse a server's prompts",
      "Render a prompt with arguments",
    ],
    hasSnapshotProvider: true,
    agentTools: { kind: "group" },
    showInAtlas: true,
  },
  {
    id: "tasks",
    canonicalPath: "/tasks",
    routePatterns: ["tasks"],
    navSegments: ["tasks"],
    title: "Tasks",
    purpose:
      "Inspect long-running MCP tasks a connected server exposes, and their status.",
    userActivities: ["Browse a server's tasks", "Inspect a task's status"],
    hasSnapshotProvider: true,
    agentTools: {
      kind: "none",
      reason:
        "Read-only view of a server's long-running tasks; nothing to operate, but snapshot-only for observability so the agent can see the tasks and their statuses.",
    },
    showInAtlas: true,
  },
  {
    id: "skills",
    canonicalPath: "/skills",
    routePatterns: ["skills"],
    navSegments: ["skills"],
    title: "Skills",
    purpose: "View, add, and manage the skills available to hosts.",
    userActivities: ["Browse skills", "Add or edit a skill"],
    agentTools: {
      kind: "none",
      reason:
        "Tool group planned (browse skills, prefill a new skill for review); tracked in the surface-tools rollout.",
    },
    showInAtlas: true,
  },
  {
    id: "learning",
    canonicalPath: "/learning",
    routePatterns: ["learning"],
    navSegments: ["learning"],
    title: "Learning",
    purpose: "Learning material about MCP and the inspector.",
    userActivities: ["Read or watch learning material"],
    agentTools: {
      kind: "none",
      reason:
        "Read-only learning material; there is nothing here for an agent to operate.",
    },
    showInAtlas: true,
  },
  {
    id: "conformance",
    canonicalPath: "/conformance",
    routePatterns: ["conformance", "conformance/runs/:runId"],
    navSegments: ["conformance"],
    title: "Conformance",
    purpose:
      "Run protocol conformance checks against a connected MCP server and review what it does and doesn't implement correctly.",
    userActivities: [
      "Run a conformance scorecard against a server",
      "Review individual check results",
    ],
    agentTools: {
      kind: "none",
      reason:
        "Tool group planned (run a conformance scorecard against a server, read results); tracked in the surface-tools rollout.",
    },
    showInAtlas: true,
  },
  {
    id: "compatibility",
    canonicalPath: "/compatibility",
    routePatterns: ["compatibility"],
    navSegments: ["compatibility"],
    title: "Compatibility",
    purpose:
      "Check whether a server works with specific MCP hosts, and where it falls short.",
    userActivities: ["Review a server's host compatibility"],
    hasSnapshotProvider: true,
    agentTools: {
      kind: "none",
      reason:
        "Read-only review of a server's host compatibility; nothing to operate, but snapshot-only for observability so the agent can see which servers and hosts are on the matrix.",
    },
    showInAtlas: true,
  },
  {
    id: "oauth-flow",
    canonicalPath: "/oauth-flow",
    routePatterns: ["oauth-flow"],
    navSegments: ["oauth-flow"],
    title: "OAuth Debugger",
    purpose:
      "Step through an MCP server's OAuth flow and see exactly what happens at each stage — discovery, registration, authorization, token exchange.",
    userActivities: [
      "Run an OAuth flow against a server step by step",
      "Inspect discovery metadata and each request/response",
    ],
    hasSnapshotProvider: true,
    // The agent can prefill the config form, advance ONE step at a time
    // (approval-gated), and reset. Consent stays structurally human: the
    // authorization step opens a sign-in popup on the third party's page,
    // which the agent cannot complete. See groups/oauth-flow.ts.
    agentTools: { kind: "group" },
    showInAtlas: true,
  },
  {
    id: "xaa-flow",
    canonicalPath: "/xaa-flow",
    routePatterns: ["xaa-flow"],
    navSegments: ["xaa-flow"],
    title: "XAA Debugger",
    purpose:
      "Debug Cross-App Access (identity assertion / ID-JAG) flows between an identity provider and a resource app.",
    userActivities: [
      "Run an XAA flow and inspect each token exchange",
      "Configure the identity provider and resource app",
    ],
    agentTools: {
      kind: "none",
      reason:
        "Interactive auth debugger — human-in-the-loop by design; the agent must not drive token exchanges.",
    },
    showInAtlas: true,
  },
  {
    id: "tracing",
    canonicalPath: "/tracing",
    routePatterns: ["tracing"],
    navSegments: ["tracing"],
    title: "Tracing",
    purpose: "Inspect traces of chat turns and tool calls.",
    userActivities: ["Review turn traces"],
    hostedBlocked: true,
    hasSnapshotProvider: true,
    agentTools: {
      kind: "none",
      reason:
        "Read-only review of chat-turn traces; nothing to operate, but snapshot-only for observability so the agent can see the recent traffic summary.",
    },
    showInAtlas: true,
  },
  {
    id: "settings",
    canonicalPath: "/settings",
    // `settings/github-checks` is deliberately absent: the page moved under
    // Integrations and that path is now a loader redirect, not a screen. The
    // coverage test matches these against `kind: "screen"` routes exactly.
    routePatterns: [
      "settings",
      "settings/api-keys",
      "settings/integrations",
      "settings/integrations/github",
      "settings/integrations/github/callback",
    ],
    navSegments: ["settings"],
    title: "Settings",
    purpose:
      "Application settings, including API keys and third-party integrations.",
    userActivities: [
      "Change app settings",
      "Manage API keys",
      "Connect integrations (GitHub Checks, Slack)",
    ],
    agentTools: {
      kind: "none",
      reason:
        "Admin surface holding API keys; the agent must not automate credential management.",
    },
    showInAtlas: true,
  },
  {
    id: "project-settings",
    canonicalPath: "/project-settings",
    routePatterns: ["project-settings"],
    navSegments: ["project-settings"],
    title: "Project settings",
    purpose:
      "Settings for the current project, including its members and configuration.",
    userActivities: ["Change project settings", "Manage project members"],
    agentTools: {
      kind: "none",
      reason:
        "Admin surface (project members and configuration); the agent must not automate membership changes.",
    },
    showInAtlas: true,
  },
  {
    id: "organizations",
    canonicalPath: "/organizations",
    routePatterns: [
      "organizations",
      "organizations/:orgId",
      "organizations/:orgId/billing",
      "organizations/:orgId/models",
      // Slack agent settings. Listed so the route-coverage test passes, but
      // deliberately NOT added to `userActivities` while the section is behind
      // a PostHog flag — the atlas is the agent's map of the app, and pointing
      // it at a screen most orgs cannot see would waste a turn on a door that
      // is locked.
      "organizations/:orgId/slack",
      // Discord agent settings — same reasoning as Slack directly above,
      // including staying out of `userActivities` while `discord-agent` is off.
      "organizations/:orgId/discord",
    ],
    navSegments: ["organizations"],
    title: "Organizations",
    purpose:
      "Organization administration: members, billing, and which models the org allows.",
    userActivities: [
      "Manage organization members",
      "Review or change billing",
      "Configure allowed models and provider keys",
    ],
    agentTools: {
      kind: "none",
      reason:
        "Admin surface (members, billing, provider keys); the agent must not automate billing or access.",
    },
    showInAtlas: true,
  },
  {
    id: "profile",
    canonicalPath: "/profile",
    routePatterns: ["profile"],
    navSegments: ["profile"],
    title: "Profile",
    purpose: "The signed-in user's own profile.",
    userActivities: ["Review or edit your profile"],
    agentTools: {
      kind: "none",
      reason:
        "The user's own account details; the agent must not automate identity or profile changes.",
    },
    showInAtlas: true,
  },
  {
    id: "support",
    canonicalPath: "/support",
    routePatterns: ["support"],
    navSegments: ["support"],
    title: "Support",
    purpose: "Get help and contact MCPJam support.",
    userActivities: ["Contact support"],
    agentTools: {
      kind: "none",
      reason:
        "Contact-support screen; a human conversation, nothing for an agent to automate.",
    },
    showInAtlas: true,
  },
] as const satisfies readonly AppSurfaceManifest[];

/**
 * The manifests as the wide interface.
 *
 * `APP_SURFACES` is `as const satisfies` so `AppSurfaceId` can be a literal
 * union — which narrows every entry to its own literal type, where optional
 * fields an entry didn't set don't exist. Read through this instead.
 */
export function listAppSurfaces(): readonly AppSurfaceManifest[] {
  return APP_SURFACES as readonly AppSurfaceManifest[];
}

const surfacesById = new Map<string, AppSurfaceManifest>(
  listAppSurfaces().map((s) => [s.id, s])
);

export function getAppSurface(id: string): AppSurfaceManifest | undefined {
  return surfacesById.get(id);
}

export function isAppSurfaceId(value: unknown): value is AppSurfaceId {
  return typeof value === "string" && surfacesById.has(value);
}

const surfacesByNavSegment = new Map<string, AppSurfaceManifest>(
  listAppSurfaces().flatMap((s) => s.navSegments.map((seg) => [seg, s]))
);

/**
 * Resolve a normalized tab segment (what `resolveUiNavigationTarget` returns
 * and `pathnameToActiveTab` produces) to its surface manifest. Unambiguous:
 * the coverage test asserts no segment is claimed by two surfaces.
 */
export function getAppSurfaceByNavSegment(
  segment: string
): AppSurfaceManifest | undefined {
  return surfacesByNavSegment.get(segment);
}

/**
 * Every tab segment that resolves to a known surface — the derived
 * replacement for the hand-maintained `KNOWN_APP_TAB_SEGMENTS`.
 */
export function listAppSurfaceNavSegments(): string[] {
  const out = new Set<string>();
  for (const surface of APP_SURFACES) {
    for (const segment of surface.navSegments) out.add(segment);
  }
  return [...out];
}

/**
 * Nav segments a hosted deployment cannot serve — the manifests are the
 * source of truth, and `hosted-tab-policy.ts` is the only caller.
 *
 * Reads through `listAppSurfaces()` rather than `APP_SURFACES` directly:
 * the const assertion narrows each entry to its own literal type, so an
 * optional field is absent from the ones that never set it.
 */
export function listHostedBlockedNavSegments(): string[] {
  const out = new Set<string>();
  for (const surface of listAppSurfaces()) {
    if (!surface.hostedBlocked) continue;
    for (const segment of surface.navSegments) out.add(segment);
  }
  return [...out];
}

/**
 * The app atlas: a compact map of the app for the agent's system prompt.
 *
 * Static per build ON PURPOSE — it goes in the cacheable prefix, so nothing
 * per-request may leak in here. Where the user actually IS travels per turn,
 * append-only, on the user message.
 */
export function buildAppAtlas(opts?: { hosted?: boolean }): string {
  const surfaces = listAppSurfaces().filter(
    (s) => s.showInAtlas && !(opts?.hosted && s.hostedBlocked)
  );
  return [
    "## The MCPJam inspector, screen by screen",
    "This is the app you are driving. Navigate with `ui_navigate` using the target in parentheses.",
    // Static on purpose (cacheable prefix): which screens grow tools is a
    // per-build fact, and the exact names arrive with the next chat POST's
    // tool snapshot — the sentence only teaches the model that navigating
    // can unlock more.
    "Navigating to a screen can make additional screen-specific agent tools available on your next step.",
    "",
    ...surfaces.map((s) =>
      [
        `### ${s.title} (${s.navSegments[0]})`,
        s.purpose,
        ...s.userActivities.map((a) => `- ${a}`),
      ].join("\n")
    ),
  ].join("\n");
}
