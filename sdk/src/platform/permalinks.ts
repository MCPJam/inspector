/**
 * App permalinks for durable platform resources.
 *
 * The problem this solves: a tool result that hands back `{ id: "p170b5c…" }`
 * and nothing else forces the model to invent a URL. It invents
 * `https://app.mcpjam.com/servers`, which opens whatever project the
 * RECIPIENT's local storage last selected — so a link about project Demo
 * silently renders project Default's servers. A permalink minted here names
 * the project in the URL (`?project=<id>`), so opening it selects the
 * resource's project and organization before rendering anything.
 *
 * Two rules keep this module honest:
 *
 *  1. **Pure.** No ambient environment read, no `window`, no server config,
 *     no network. `@mcpjam/sdk/platform` is runtime-agnostic — it runs in the MCP worker
 *     (Cloudflare), the CLI (Node), the hosted route, and the browser — so
 *     the app origin is an explicit argument and every adapter reads its own
 *     environment.
 *  2. **One table.** `PlatformResourceType` is INFERRED from
 *     `PLATFORM_PERMALINK_ROUTES`, so a resource type cannot exist without a
 *     route and a route cannot exist for a type nothing declares. A
 *     hand-written union next to the table would drift the first time
 *     someone added one and not the other.
 *
 * A permalink is a navigation aid, never an authorization grant: it is
 * intentionally model-visible and shareable with anyone who already has
 * access to the same MCPJam resource, and it opens the ordinary
 * access-controlled page. Token-bearing guest URLs (User Testing share
 * links) are a different, backend-minted product capability and are not
 * permalinks — see `PlatformNoPermalinkReason.external-resource` and the
 * share-link operations, which stay outside this selector.
 */

/**
 * The query parameter that names a permalink's project.
 *
 * Lives here rather than in the client because BOTH ends need it and the
 * dependency only runs one way: the client's `project-deep-link.ts` (which
 * consumes the parameter) imports this constant, and no SDK module may
 * import app code.
 */
export const PROJECT_DEEP_LINK_PARAM = "project";

/**
 * The hosted app origin, for adapters with no configured override.
 *
 * A neutral default constant, NOT an ambient read: nothing in this module
 * reaches for it on its own. Adapters pass it (or their own configured
 * origin) explicitly, which is what keeps a staging deployment from minting
 * production links.
 */
export const DEFAULT_MCPJAM_APP_ORIGIN = "https://app.mcpjam.com";

/**
 * One ancestor in a ref's parent chain.
 *
 * Recursive rather than a flat list: the table already says, once, that an
 * eval run lives under its suite, so a ref for something under a RUN only
 * has to say "here is the run, and here is the run's parent". The builder
 * walks the chain against the table, so a link is refused when any level
 * names the wrong type, not just the first.
 */
export interface PlatformResourceParentRef {
  type: PlatformResourceType;
  id: string;
  /**
   * The parent's own parent, required when the parent's route itself declares
   * a `parent` — an iteration nests under its run, which nests under its suite.
   */
  parent?: PlatformResourceParentRef;
}

/** A reference to a resource, before it becomes a URL. */
export interface PlatformResourceRef {
  type: PlatformResourceType;
  id: string;
  /**
   * The project the resource belongs to. Rows of a cross-project listing
   * (`list_projects`) carry their own; everything else usually inherits the
   * operation's resolved-scope receipt.
   */
  projectId?: string;
  /**
   * The resource whose route this one nests under — an eval case and an
   * eval run are both addressed through their suite. Required for the types
   * that declare `parent`; supplying the wrong type is an error, not a
   * silent fallback to the collection. Carries its own `parent` when the
   * route nests two levels deep (an eval iteration: run, then suite).
   */
  parent?: PlatformResourceParentRef;
  /** Overrides the route's default label ("View run", "Open suite", …). */
  label?: string;
}

/** A durable, human-openable app URL for one resource. */
export interface PlatformPermalink {
  /** App-relative path, including the query. */
  path: string;
  /** Absolute URL for the same target. */
  url: string;
  /** Short imperative label a surface can render as link text. */
  label: string;
  /** Correlates the permalink with the row it describes, without array order. */
  resource: { type: PlatformResourceType; id: string };
  /** Present whenever the route carries `?project=`. */
  projectId?: string;
}

/**
 * What a policy knows at derivation time.
 *
 * `resolvedScope` is the RECEIPT an operation fired while resolving its
 * project selector (see `PlatformOperationContext.onScopeResolved`). MCP and
 * generic CLI callers usually pass a project NAME or nothing at all, so the
 * project id exists only after `execute` has run — assuming one up front
 * would mint a link to whatever project the adapter guessed.
 */
