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
   * Not reachable in hosted deployments (see `HOSTED_HASH_BLOCKED_TABS`).
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
    routePatterns: ["servers"],
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
      "Create or edit a host configuration",
      "Set a host's model, system prompt, and behavior (tool approval, tool discovery)",
      "Deep-link to a specific host's canvas",
    ],
    agentTools: {
      kind: "none",
      reason:
        "Tool group planned (create a host, set its model/prompt/behavior); tracked in the surface-tools rollout.",
    },
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
    agentTools: {
      kind: "none",
      reason:
        "Read-only comparison matrix; there is nothing here for an agent to operate.",
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
      "Start or stop the project's computer",
      "Browse its filesystem and open a terminal",
    ],
    agentTools: {
      kind: "none",
      reason:
        "Tool group planned (start/stop the computer, read its status); tracked in the surface-tools rollout.",
    },
    showInAtlas: true,
  },
  {
    id: "registry",
    canonicalPath: "/registry",
    routePatterns: ["registry"],
    navSegments: ["registry"],
    title: "Registry",
    purpose:
      "Browse the public MCP server registry and install servers into the current project.",
    userActivities: [
      "Search the registry for a server",
      "Install a registry server into the project",
      "Star or unstar a registry server",
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
    id: "chatboxes",
    canonicalPath: "/chatboxes",
    routePatterns: ["chatboxes"],
    navSegments: ["chatboxes"],
    title: "Chatbox",
    purpose:
      "Publish a host as a shareable chat surface for humans, and review its sessions.",
    userActivities: [
      "Publish or unpublish a chatbox",
      "Review chatbox sessions",
    ],
    agentTools: {
      kind: "none",
      reason:
        "Tool group planned (publish/unpublish a chatbox, open a session); tracked in the surface-tools rollout.",
    },
    showInAtlas: true,
  },
  {
    id: "swarms",
    canonicalPath: "/swarms",
    routePatterns: ["swarms"],
    navSegments: ["swarms"],
    title: "Swarms",
    purpose:
      "Run many simulated agent sessions against a host to see how it behaves at scale.",
    userActivities: [
      "Publish a swarm and configure personas",
      "Review swarm sessions",
    ],
    agentTools: {
      kind: "none",
      reason:
        "Tool group planned (publish a swarm, configure personas, open sessions); tracked in the surface-tools rollout.",
    },
    showInAtlas: true,
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
    ],
    navSegments: ["evals"],
    title: "Evaluate",
    purpose:
      "Build and run eval suites against a host: test cases with expected tool calls, scored over repeated runs.",
    userActivities: [
      "Create or edit an eval suite and its test cases",
      "Run a suite and watch its runs",
      "Open a run to inspect each step, tool call, and score",
      "Compare runs",
    ],
    agentTools: {
      kind: "none",
      reason:
        "Tool group planned (create/edit suites, start runs, open results); tracked in the surface-tools rollout.",
    },
    showInAtlas: true,
  },
  {
    id: "ci-evals",
    canonicalPath: "/ci-evals",
    routePatterns: [
      "ci-evals",
      "ci-evals/create",
      "ci-evals/commit/:commitSha",
      "ci-evals/suite/:suiteId",
      "ci-evals/suite/:suiteId/edit",
      "ci-evals/suite/:suiteId/runs/:runId",
      "ci-evals/suite/:suiteId/test/:testId",
      "ci-evals/suite/:suiteId/test/:testId/edit",
    ],
    navSegments: ["ci-evals"],
    title: "CI Evals",
    purpose:
      "The same eval suites as Evaluate, but as they ran in CI — results keyed by commit.",
    userActivities: [
      "Review eval results for a commit",
      "Open a CI run's details",
    ],
    agentTools: {
      kind: "none",
      reason:
        "Read-only review of results CI already produced; runs are started from CI, not from this screen.",
    },
    showInAtlas: true,
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
    agentTools: {
      kind: "none",
      reason:
        "Tool group planned (list a server's tools, prefill/invoke one directly); tracked in the surface-tools rollout.",
    },
    showInAtlas: true,
  },
  {
    id: "resources",
    canonicalPath: "/resources",
    routePatterns: ["resources"],
    navSegments: ["resources"],
    title: "Resources",
    purpose:
      "List and read the resources a connected MCP server exposes.",
    userActivities: ["Browse a server's resources", "Read a resource"],
    agentTools: {
      kind: "none",
      reason:
        "Tool group planned (list a server's resources, read one); tracked in the surface-tools rollout.",
    },
    showInAtlas: true,
  },
  {
    id: "prompts",
    canonicalPath: "/prompts",
    routePatterns: ["prompts"],
    navSegments: ["prompts"],
    title: "Prompts",
    purpose: "List and render the prompts a connected MCP server exposes.",
    userActivities: ["Browse a server's prompts", "Render a prompt"],
    agentTools: {
      kind: "none",
      reason:
        "Tool group planned (list a server's prompts, render one with arguments); tracked in the surface-tools rollout.",
    },
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
    hostedBlocked: true,
    agentTools: {
      kind: "none",
      reason:
        "Read-only view of a server's long-running tasks; there is nothing here for an agent to operate.",
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
    routePatterns: ["conformance"],
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
    agentTools: {
      kind: "none",
      reason:
        "Read-only review of a server's host compatibility; nothing to operate.",
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
    agentTools: {
      kind: "none",
      reason:
        "Interactive auth debugger — human-in-the-loop by design; the agent must not drive authorization steps.",
    },
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
    agentTools: {
      kind: "none",
      reason:
        "Read-only review of chat-turn traces; there is nothing here for an agent to operate.",
    },
    showInAtlas: true,
  },
  {
    id: "auth",
    canonicalPath: "/auth",
    routePatterns: ["auth"],
    navSegments: ["auth"],
    title: "Auth",
    purpose: "Local authentication settings for MCP servers.",
    userActivities: ["Review server auth state"],
    hostedBlocked: true,
    agentTools: {
      kind: "none",
      reason:
        "Sensitive auth state (server credentials and sessions); the agent must not automate it.",
    },
    showInAtlas: true,
  },
  {
    id: "settings",
    canonicalPath: "/settings",
    routePatterns: ["settings", "settings/api-keys"],
    navSegments: ["settings"],
    title: "Settings",
    purpose: "Application settings, including API keys.",
    userActivities: ["Change app settings", "Manage API keys"],
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
  listAppSurfaces().map((s) => [s.id, s]),
);

export function getAppSurface(id: string): AppSurfaceManifest | undefined {
  return surfacesById.get(id);
}

export function isAppSurfaceId(value: unknown): value is AppSurfaceId {
  return typeof value === "string" && surfacesById.has(value);
}

const surfacesByNavSegment = new Map<string, AppSurfaceManifest>(
  listAppSurfaces().flatMap((s) => s.navSegments.map((seg) => [seg, s])),
);

/**
 * Resolve a normalized tab segment (what `resolveUiNavigationTarget` returns
 * and `pathnameToActiveTab` produces) to its surface manifest. Unambiguous:
 * the coverage test asserts no segment is claimed by two surfaces.
 */
export function getAppSurfaceByNavSegment(
  segment: string,
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
 * The app atlas: a compact map of the app for the agent's system prompt.
 *
 * Static per build ON PURPOSE — it goes in the cacheable prefix, so nothing
 * per-request may leak in here. Where the user actually IS travels per turn,
 * append-only, on the user message.
 */
export function buildAppAtlas(opts?: { hosted?: boolean }): string {
  const surfaces = listAppSurfaces().filter(
    (s) => s.showInAtlas && !(opts?.hosted && s.hostedBlocked),
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
      ].join("\n"),
    ),
  ].join("\n");
}
