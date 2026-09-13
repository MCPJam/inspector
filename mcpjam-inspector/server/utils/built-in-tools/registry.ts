import {
  resolveBrowserEngine,
  coerceBrowserEngineForActor,
} from "../computers/browser-engine.js";
import { guestBrowserProject } from "../computers/browser-rollout.js";
import { requireGithubToolSelection } from "../../services/github-checks/credential-policy.js";
/**
 * Host tool resolver: resolved host config → AI SDK ToolSet.
 *
 * THE single construction path from host-config fields to runnable built-in
 * tools, for every engine (chat-v2 routes, eval runners, sessionSimulation,
 * the docs agent). All knowledge of "which config field produces which tool,
 * with which gates" lives here; callers pass what their surface resolved and
 * stop knowing the details:
 *
 *   resolveHostTools({ builtInToolIds, computer }, ctx) → { web_search, bash, … }
 *
 * Two host-config fields feed it:
 *   - `builtInToolIds` — the CAPABILITY list (catalog ids, also the exact AI
 *     SDK tool names the model invokes).
 *   - `computer` — the RESOURCE attachment (a personal cloud workstation).
 *     It produces no tool by itself; computer-backed catalog ids (today:
 *     `bash`) are skipped unless the host carries it.
 *
 * Per-tool gates (all inside this module, by design):
 *   - web_search: requires Convex auth ctx (bills MCPJam credits server-side;
 *     guests are rejected by the Convex route at execute time). Inherits the
 *     host's `requireToolApproval` via ctx, like bash.
 *   - bash: TWO paths. With `ctx.sandboxBinding` (a trusted, in-process-only
 *     binding to an already-provisioned EPHEMERAL sandbox) it binds to that
 *     disposable box and the personal computer is never consulted. Without one
 *     it takes the personal path, which requires Convex auth ctx AND
 *     `computer`. Guests included on the personal path — the backend accepts
 *     guest bearers on /computers/reserve and contains cost via the guest daily
 *     start cap + idle-delete sweep. Inherits the host's `requireToolApproval`
 *     via ctx either way.
 *   - workspace tools (list_project_servers, diagnose_server,
 *     list/call_server_tool(s), prompts, resources — the shared platform
 *     operation catalog, see built-in-tools/mcpjam.ts): require
 *     ctx.mcpjamPlatformClient, the route-injected PlatformApiClient bound
 *     to the caller's bearer; engines that don't pass it never advertise
 *     them. Skipped for guest actors AND scenario sessions — mirrors the
 *     /api/v1 boundary ("Guests cannot access /api/v1"): the workspace
 *     surface is for project members, and the operations authorize via
 *     project membership, not scenario tokens. Connection-opening ops
 *     inherit `requireToolApproval` like bash does.
 *
 * Deliberately thin: this module merges tool sets, it does not absorb
 * per-surface policy. The eval engines simply never pass `computer` (a
 * personal computer is mutable per-user state an eval can't reproduce);
 * there is no isEval flag here and there must never be one.
 */
import type { ToolSet } from "ai";
import type { PlatformApiClient } from "@mcpjam/sdk/platform";
import { logger } from "../logger.js";
import {
  LOCAL_BROWSER_ENABLED,
  browserSecretPlaceholdersEnabled,
  hostedBrowserEnabled,
} from "../../config.js";
import {
  isHostedBrowserExposable,
  isHostedBrowserRefused,
} from "../computers/runtime-config.js";
import { type ExecutionScope } from "../execution-scope.js";
import {
  buildExaWebSearchTool,
  WEB_SEARCH_TOOL_NAME,
} from "./exa-web-search.js";
import { buildBashTool, BASH_TOOL_NAME } from "./bash.js";
import {
  coercePersonalEngineForActor,
  resolvePersonalComputerEngine,
  type ComputerEngine,
} from "../computers/engine.js";
import { buildSandboxBashTool } from "./sandbox-bash.js";
import { buildMcpjamTool, isMcpjamToolId } from "./mcpjam.js";
import {
  buildBrowserTools,
  type BrowserPageToolsSnapshot,
  type BrowserToolsResult,
  BROWSER_BUILT_IN_TOOL_ID,
  type BrowserApprovalDelivery,
  type BrowserSessionScope,
} from "./browser.js";
import type {
  DeclaredToolProvider,
  MintedDeclaredTool,
} from "@/shared/declared-tools";

/**
 * A binding to an EPHEMERAL sandbox the caller has ALREADY PROVISIONED.
 *
 * TRUSTED BY CONSTRUCTION, and that is the whole design. It lives on the
 * resolver's `ctx`, never on `config` — so it can only be set in-process by a
 * caller that just finished provisioning, and there is no wire or snapshot path
 * that can produce one.
 *
 * The alternative that does NOT work, recorded so it isn't re-proposed: widening
 * {@link HostComputerResource} into a `personal | ephemeral` union on
 * `config.computer`. `narrowHostComputer` runs at the TOP of
 * {@link resolveHostTools}, so an `ephemeral` variant arriving on `config` is
 * simply rejected — and dispatching before narrowing would mean trusting a
 * wire-forgeable value, which is strictly worse than today.
 */