export interface PlatformPermalinkContext {
  appOrigin: string;
  resolvedScope?: { projectId: string; organizationId?: string };
}

/** Why an operation returns no permalink. Typed, so it is reviewable. */
export type PlatformNoPermalinkReason =
  /** The result names nothing durable — a probe, a report, a capability set. */
  | "no-addressable-resource"
  /** The result is a receipt for an effect: a cancel, a delete, a dismiss. */
  | "mutation-only"
  /** The result belongs to a third party, not to an MCPJam app page. */
  | "external-resource"
  /** A durable MCPJam resource with no exact route yet. Tracked debt. */
  | "route-not-addressable";

/**
 * How one operation produces permalinks.
 *
 * Discriminated rather than "two optional callbacks": with optional fields
 * the honest answer ("this operation has nothing to link to") and the
 * unreviewed answer ("nobody looked at this one") are the same absence. Here
 * every operation states which it is, and `PlatformOperation` requires the
 * field, so a new operation cannot be added without the decision being made.
 */
export type PlatformPermalinkPolicy<TInput, TOutput> =
  | {
      kind: "derive";
      /** The durable resources this result referenced. Order is not meaningful. */
      resources(
        result: TOutput,
        input: TInput,
        context: PlatformPermalinkContext
      ): PlatformResourceRef[];
    }
  | {
      kind: "response";
      /**
       * Permalinks the BACKEND minted and the result already carries — session
       * search is the standing example. The backend owns the fallback rules
       * for a session whose surface-native target does not exist, and
       * re-deriving them here would be a second, drifting copy.
       */
      permalinks(
        result: TOutput,
        input: TInput,
        context: PlatformPermalinkContext
      ): PlatformPermalink[];
    }
  | {
      kind: "none";
      reason: PlatformNoPermalinkReason;
      /** Required for `route-not-addressable`: name the missing route. */
      note?: string;
    };

/** One resource type's route. */
interface PlatformPermalinkRoute {
  /** Default link text. Imperative, short enough for a chat line. */
  label: string;
  /**
   * Path segments, with `":id"` standing for the resource's own id,
   * `":parent"` for its parent's and `":grandparent"` for its parent's
   * parent's. Every segment is percent-encoded on the way out; none of them
   * may be assembled by a caller.
   */
  segments: readonly string[];
  /** Static query the route needs to land on the right view. */
  query?: Readonly<Record<string, string>>;
  /**
   * Query parameter carrying the resource's own id, for routes that select
   * rather than navigate (`/sessions?session=…`). Mutually exclusive with a
   * `":id"` segment in practice, though nothing here forbids both.
   */
  idParam?: string;
  /**
   * The parent type a `":parent"` segment resolves against. When that type
   * declares a `parent` of its own, `":grandparent"` resolves against it and
   * the ref must carry the whole chain — the nesting is stated once, on the
   * parent's entry, never restated here.
   */
  parent?: string;
  /**
   * False only for resources that live above a project (organizations).
   * Everything else gets `?project=`, which is the entire point.
   */
  projectScoped?: boolean;
}

/**
 * Resource type → app route. The single source of truth for both.
 *
 * Routes here are EXACT resource addresses, never a collection standing in
 * for one. Where an exact route does not exist yet the operation says
 * `route-not-addressable` and (optionally) returns the collection under its
 * own honest label — "Open environments", not "the environment's permalink".
 */
