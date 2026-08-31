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
 *     guests are rejected by the Convex route at execute time).
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
import { hostedBrowserEnabled } from "../../config.js";
import { isHostedBrowserExposable } from "../computers/runtime-config.js";
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
  BROWSER_BUILT_IN_TOOL_ID,
  type BrowserApprovalDelivery,
} from "./browser.js";
import type { UiToolApprovalClassification } from "@/shared/client-fulfilled-tools";

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
   * How approval reaches the user for `browser_*` tools this turn. ABSENT ⇒
   * the browser capability is NOT advertised, whatever the host config says
   * (see `built-in-tools/browser.ts`): approval on the hosted engines is
   * classified by name, and a surface that threads nothing would let a model
   * drive a real browser ungated. Interactive surfaces pass `attested` and
   * thread the returned classification; unattended runs pass their declared
   * policy.
   */
  browserApprovalDelivery?: BrowserApprovalDelivery;
  /**
   * Receives the approval classification for the browser tools that were
   * built, so the caller can merge it into the engine's single
   * `uiToolApprovals` slot. Absent on surfaces that do not advertise them.
   */
  onBrowserApprovals?: (approvals: UiToolApprovalClassification) => void;
  /**
   * Accept the bash/browser co-tenancy trust boundary for this turn. Both
   * drive the SAME computer as the same uid, so a shell can read the driven
   * browser's cookies and its daemon token out of the process environment —
   * which turns a page-injected prompt into a credential-theft path. Default
   * (absent) suppresses `browser` when `bash` is also present; the backend
   * refuses to PERSIST the pair at all, so this only covers runtime drift and
   * deployments that have accepted the boundary.
   */
  allowComputerToolCoTenancy?: boolean;
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
  if (!ctx) {
    logger.debug(
      "[built-in-tools] builtInToolIds requested without Convex auth context; omitting",
      { ids: [...ids] },
    );
    return undefined;
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
      // Dark switch: the runtime ships behind an env flag so staging can drive
      // it before the durable backend exposure gate opens (W7). Absent ⇒ the
      // capability simply is not advertised.
      if (!hostedBrowserEnabled()) {
        logger.debug(
          "[built-in-tools] browser requested while HOSTED_BROWSER_TOOLS_ENABLED is off; skipping",
          { projectId: ctx.projectId },
        );
        continue;
      }
      // The backend's own gate (catalog entry + desktop template + desktop
      // credit rate). An explicit `false` is honored even with the env flag
      // on: the likeliest reason is an unset desktop rate, which would meter
      // every hosted browser hour at the terminal rate. Silence (an older
      // backend, or bootstrap not yet run) is not a refusal — the env flag
      // above is already dark by default and is what staging drives with.
      if (isHostedBrowserExposable() === false) {
        logger.warn(
          "[built-in-tools] browser suppressed: the backend reports it is not exposable",
          { projectId: ctx.projectId },
        );
        ctx.onToolSuppressed?.({
          id,
          reason:
            "browser is not available on this deployment yet: the backend reports " +
            "the hosted browser runtime is not fully configured.",
        });
        continue;
      }
      // Co-tenancy: a shell and a driven browser on ONE box, as one uid. Keep
      // `bash` (behavior-preserving for hosts that already have it) and drop
      // `browser`, unless this deployment accepted the boundary.
      if (ids.includes(BASH_TOOL_NAME) && !ctx.allowComputerToolCoTenancy) {
        const reason =
          "browser is not advertised alongside bash: both drive the same computer as " +
          "the same user, so a shell can read the browser's cookies and its daemon " +
          "token out of the process environment.";
        logger.warn("[built-in-tools] browser suppressed for bash co-tenancy", {
          projectId: ctx.projectId,
        });
        ctx.onToolSuppressed?.({ id, reason });
        continue;
      }
      if (ctx.isJourneySession && !ctx.sandboxBinding) {
        // Same reasoning as bash: every session in a run would otherwise share
        // the LAUNCHER's single computer — and therefore one browser profile.
        ctx.onToolSuppressed?.({
          id,
          reason:
            "browser is disabled in simulated (swarm) sessions without a disposable " +
            "sandbox of their own: sessions would share one browser profile.",
        });
        continue;
      }
      if (!computer) {
        logger.warn(
          "[built-in-tools] browser requested without a computer attached; skipping",
          { projectId: ctx.projectId },
        );
        continue;
      }
      if (ctx.isGuest) {
        logger.debug(
          "[built-in-tools] browser not advertised to guest actors; skipping",
          { projectId: ctx.projectId },
        );
        continue;
      }
      const browser = buildBrowserTools({
        authHeader,
        projectId: ctx.projectId,
        ...(ctx.executionScope ? { executionScope: ctx.executionScope } : {}),
        // ABSENT ⇒ buildBrowserTools advertises nothing. That is what keeps
        // every surface which threads no approval safe without editing it.
        ...(ctx.browserApprovalDelivery
          ? { approvalDelivery: ctx.browserApprovalDelivery }
          : {}),
        ...(ctx.onToolSuppressed
          ? { onToolSuppressed: ctx.onToolSuppressed }
          : {}),
      });
      if (browser) {
        Object.assign(out, browser.tools);
        ctx.onBrowserApprovals?.(browser.approvals);
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