export interface TrustedSandboxBinding {
  /** Vendor sandbox id the bash tool execs against. */
  sandboxId: string;
  /**
   * The CONTROL-PLANE row for the same box.
   *
   * The vendor id above is what a command execs against; this is what the
   * browser session is RECORDED against, and what every teardown path keys on.
   * A browser needs both — a daemon addressable by nothing durable is one no
   * replica can find and nothing can ever release.
   *
   * Optional only because bash never needed it; a browser binding always
   * carries it.
   */
  sandboxRowId?: string;
  /**
   * WHICH IMAGE this box booted, so the resolver can tell a browser-capable
   * machine from a shell. Absent ⇒ `terminal`, which is every binding that
   * predates desktop boxes. A `browser` tool on a terminal box would fail with
   * nothing saying why (no X server), so this is checked rather than assumed.
   */
  runtimeKind?: "terminal" | "desktop-browser";
  /** Working directory for commands (the personal path's semantics). */
  workdir?: string;
  /**
   * How long this box lives, which the tool DESCRIPTION tells the model.
   * `run` (default) is one eval iteration / one swarm attempt; `conversation`
   * is a scenario box that survives between turns. A model told its files vanish
   * after every run will not build work up across turns, so the wrong value
   * here changes behaviour, not just wording.
   */
  lifetime?: "run" | "conversation";
}