export const PLATFORM_PERMALINK_ROUTES = {
  /**
   * A project's own landing page. `/servers` rather than `/home`: Connect is
   * where the project's work starts, and it is the screen every other
   * project route falls back to.
   */
  project: {
    label: "Open project",
    segments: ["servers"],
  },
  /** One saved MCP server, with its detail expanded. */
  project_server: {
    label: "Open server",
    segments: ["servers", ":id"],
  },
  /** One named environment. */
  project_environment: {
    label: "Open environment",
    segments: ["environments", ":id"],
  },
  /** One installed agent plugin, expanded inside Connect. */
  project_plugin: {
    label: "Open plugin",
    segments: ["servers", "plugins", ":id"],
  },
  /** A modelled MCP host (Claude, ChatGPT, Cursor…) and its canvas. */
  host: {
    label: "Open host",
    segments: ["hosts", ":id"],
  },
  eval_suite: {
    label: "Open suite",
    segments: ["evals", "suite", ":id"],
  },
  /** One test case inside its suite. */
  eval_case: {
    label: "Open test case",
    segments: ["evals", "suite", ":parent", "test", ":id"],
    parent: "eval_suite",
  },
  /** One finished or in-flight run of a suite. */
  eval_run: {
    label: "View run",
    segments: ["evals", "suite", ":parent", "runs", ":id"],
    parent: "eval_suite",
  },
  /**
   * One iteration of a run, selected on the run's page.
   *
   * An iteration has no page of its own: the run detail reads `?iteration=`
   * off its query string and opens that trial. So the route is the RUN's
   * path with an id selector, and it nests two levels deep — the run is the
   * parent, and the run's own entry above says the suite is the run's.
   */
  eval_iteration: {
    label: "View iteration",
    segments: ["evals", "suite", ":grandparent", "runs", ":parent"],
    idParam: "iteration",
    parent: "eval_run",
  },
  /**
   * A grouped launch (one suite fanned across several targets).
   *
   * Deliberately the suite's RUNS lens rather than one member run: linking to
   * a single run of the group would hide a sibling's failure, which is the
   * one thing whoever approved N paid runs most needs to see.
   */
  eval_run_group: {
    label: "View runs",
    segments: ["evals", "suite", ":parent"],
    query: { view: "runs" },
    parent: "eval_suite",
  },
  /**
   * One conversation, on the cross-surface Sessions feed.
   *
   * The feed loads a session by id alone, which is what lets it serve as the
   * universal target for a session whose surface-native page does not exist
   * (an eval Quick Run, a session whose parent run was deleted).
   */
  chat_session: {
    label: "Open session",
    segments: ["sessions"],
    idParam: "session",
  },
  /** One conformance run's report. */
  conformance_run: {
    label: "View conformance run",
    segments: ["conformance", "runs", ":id"],
  },
  /**
   * One launched wave.
   *
   * `/swarms/<runId>` with the run id as the FIRST segment after `/swarms/`:
   * the client routes on that segment, so `/swarms/runs/<id>` would resolve
   * to a run named literally "runs" and dead-link the recipient.
   *
   * NOTE the asymmetry with the saved swarm DEFINITION, which deliberately has
   * no entry here. `:swarmId` reads as a launched wave — `SwarmRunDetail`
   * resolves it against the project's runs — so a saved swarm's id on this
   * route renders an empty run detail. The two share a path shape and mean
   * different things, which is exactly the confusion the registry exists to
   * settle in one place.
   */
  journey_run: {
    label: "View swarm run",
    segments: ["swarms", ":id"],
  },
  /** One User Testing scenario's detail. */
  user_testing_scenario: {
    label: "Open scenario",
    segments: ["user-testing", ":id"],
  },
  /**
   * An organization's settings. The one type above project scope, so it
   * carries no `?project=` — adding one would switch the viewer's project as
   * a side effect of opening an org page.
   */
  organization: {
    label: "Open organization",
    segments: ["organizations", ":id"],
    projectScoped: false,
  },
} as const satisfies Record<string, PlatformPermalinkRoute>;

/** Every resource type that has an app route. Inferred, never restated. */
export type PlatformResourceType = keyof typeof PLATFORM_PERMALINK_ROUTES;

/** Runtime membership test for a resource type, for adapters reading wire data. */
export function isPlatformResourceType(
  value: string
): value is PlatformResourceType {
  return Object.prototype.hasOwnProperty.call(PLATFORM_PERMALINK_ROUTES, value);
}

/**
 * Raised when a ref cannot become an exact URL — a missing parent, a missing
 * project id, an origin that is not an app origin.
 *
 * A THROW rather than a silent `undefined`, so a wrong mapping fails in the
 * unit tests that call this directly. Adapters, which must never fail an
 * operation over a link, catch it and omit the permalink.
 */
export class PlatformPermalinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformPermalinkError";
  }
}

/**
 * Validate and normalize the app origin.
 *
 * Rejects rather than repairs: credentials in an origin (`https://a:b@host`)
 * would travel inside every link the agent hands out, a path prefix would
 * silently produce `/app/evals/...` for some callers and `/evals/...` for
 * others, and a non-HTTP(S) scheme is not something a browser opens.
 */
function normalizeAppOrigin(appOrigin: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(appOrigin);
  } catch {
    throw new PlatformPermalinkError(
      `App origin "${appOrigin}" is not an absolute URL.`
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new PlatformPermalinkError(
      `App origin "${appOrigin}" must use http(s).`
    );
  }
  if (parsed.username || parsed.password) {
    throw new PlatformPermalinkError(
      "App origin must not carry credentials; they would travel in every permalink."
    );
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new PlatformPermalinkError(
      `App origin "${appOrigin}" must not carry a path prefix.`
    );
  }
  if (parsed.search || parsed.hash) {
    throw new PlatformPermalinkError(
      `App origin "${appOrigin}" must not carry a query or fragment.`
    );
  }
  return parsed;
}

/**
 * Which level of a ref's parent chain each ancestor segment reads.
 *
 * `:parent` is the immediate parent, `:grandparent` the one above it. The
 * vocabulary stops there on purpose: nothing in the app nests deeper, and a
 * third token would be adding a route shape no screen has.
 */
const ANCESTOR_SEGMENT_DEPTH: Readonly<Record<string, number>> = {
  ":parent": 0,
  ":grandparent": 1,
};

/**
 * Build one resource's permalink.
 *
 * Uses `URL`/`URLSearchParams` throughout rather than string concatenation:
 * the concatenated builders this replaces each had to remember to encode
 * their own segments and to notice whether the route already had a `?`, and
 * the grouped-eval URL (`…?view=runs` plus `?project=`) is exactly where a
 * hand-assembled one grows a second question mark.
 */
export function buildAppPermalink(
  resource: PlatformResourceRef,
  options: { appOrigin: string }
): PlatformPermalink {
  const route = PLATFORM_PERMALINK_ROUTES[resource.type] as
    | PlatformPermalinkRoute
    | undefined;
  if (!route) {
    throw new PlatformPermalinkError(
      `No app route for resource type "${resource.type}".`
    );
  }

  const id = resource.id?.trim();
  if (!id) {
    throw new PlatformPermalinkError(
      `A ${resource.type} permalink needs a non-empty id.`
    );
  }

  const origin = normalizeAppOrigin(options.appOrigin);
  const url = new URL(origin.toString());

  // Walk the parent chain as far as the TABLE says it goes: the route names
  // its parent type, that type's own entry names the next, and so on. Each
  // level of the ref is checked against the level the table expects, so an
  // iteration handed a run whose parent is a chat session fails here rather
  // than minting `/evals/suite/<session id>/…`.
  const ancestorIds: string[] = [];
  let expectedType = route.parent;
  let ancestor = resource.parent;
  let through = resource.type;
  while (expectedType) {
    if (!ancestor) {
      throw new PlatformPermalinkError(
        `A ${resource.type} permalink needs its ${expectedType} parent${
          through === resource.type ? "" : ` (through ${through})`
        }; without it the URL would address the wrong resource.`
      );
    }
    if (ancestor.type !== expectedType) {
      throw new PlatformPermalinkError(
        `A ${through} permalink nests under ${expectedType}, not ${ancestor.type}.`
      );
    }
    const ancestorId = ancestor.id?.trim();
    if (!ancestorId) {
      throw new PlatformPermalinkError(
        `A ${resource.type} permalink needs a non-empty ${expectedType} id.`
      );
    }
    ancestorIds.push(ancestorId);
    through = ancestor.type;
    expectedType = (
      PLATFORM_PERMALINK_ROUTES[ancestor.type] as PlatformPermalinkRoute
    ).parent;
    ancestor = ancestor.parent;
  }

  // `URL.pathname =` would re-interpret `%2F` inside a value as a separator,
  // so each segment is encoded and joined here instead.
  const segments = route.segments.map((segment) => {
    if (segment === ":id") return encodeURIComponent(id);
    const depth = ANCESTOR_SEGMENT_DEPTH[segment];
    if (depth === undefined) return segment;
    const ancestorId = ancestorIds[depth];
    if (ancestorId === undefined) {
      // A table mistake, not a caller's: the route names an ancestor deeper
      // than its declared parent chain reaches.
      throw new PlatformPermalinkError(
        `Route for ${resource.type} uses "${segment}" but declares no ancestor at that depth.`
      );
    }
    return encodeURIComponent(ancestorId);
  });
  url.pathname = `/${segments.join("/")}`;

  // Static route query first, then the resource's own selector, then
  // `project` — so a route that already carries `view=runs` keeps it and
  // gains exactly one `project`, with one `?` and no discarded parameters.
  for (const [key, value] of Object.entries(route.query ?? {})) {
    url.searchParams.set(key, value);
  }
  if (route.idParam) {
    url.searchParams.set(route.idParam, id);
  }

  const projectScoped = route.projectScoped !== false;
  const projectId = resource.projectId?.trim() || undefined;
  if (projectScoped) {
    if (!projectId) {
      throw new PlatformPermalinkError(
        `A ${resource.type} permalink needs a project id: without \`?${PROJECT_DEEP_LINK_PARAM}=\` the link opens whatever project the recipient was last parked on.`
      );
    }
    url.searchParams.set(PROJECT_DEEP_LINK_PARAM, projectId);
  }

  return {
    path: `${url.pathname}${url.search}${url.hash}`,
    url: url.toString(),
    label: resource.label?.trim() || route.label,
    resource: { type: resource.type, id },
    ...(projectScoped && projectId ? { projectId } : {}),
  };
}