export interface BuiltInToolContext {
  /** Bearer authorization forwarded to Convex. "Bearer " prefix optional. */
  authHeader: string;
  /** Project the built-in tool's usage bills against / executes in. */
  projectId: string;
  /**
   * Phase 3 execution scope from the server-resolved runtime config. Threaded
   * into the computer-backed (bash) reserve call so the backend re-resolves
   * live access and applies per-swarm isolation/caps. Absent ⇒ legacy
   * `projectId` reserve (a backend that predates Phase 3, or a non-computer turn).
   */
  executionScope?: ExecutionScope;
  /** Optional chat session, used by Convex for idempotency namespacing. */
  chatSessionId?: string;
  /**
   * What THIS unattended run is — an eval iteration id, a simulated session
   * id. Required for an unattended browser and ignored otherwise: the
   * throwaway profile is keyed by it, and neither the project nor the swarm
   * identifies a run (a swarm fans out many, a suite runs many iterations
   * against one project), so without it two concurrent runs would share one
   * Chromium and each other's logged-in state.
   */
  runKey?: string;
  /**
   * True when the acting identity is a guest. Computer-backed tools are not
   * advertised to guests (the backend also omits `computer` from guest
   * runtime configs, and rejects guests at reserve — this is the middle of
   * three layers). Defaults to false for surfaces that pre-authenticate
   * non-guest actors (eval runners, sessionSimulation).
   */
  isGuest?: boolean;
  /**
   * True when this turn runs under a scenario / share-link token rather than
   * project membership. Workspace tools (`mcpjam_*`) are not advertised in
   * those sessions: the surface is for project members, and the live-op
   * pipeline authorizes via membership — a non-member visitor's calls would
   * all fail closed at Convex anyway.
   */
  isScenarioSession?: boolean;
  /**
   * The scenario this turn runs in, when it is a scenario turn. Unlike
   * {@link isScenarioSession} — which decides what to ADVERTISE — this is
   * forwarded to Convex so a spend can be billed to the scenario OWNER rather
   * than the visitor, who has no wallet to charge. Web search needs it for the
   * same reason the model turn and voice transcription already do.
   */
  scenarioId?: string;
  /**
   * True when this turn belongs to a Journey (swarm) simulated session.
   * Computer-backed tools are suppressed for those UNLESS the turn holds a
   * {@link sandboxBinding} — see the `bash` gate below.
   */
  isJourneySession?: boolean;
  /**
   * Resolved personal-computer engine for this turn (`computers/engine.ts`),
   * set by routes that parse the Local⇄Cloud preference. ABSENT ⇒ the legacy
   * cloud-family fork. Whatever arrives here is re-coerced fail-closed for
   * the actor before any tool is built — `local` is only ever honored for a
   * signed-in member's own direct turn.
   */
  computerEngine?: ComputerEngine;
  browserEngine?: ComputerEngine;
  /** Verified local guest, supplied by the request boundary, never the body. */
  localBrowserGuestId?: string;
  browserConsentToken?: string;
  localBrowserRequested?: boolean;
  browserUnavailableReason?: string;
  /**
   * The request EXPLICITLY (and validly) asked for the local engine. Only
   * used to pick the honest unavailable-error message inside the bash tool.
   */
  localComputerRequested?: boolean;
  /**
   * An ephemeral sandbox this turn already owns. Present ⇒ `bash` binds to that
   * disposable box instead of resolving the acting member's personal computer.
   *
   * Set ONLY in-process, by a caller that just provisioned (the swarm runner
   * after claiming an attempt). Never parsed from a request body or a run
   * snapshot — it does not exist on {@link HostToolsConfig} at all, so there is
   * no wire shape that can inject one.
   */
  sandboxBinding?: TrustedSandboxBinding;
  /**
   * MATERIALIZED project secrets for this turn, exported into every `bash`
   * command's environment.
   *
   * Delivered ONLY alongside {@link sandboxBinding}, and the pairing is the
   * policy rather than a coincidence of wiring: a sandbox is a disposable box
   * the project provisioned, while the two other bash paths run somewhere a
   * project's credential has no business being — `localBashRunner` on the
   * user's own machine (behind an env allowlist), and `execViaRemoteDataPlane`
   * through a request body to a plane that is not this box's. The gate below
   * reads `secretEnv` only inside the `sandboxBinding` branch, so an
   * accidentally-set value on another path is inert rather than dangerous.
   */
  secretEnv?: Record<string, string>;
  /** Fired when `secretEnv` actually reaches a command. See `sandbox-bash`. */
  onSecretEnvDelivered?: () => void;
  /** Host's approval policy — a root shell must honor it like MCP tools do. */
  requireToolApproval?: boolean;
  /**
   * Fired when a requested built-in is deliberately NOT advertised for a reason
   * the RUN should surface (today: `bash` in a Journey session). A silently
   * missing tool reads as a host-config bug to whoever opens the run, so
   * surfaces that can show a notice wire this; the rest get log-only behavior.
   */
  onToolSuppressed?: (info: { id: string; reason: string }) => void;
  /**
   * Platform API client for the MCPJam workspace tools, bound to the
   * caller's bearer (in the web chat it self-dispatches into this server's
   * own /api/v1). Absent on engines that don't wire it — those advertise no
   * workspace tools.
   */
  mcpjamPlatformClient?: PlatformApiClient;
  /**
   * Whether a person is watching this turn, for `browser_*` tools. ABSENT ⇒
   * the browser capability is NOT advertised, whatever the host config says
   * (see `built-in-tools/browser.ts`).
   *
   * Nothing is threaded back: each tool carries its own build-time
   * `needsApproval`, and every engine reads that. What this answers is the
   * question the builder cannot answer for itself — an interactive surface
   * passes `attested` and gets a persistent, signed-in browser whose every
   * verb asks first; an unattended run passes its declared policy and gets an
   * ephemeral one, keyed per run, with only the tools that policy permits.
   */
  browserApprovalDelivery?: BrowserApprovalDelivery;
  /** Durable watched browser identity for an interactive conversation. */
  browserSessionScope?: BrowserSessionScope;
  /** Explicit profile pin from a host/eval config. */
  browserProfileId?: string;
  /** Surface ids (chat session, eval iteration, swarm) echoed onto browser ledger rows. */
  browserCorrelation?: Parameters<typeof buildBrowserTools>[0]["correlation"];
  /**
   * Materialized secrets the browser may type without the model reading them.
   * Separate from {@link secretEnv} because the two destinations have
   * different gates. Absent means every placeholder is refused.
   */
  browserSecrets?: NonNullable<
    Parameters<typeof buildBrowserTools>[0]["secrets"]
  >["available"];
  /** Names that exist for this environment but are BROKERED, never typeable. */
  browserBrokeredSecretNames?: readonly string[];
  /** Fired with the NAMES that actually reached a browser. Never values. */
  onBrowserSecretDelivered?: (names: readonly string[]) => void;
  browserHandoffMaxWaitMs?: number;
  onBrowserHandoffWaiting?: Parameters<
    typeof buildBrowserTools
  >[0]["onHandoffWaiting"];
  browserSessionHandle?: Awaited<
    ReturnType<
      NonNullable<Parameters<typeof buildBrowserTools>[0]["ensureSession"]>
    >
  >;
  /** Surface notices while a conversation browser waits for capacity. */
  onBrowserNotice?: (notice: string) => void;
  /**
   * The page tools this turn STARTS with, read before the turn began by
   * `peekPageTools`.
   *
   * Read-only and pre-resolved on purpose: this resolver is synchronous, and a
   * browser read inside it would put a daemon round trip on the critical path
   * of every turn that merely MENTIONS the browser capability. The route does
   * the read (and decides whether to do it at all) and hands the answer down.
   */
  browserPageTools?: BrowserPageToolsSnapshot;
  /**
   * This turn's engine can grow its tool set between model steps. Decides
   * whether a mid-turn refresher is built and how observations describe the
   * page's tools.
   */
  browserDynamicPageTools?: boolean;
  /**
   * Whether to retire `browser_webmcp_invoke` here.
   *
   * Split from the flag above for callers that cannot yet say which engine
   * will run the turn — see `BrowserToolsOptions.retireInvokeVerb`. Absent ⇒
   * follow `browserDynamicPageTools`.
   */
  browserRetireInvokeVerb?: boolean;
  /** Which provider's tool-schema subset page schemas are reported against. */
  browserProvider?: DeclaredToolProvider;
  /**
   * What the browser capability actually advertised from the page, so the turn
   * can PERSIST it. Deriving it later from the live browser would attribute a
   * reopened conversation's cards to whatever page the browser is on now.
   */
  onBrowserPageTools?: (info: {
    minted: MintedDeclaredTool[];
    notices: Array<{ rawName: string; reason: string }>;
  }) => void;
  /**
   * Receives the mid-turn page-tool refresher, when this turn built one.
   *
   * The route hands it to the engine's `refreshTools` hook. It exists here
   * rather than being returned because the browser is one built-in among
   * several and this resolver's return value is a plain `ToolSet` — the same
   * reason `onBrowserPageTools` is a callback.
   */
  onBrowserToolsRefresh?: (refresh: {
    refreshPageTools: NonNullable<BrowserToolsResult["refreshPageTools"]>;
    currentPageTools: NonNullable<BrowserToolsResult["currentPageTools"]>;
    /** The generation those tools are bound to; moves with them. */
    currentPageToolsBinding: NonNullable<
      BrowserToolsResult["currentPageToolsBinding"]
    >;
  }) => void;
}