/**
 * Resolve a ref's project id from the ref itself, then the operation's
 * resolved-scope receipt.
 *
 * Ref first: a cross-project listing's rows each name their own project, and
 * the receipt (one project, whichever the operation resolved) would relabel
 * every row with it.
 *
 * The receipt is the fallback rather than the source precisely because a
 * policy reads its project off the RESULT, and a result shape can change
 * under it. When it does — a field renamed, an older backend omitting the
 * echo — the receipt still knows which project the operation resolved, so the
 * link degrades to correct instead of to absent.
 */
export function permalinkProjectId(
  resource: PlatformResourceRef,
  context: PlatformPermalinkContext
): string | undefined {
  return resource.projectId ?? context.resolvedScope?.projectId;
}

/**
 * Build permalinks for a batch of refs, filling each one's project id from
 * the receipt when the ref does not carry its own.
 */
export function buildAppPermalinks(
  resources: readonly PlatformResourceRef[],
  context: PlatformPermalinkContext
): PlatformPermalink[] {
  return resources.map((resource) =>
    buildAppPermalink(
      { ...resource, projectId: permalinkProjectId(resource, context) },
      { appOrigin: context.appOrigin }
    )
  );
}

// ── Policy constructors ──────────────────────────────────────────────
//
// Named helpers rather than object literals at 164 declaration sites: the
// policy is one line of intent per operation, and a helper keeps it readable
// at a glance in a file that is mostly schemas and execute bodies.

/** Declare the durable resources an operation's result referenced. */
export function derivePermalinks<TInput, TOutput>(
  resources: (
    result: TOutput,
    input: TInput,
    context: PlatformPermalinkContext
  ) => PlatformResourceRef[]
): PlatformPermalinkPolicy<TInput, TOutput> {
  return { kind: "derive", resources };
}

/** Declare that the backend already minted this operation's permalinks. */
export function responsePermalinks<TInput, TOutput>(
  permalinks: (
    result: TOutput,
    input: TInput,
    context: PlatformPermalinkContext
  ) => PlatformPermalink[]
): PlatformPermalinkPolicy<TInput, TOutput> {
  return { kind: "response", permalinks };
}

/**
 * Declare, with a reason, that an operation has nothing to link to.
 *
 * `route-not-addressable` REQUIRES a note naming the missing route, and the
 * coverage test keeps those on a short named allowlist: it is tracked debt
 * with a route owed, not a catch-all for "did not want to think about it".
 */
export function noPermalink<TInput = unknown, TOutput = unknown>(
  reason: PlatformNoPermalinkReason,
  note?: string
): PlatformPermalinkPolicy<TInput, TOutput> {
  return { kind: "none", reason, ...(note ? { note } : {}) };
}

// ── Adapter helper ───────────────────────────────────────────────────

/** The part of an operation context this helper needs. */
export interface PermalinkScopeReceiver {
  onScopeResolved?: (scope: {
    projectId: string;
    organizationId?: string;
  }) => void;
}

/** The part of an operation this helper needs. Structural, so this module
 * never imports the 11k-line catalog just to name a type. */
export interface PermalinkAwareOperation<TInput, TOutput, TContext> {
  name: string;
  permalink: PlatformPermalinkPolicy<TInput, TOutput>;
  execute(input: TInput, context: TContext): Promise<TOutput>;
}

/**
 * Apply an operation's permalink policy to a result it already produced.
 *
 * NEVER throws. A surface must not fail an operation that succeeded because a
 * link could not be composed — a missing parent or an unscoped row is a bug in
 * the policy, and the place it should fail loudly is the unit tests that call
 * `buildAppPermalink` directly. Here it drops the link and reports through
 * `onError` so an adapter can log it.
 */