/** The host-config fields this resolver consumes. */
export interface HostToolsConfig {
  builtInToolIds?: ReadonlyArray<string>;
  /**
   * The host's `computer` value as it arrived from the server-resolved
   * runtime config — accepted as `unknown` so the shape-narrowing (and any
   * legacy-key tolerance) lives here rather than at every call site.
   */
  computer?: unknown;
}

export interface HostComputerResource {
  kind: "personal";
  workdir?: string;
}

/**
 * Narrow an untrusted runtime-config `computer` value to the PERSONAL resource
 * shape. Tolerates (and ignores) the legacy `toolset` key that pre-split
 * backends still persist; rejects everything else by returning null.
 *
 * `kind: "personal"` is required, and that requirement is LOAD-BEARING now that
 * the column carries a second kind. `kind: "ephemeral"` names a per-run box the
 * platform provisioned; it is not a resource this resolver can reach — the
 * personal path below resolves a machine per (project, user), and a per-run box
 * has neither. A turn that owns one passes it out of band as
 * `ctx.sandboxBinding`, which is checked FIRST and returns before any of this.
 *
 * So the two paths cannot both fire: an eval iteration whose pinned config
 * carries an ephemeral computer gets its `bash` from the binding, or from the
 * runner's own out-of-band injection, and never a second one from here.
 * Returning the ephemeral kind as a personal resource would be the double
 * registration — and worse, would point the tool at the caller's own machine.
 */
export function narrowHostComputer(
  value: unknown,
): HostComputerResource | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { kind?: unknown; workdir?: unknown };
  if (candidate.kind !== "personal") return null;
  const workdir =
    typeof candidate.workdir === "string" && candidate.workdir.trim()
      ? candidate.workdir
      : undefined;
  return { kind: "personal", ...(workdir ? { workdir } : {}) };
}

function normalizeAuthHeader(raw: string): string {
  // Scheme matching is case-insensitive per RFC 7235 — a client may send
  // "bearer x"; prefixing that again would produce "Bearer bearer x".
  const value = raw.trim();
  return /^bearer\s/i.test(value) ? value : `Bearer ${value}`;
}

/**
 * Build the ToolSet for a resolved host config. Returns `undefined` when
 * there is nothing to advertise — no ids, or no Convex auth to execute them
 * with (e.g. local BYOK eval iterations, which pass `ctx: null`).
 *
 * Unknown ids are skipped with a warn (a newer backend catalog may advertise
 * ids this inspector build doesn't implement yet — degrading to "tool
 * absent" is what the model would see if the host never enabled it).
 * Computer-backed ids without a computer attached are skipped the same way:
 * the backend write-validation should have prevented that combination, so a
 * skip here is drift worth logging, not crashing over.
 */
export function resolveHostTools(
  config: HostToolsConfig,
  ctx: BuiltInToolContext | null,
): ToolSet | undefined {
  const ids = config.builtInToolIds ?? [];
  if (ids.length === 0) return undefined;
  requireGithubToolSelection(ids);
  if (!ctx) {
    logger.debug(
      "[built-in-tools] builtInToolIds requested without Convex auth context; omitting",
      { ids: [...ids] },
    );
    return undefined;
  }

  // Reject the whole unattended target before advertising either tool: a
  // shell on the shared box could read the pinned profile or daemon secrets.
  if (
    (ctx.sandboxBinding ||
      ctx.isJourneySession ||
      ctx.browserApprovalDelivery?.kind === "unattended") &&
    ctx.browserProfileId &&
    ids.includes(BASH_TOOL_NAME) &&
    ids.includes(BROWSER_BUILT_IN_TOOL_ID)
  ) {
    throw new Error(
      "browser_profile_shell_conflict: An unattended target with Browser and Bash must use a blank Browser profile. Remove the saved profile pin or Bash.",
    );
  }

  const authHeader = normalizeAuthHeader(ctx.authHeader);
  const computer = narrowHostComputer(config.computer);
  const out: ToolSet = {};

  for (const id of ids) {
    if (id === WEB_SEARCH_TOOL_NAME) {
      out[WEB_SEARCH_TOOL_NAME] = buildExaWebSearchTool({
        authHeader,
        projectId: ctx.projectId,
        ...(ctx.chatSessionId ? { chatSessionId: ctx.chatSessionId } : {}),
        // Lets Convex bill the scenario owner. Unlike `bash` and the
        // `mcpjam_*` tools below, web search stays ADVERTISED in a scenario
        // session — so without this it is offered to the model and then
        // fails at execution for every link visitor.
        ...(ctx.scenarioId ? { scenarioId: ctx.scenarioId } : {}),
        requireToolApproval: ctx.requireToolApproval,
      });
      continue;
    }
    if (id === BASH_TOOL_NAME) {
      // EPHEMERAL PATH. This turn already owns a disposable box booted from the
      // environment's pinned image, so bash binds straight to it. The personal
      // computer is not consulted, and cannot be: the binding arrived
      // out-of-band on `ctx`, never through `config`.
      //
      // Checked FIRST, before every other gate, because a holder of a binding
      // has by construction already passed the backend's provision
      // authorization (project member + run launcher + a claimed, running
      // attempt) — the gates below all reason about the personal path.
      if (ctx.sandboxBinding) {
        out[BASH_TOOL_NAME] = buildSandboxBashTool({
          sandboxId: ctx.sandboxBinding.sandboxId,
          ...(ctx.sandboxBinding.workdir
            ? { workdir: ctx.sandboxBinding.workdir }
            : {}),
          ...(ctx.sandboxBinding.lifetime
            ? { lifetime: ctx.sandboxBinding.lifetime }
            : {}),
          // Read INSIDE this branch on purpose — see `secretEnv`'s own comment.
          // A project secret reaches a box the project provisioned, and nothing
          // else.
          ...(ctx.onSecretEnvDelivered
            ? { onSecretEnvDelivered: ctx.onSecretEnvDelivered }
            : {}),
          ...(ctx.secretEnv && Object.keys(ctx.secretEnv).length > 0
            ? { secretEnv: ctx.secretEnv }
            : {}),
          requireToolApproval: ctx.requireToolApproval,
        });
        continue;
      }
      // Journey (swarm) sessions with NO ephemeral binding get NO bash. Every
      // session in a run would otherwise reserve — and concurrently share — the
      // LAUNCHER's single project computer, so one session's filesystem writes
      // are visible to the next. That's an eval-validity bug, not a scaling
      // nit: the whole point of a simulated run is that each session is
      // independent.
      //
      // Threading `executionScope` can't fix it. `kind: "swarm"` is a hosted-
      // scenario grant (it keys on `swarmId: Id<'scenarios'>` + accessVersion),
      // not a Journey run, and a signed-in launcher resolves to
      // `project_member` — so a Journey run's bash lands right back on that
      // shared computer. Real isolation is the per-attempt sandbox above.
      //
      // With the binding living on `ctx`, this is airtight rather than
      // policed: a journey turn either holds an in-process ephemeral binding or
      // gets no shell, and the `personal` branch below is unreachable for it.
      // The check stays BEFORE the `!computer` check so the journey-specific
      // message wins over the generic "no computer attached" skip.
      if (ctx.isJourneySession) {
        const reason =
          "bash is disabled in simulated (swarm) sessions that have no " +
          "disposable sandbox of their own: it would otherwise share the " +
          "launcher's project computer with every other session in the run.";
        logger.warn("[built-in-tools] bash suppressed for a Journey session", {
          projectId: ctx.projectId,
          chatSessionId: ctx.chatSessionId,
        });
        ctx.onToolSuppressed?.({ id, reason });
        continue;
      }
      if (!computer) {
        logger.warn(
          "[built-in-tools] bash requested without a computer attached; skipping",
          { projectId: ctx.projectId },
        );
        continue;
      }
      // Anonymous guests get bash ONLY on a host-funded swarm grant
      // (executionScope.kind === "swarm"), where a member host opted in and
      // pays under per-swarm caps. On the legacy/personal-project path the
      // backend now rejects guest reserves (projectComputers
      // `assertNonGuestComputerActor`, mirroring inspector #3132), so
      // advertising bash there would only produce a tool that errors — skip it.
      if (ctx.isGuest && ctx.executionScope?.kind !== "swarm") {
        logger.debug(
          "[built-in-tools] bash not advertised to guest actor without a host-funded swarm scope; skipping",
          { projectId: ctx.projectId },
        );
        continue;
      }
      // Engine coercion — the SECOND, independent layer under the route-level
      // parse gates: whatever engine the route resolved, `local` survives
      // only for a signed-in member's own direct turn. Everything else
      // (guest, scenario session, journey, swarm scope) re-resolves to the
      // cloud family right here at the chokepoint.
      const requestedEngine =
        ctx.computerEngine ??
        resolvePersonalComputerEngine({ localConsentValid: false });
      const engine = coercePersonalEngineForActor(requestedEngine, {
        isGuest: Boolean(ctx.isGuest),
        isScenarioSession: Boolean(ctx.isScenarioSession),
        isJourneySession: Boolean(ctx.isJourneySession),
        executionScopeKind: ctx.executionScope?.kind,
      });
      if (engine !== requestedEngine) {
        logger.warn(
          "[built-in-tools] local computer engine downgraded for an ineligible actor",
          {
            projectId: ctx.projectId,
            requestedEngine,
            engine,
            isGuest: Boolean(ctx.isGuest),
            isScenarioSession: Boolean(ctx.isScenarioSession),
          },
        );
      }
      out[BASH_TOOL_NAME] = buildBashTool({
        authHeader,
        projectId: ctx.projectId,
        // Phase 3: thread the server-resolved execution scope so the reserve
        // call re-resolves live access (per-swarm isolation/caps). Absent ⇒
        // legacy projectId reserve.
        ...(ctx.executionScope ? { executionScope: ctx.executionScope } : {}),
        // E2B `/home/user` semantics — the local engine ignores it and uses
        // its own workspace dir (see local-machine.ts).
        workdir: computer.workdir,
        requireToolApproval: ctx.requireToolApproval,
        engine,
        localEngineRequested: ctx.localComputerRequested === true,
      });
      continue;
    }
    if (id === BROWSER_BUILT_IN_TOOL_ID) {
      // Browser has its own engine and grant. Ineligible actors cannot use
      // local Browser, and an explicit local request never moves to Cloud.
      const requestedEngine =
        ctx.browserEngine ?? resolveBrowserEngine({ localConsentValid: false });
      const resolvedEngine = coerceBrowserEngineForActor(requestedEngine, {
        isGuest: Boolean(ctx.isGuest),
        localGuestAuthorized: Boolean(ctx.localBrowserGuestId),
        isScenarioSession: Boolean(ctx.isScenarioSession),
        isJourneySession: Boolean(ctx.isJourneySession),
        executionScopeKind: ctx.executionScope?.kind,
      });
      // Preserve explicit-location failures. Legacy hosted callers still
      // pass through the hosted provisioning and entitlement gates below.
      if (
        resolvedEngine === "unavailable" &&
        (ctx.localBrowserRequested === true ||
          requestedEngine === "local" ||
          Boolean(ctx.browserUnavailableReason))
      ) {
        logger.warn(
          "[built-in-tools] browser suppressed: this machine was requested but is unavailable",
          { projectId: ctx.projectId },
        );
        ctx.onToolSuppressed?.({
          id,
          reason:
            ctx.browserUnavailableReason ??
            "browser is not available: this turn asked for the browser on this " +
              "machine, and this machine cannot serve it — check that local " +
              "Browser permission is still granted.",
        });
        continue;
      }
      const isLocalBrowser = resolvedEngine === "local";
      const conversationBrowser = ctx.browserSessionScope;

      // The local engine's own kill switch, read HERE and not only where a
      // session is started. Every other layer already honors it — the routes
      // 404, `ensureLocalBrowserSession` refuses — and that is exactly what
      // made the gap easy to miss. A tool that is advertised and then throws
      // on its first call is worse than one never offered: the model spends a
      // turn discovering a capability the operator turned off, and the failure
      // reads as a broken page rather than a closed door.
      if (isLocalBrowser && !LOCAL_BROWSER_ENABLED) {
        logger.warn(
          "[built-in-tools] browser suppressed: the local browser engine is switched off",
          { projectId: ctx.projectId },
        );
        ctx.onToolSuppressed?.({
          id,
          reason:
            "browser is not available: the browser on this machine is switched " +
            "off on this server (MCPJAM_LOCAL_BROWSER_ENABLED).",
        });
        continue;
      }

      // The three HOSTED gates. A local browser is not a hosted resource: it
      // boots no desktop, reserves nothing, and costs no credits, so gating it
      // on the hosted rollout's env flag and the backend's desktop-template
      // readiness would refuse a capability neither of them describes.
      if (!isLocalBrowser && !hostedBrowserEnabled()) {
        logger.debug(
          "[built-in-tools] browser requested while HOSTED_BROWSER_TOOLS_ENABLED is off; skipping",
          { projectId: ctx.projectId },
        );
        ctx.onToolSuppressed?.({ id, reason: "HOSTED_BROWSER_TOOLS_ENABLED is disabled on this server." });
        continue;
      }
      // The backend's own gate (catalog entry + desktop template + desktop
      // credit rate). An explicit `false` is honored even with the env flag
      // on: the likeliest reason is an unset desktop rate, which would meter
      // every hosted browser hour at the terminal rate. On a HOSTED replica
      // silence is a refusal too — see `isHostedBrowserRefused` — because the
      // gate the inspector route reads treats it the same way, and two callers
      // disagreeing about the same silence is how a browser gets exposed that
      // the other half believes is closed.
      if (!isLocalBrowser && isHostedBrowserRefused()) {
        // Said separately, because they are different facts and only one of
        // them is the backend's answer. A `null` verdict means we never got an
        // answer — an older backend, or bootstrap not yet run — and reporting
        // that as "the backend reports it is not exposable" sends whoever
        // reads this log looking at a setting nobody has set.
        const answered = isHostedBrowserExposable() === false;
        logger.warn(
          answered
            ? "[built-in-tools] browser suppressed: the backend reports it is not exposable"
            : "[built-in-tools] browser suppressed: no exposure verdict from the backend yet",
          { projectId: ctx.projectId },
        );
        ctx.onToolSuppressed?.({
          id,
          reason: answered
            ? "browser is not available on this deployment yet: the backend reports " +
              "the hosted browser runtime is not fully configured."
            : "browser is not available on this deployment yet: this server has no " +
              "exposure verdict from the backend.",
        });
        continue;
      }
      // ── WHICH BOX, decided FIRST (mirrors the bash branch) ────────────
      //
      // A run that brought its OWN box is a different machine from the
      // member's project computer, and almost every gate below is about the
      // project computer. Reading the binding first is what lets those gates
      // stay about the thing they describe instead of accumulating "…unless a
      // sandbox" clauses.
      const sandboxBrowser =
        !isLocalBrowser && ctx.sandboxBinding?.sandboxRowId
          ? ctx.sandboxBinding
          : undefined;
      if (
        !isLocalBrowser &&
        ctx.sandboxBinding &&
        (!sandboxBrowser ||
          ctx.sandboxBinding.runtimeKind !== "desktop-browser")
      ) {
        // The run HAS a box, and it is the wrong kind (or predates the row id
        // a browser session needs). A browser on a terminal image fails with
        // nothing saying why — there is no X server for Chromium to draw on —
        // so say it here rather than let the model spend a turn discovering it.
        logger.warn(
          "[built-in-tools] browser suppressed: this run's sandbox is not a desktop box",
          { projectId: ctx.projectId },
        );
        ctx.onToolSuppressed?.({
          id,
          reason:
            "browser is not advertised: this run's sandbox is not a desktop " +
            "(browser) box, and a browser cannot run on a terminal image.",
        });
        continue;
      }
      // AN UNATTENDED RUN NEEDS A BOX OF ITS OWN, whatever surface it came
      // from. Generalized from the journey-only gate it replaces: an eval is
      // in exactly the same position, and the hosted engine has ONE computer
      // per project+member — so without a binding every unattended run in a
      // project would drive the same Chromium and the same cookie jar, and the
      // ephemeral request that isolation needs would relaunch the daemon a
      // person may be using.
      if (
        !isLocalBrowser &&
        !sandboxBrowser &&
        (ctx.isJourneySession ||
          ctx.browserApprovalDelivery?.kind === "unattended")
      ) {
        ctx.onToolSuppressed?.({
          id,
          reason:
            "browser is not advertised to an unattended run without a disposable " +
            "sandbox of its own: runs would share one browser profile.",
        });
        continue;
      }
      // A COMPUTER attachment, for the project-computer path only. A per-run
      // box IS the computer here, and it arrives on `ctx` rather than on the
      // host config — which is the whole point: nothing in a member-readable
      // snapshot can forge one.
      if (
        !isLocalBrowser &&
        !sandboxBrowser &&
        !computer &&
        !conversationBrowser
      ) {
        logger.warn(
          "[built-in-tools] browser requested without a computer attached; skipping",
          { projectId: ctx.projectId },
        );
        continue;
      }
      if (ctx.isGuest && !(isLocalBrowser && ctx.localBrowserGuestId)) {
        logger.debug(
          "[built-in-tools] browser not advertised to guest actors; skipping",
          { projectId: ctx.projectId },
        );
        continue;
      }
      if (resolvedEngine !== requestedEngine) {
        logger.warn(
          "[built-in-tools] local browser engine downgraded for an ineligible actor",
          {
            projectId: ctx.projectId,
            requestedEngine,
            engine: resolvedEngine,
            isGuest: Boolean(ctx.isGuest),
            isScenarioSession: Boolean(ctx.isScenarioSession),
          },
        );
      }
      const browser = buildBrowserTools({
        authHeader,
        projectId: ctx.localBrowserGuestId
          ? guestBrowserProject(ctx.projectId, ctx.localBrowserGuestId)
          : ctx.projectId,
        localGuest: Boolean(ctx.localBrowserGuestId),
        engine: isLocalBrowser ? "local" : "hosted",
        localConsentToken: ctx.browserConsentToken,
        handoffMaxWaitMs: ctx.browserHandoffMaxWaitMs,
        onHandoffWaiting: ctx.onBrowserHandoffWaiting,
        ...(ctx.browserSessionHandle
          ? { ensureSession: async () => ctx.browserSessionHandle! }
          : {}),
        // The host's switch, exactly as bash gets it. This family follows it
        // rather than overruling it.
        requireToolApproval: ctx.requireToolApproval,
        ...(ctx.executionScope ? { executionScope: ctx.executionScope } : {}),
        // The run's own identity, falling back to the chat session when a
        // surface has one — both name a single run, which is all the ephemeral
        // profile key needs. Unused on an interactive turn.
        ...((ctx.runKey ?? ctx.chatSessionId)
          ? { runKey: ctx.runKey ?? ctx.chatSessionId }
          : {}),
        // ABSENT ⇒ buildBrowserTools advertises nothing. That is what keeps
        // every surface which threads no approval safe without editing it.
        ...(ctx.browserApprovalDelivery
          ? { approvalDelivery: ctx.browserApprovalDelivery }
          : {}),
        ...(conversationBrowser ? { sessionScope: conversationBrowser } : {}),
        ...(ctx.browserProfileId
          ? { browserProfileId: ctx.browserProfileId }
          : {}),
        ...(ctx.browserCorrelation
          ? { correlation: ctx.browserCorrelation }
          : {}),
        // Gated once here for all surfaces. Brokered names alone also admit it,
        // so they get `secret_not_typeable` rather than `secret_unknown`.
        ...(browserSecretPlaceholdersEnabled() &&
        (ctx.browserSecrets?.length || ctx.browserBrokeredSecretNames?.length)
          ? {
              secrets: {
                available: ctx.browserSecrets ?? [],
                ...(ctx.browserBrokeredSecretNames?.length
                  ? { brokered: ctx.browserBrokeredSecretNames }
                  : {}),
                ...(ctx.onBrowserSecretDelivered
                  ? { onDelivered: ctx.onBrowserSecretDelivered }
                  : {}),
              },
            }
          : {}),
        ...(ctx.onBrowserNotice
          ? { onBrowserNotice: ctx.onBrowserNotice }
          : {}),
        ...(ctx.onToolSuppressed
          ? { onToolSuppressed: ctx.onToolSuppressed }
          : {}),
        // The run's OWN box, when it has one. Trusted by construction: it
        // rides `ctx`, never `config`, so only an in-process caller that just
        // provisioned can set it.
        ...(sandboxBrowser
          ? {
              sandboxTarget: {
                sandboxRowId: sandboxBrowser.sandboxRowId!,
                sandboxId: sandboxBrowser.sandboxId,
                record: ctx.browserApprovalDelivery?.kind === "unattended",
              },
            }
          : {}),
        // ABSENT ⇒ no `webmcp_*` tools, whatever the flag says. A turn only
        // gets them when its route decided to read the page and got an answer.
        ...(ctx.browserPageTools ? { pageTools: ctx.browserPageTools } : {}),
        ...(ctx.browserDynamicPageTools
          ? { dynamicPageTools: true as const }
          : {}),
        ...(ctx.browserRetireInvokeVerb !== undefined
          ? { retireInvokeVerb: ctx.browserRetireInvokeVerb }
          : {}),
        ...(ctx.browserProvider ? { provider: ctx.browserProvider } : {}),
      });
      if (browser) {
        Object.assign(out, browser.tools);
        if (browser.pageTools || browser.pageToolNotices) {
          ctx.onBrowserPageTools?.({
            minted: browser.pageTools ?? [],
            notices: browser.pageToolNotices ?? [],
          });
        }
        if (
          browser.refreshPageTools &&
          browser.currentPageTools &&
          browser.currentPageToolsBinding
        ) {
          ctx.onBrowserToolsRefresh?.({
            refreshPageTools: browser.refreshPageTools,
            currentPageTools: browser.currentPageTools,
            currentPageToolsBinding: browser.currentPageToolsBinding,
          });
        }
      }
      continue;
    }
    if (isMcpjamToolId(id)) {
      if (ctx.isGuest || ctx.isScenarioSession) {
        logger.debug(
          "[built-in-tools] workspace tools not advertised to guest/scenario actors; skipping",
          { id },
        );
        continue;
      }
      if (!ctx.mcpjamPlatformClient) {
        logger.debug(
          "[built-in-tools] workspace tool id without a platform client; skipping",
          { id },
        );
        continue;
      }
      const built = buildMcpjamTool(id, {
        client: ctx.mcpjamPlatformClient,
        projectId: ctx.projectId,
        requireToolApproval: ctx.requireToolApproval,
      });
      if (!built) {
        logger.warn("[built-in-tools] unknown workspace tool id; skipping", {
          id,
        });
        continue;
      }
      out[id] = built;
      continue;
    }
    logger.warn("[built-in-tools] unknown builtInToolId; skipping", { id });
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