export function derivePermalinksFor<TInput, TOutput, TContext>(
  operation: PermalinkAwareOperation<TInput, TOutput, TContext>,
  result: TOutput,
  input: TInput,
  context: PlatformPermalinkContext,
  onError?: (error: unknown, operationName: string) => void
): PlatformPermalink[] {
  const policy = operation.permalink;
  if (policy.kind === "none") return [];
  try {
    if (policy.kind === "response") {
      // Validated, not trusted. A response permalink comes off the wire —
      // `search_sessions` copies `session.link.url` — and `PlatformSessionLink`
      // only promises a string. A relative or empty one would be rendered
      // verbatim into a tool result as though it were openable, so an entry
      // that is not an absolute http(s) URL is reported and dropped rather
      // than handed to a model to pass on.
      const permalinks: PlatformPermalink[] = [];
      for (const permalink of policy.permalinks(result, input, context)) {
        try {
          const parsed = new URL(permalink.url);
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            throw new PlatformPermalinkError(
              `Response permalink "${permalink.url}" is not an http(s) URL.`
            );
          }
          permalinks.push(permalink);
        } catch (error) {
          onError?.(error, operation.name);
        }
      }
      return permalinks;
    }
    // Each ref independently: one unaddressable row must not silently drop
    // the permalinks of every row beside it.
    const permalinks: PlatformPermalink[] = [];
    for (const resource of policy.resources(result, input, context)) {
      try {
        permalinks.push(
          buildAppPermalink(
            { ...resource, projectId: permalinkProjectId(resource, context) },
            { appOrigin: context.appOrigin }
          )
        );
      } catch (error) {
        onError?.(error, operation.name);
      }
    }
    return permalinks;
  } catch (error) {
    onError?.(error, operation.name);
    return [];
  }
}

/**
 * Execute an operation, capture the project it resolved, and derive its
 * permalinks from the RAW result.
 *
 * Raw is the operative word: surfaces reshape results (the MCP worker tags
 * widget payloads, the CLI compacts them), and a policy reading a reshaped
 * result would be reading a shape it was never written against. Deriving here,
 * between `execute` and any transform, is what keeps the policies honest about
 * one input shape.
 */
export async function runOperationWithPermalinks<
  TInput,
  TOutput,
  TContext extends PermalinkScopeReceiver
>(
  operation: PermalinkAwareOperation<TInput, TOutput, TContext>,
  input: TInput,
  context: TContext,
  options: {
    appOrigin: string;
    onError?: (error: unknown, operationName: string) => void;
  }
): Promise<{ result: TOutput; permalinks: PlatformPermalink[] }> {
  let resolvedScope: { projectId: string; organizationId?: string } | undefined;
  const caller = context.onScopeResolved;
  const result = await operation.execute(input, {
    ...context,
    onScopeResolved: (scope) => {
      resolvedScope = scope;
      caller?.(scope);
    },
  });
  const permalinks = derivePermalinksFor(
    operation,
    result,
    input,
    {
      appOrigin: options.appOrigin,
      ...(resolvedScope ? { resolvedScope } : {}),
    },
    options.onError
  );
  return { result, permalinks };
}

/**
 * The adapter envelope: the operation's own payload plus its permalinks.
 *
 * An ADAPTER shape, not a DTO change — direct SDK callers keep the exact
 * return types they compile against today. Spreading is what makes it
 * non-breaking for the object-shaped results (all of them, currently), and a
 * scalar or array is nested under `result` instead of being spread into
 * numeric keys.
 */
export function withPermalinkEnvelope<TOutput>(
  result: TOutput,
  permalinks: PlatformPermalink[]
): Record<string, unknown> {
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), permalinks };
  }
  return { result, permalinks };
}

/**
 * One concise line per permalink, for surfaces whose rendering of structured
 * output cannot be relied on.
 *
 * Deliberately terse and capped: the permalink is intentionally model-visible,
 * but a list operation at its page limit would otherwise spend a large part of
 * a tool result on URLs.
 */
export function formatPermalinkLines(
  permalinks: readonly PlatformPermalink[],
  options: { limit?: number } = {}
): string {
  const limit = options.limit ?? 10;
  const shown = permalinks.slice(0, limit);
  const lines = shown.map(
    (permalink) => `${permalink.label}: ${permalink.url}`
  );
  if (permalinks.length > shown.length) {
    lines.push(
      `…and ${permalinks.length - shown.length} more in \`permalinks\`.`
    );
  }
  return lines.join("\n");
}
