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
 *   - bash: requires Convex auth ctx AND `computer`. Guests included — the
 *     backend accepts guest bearers on /computers/reserve and contains cost
 *     via the guest daily start cap + idle-delete sweep. Inherits the host's
 *     `requireToolApproval` via ctx.
 *   - mcpjam_*: workspace tools (list / diagnose / run live MCP ops on the
 *     project's saved servers). Skipped for guest actors AND chatbox
 *     sessions — mirrors the /api/v1 boundary ("Guests cannot access
 *     /api/v1"): the workspace surface is for project members, and the
 *     live-op pipeline authorizes via project membership, not chatbox
 *     tokens. Live-op ids additionally require ctx.mcpjamLiveOps (the
 *     route-layer authorize→connect→run runner); engines that don't pass it
 *     never advertise those tools. Only `mcpjam_list_servers` is runner-free
 *     (a plain Convex read). Connection-opening ops inherit
 *     `requireToolApproval` like bash does.
 *
 * Deliberately thin: this module merges tool sets, it does not absorb
 * per-surface policy. The eval engines simply never pass `computer` (a
 * personal computer is mutable per-user state an eval can't reproduce);
 * there is no isEval flag here and there must never be one.
 */
import type { ToolSet } from "ai";
import { logger } from "../logger.js";
import {
  buildExaWebSearchTool,
  WEB_SEARCH_TOOL_NAME,
} from "./exa-web-search.js";
import { buildBashTool, BASH_TOOL_NAME } from "./bash.js";
import {
  buildMcpjamTool,
  isMcpjamToolId,
  type McpjamLiveOps,
} from "./mcpjam.js";

export interface BuiltInToolContext {
  /** Bearer authorization forwarded to Convex. "Bearer " prefix optional. */
  authHeader: string;
  /** Project the built-in tool's usage bills against / executes in. */
  projectId: string;
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
   * True when this turn runs under a chatbox / share-link token rather than
   * project membership. Workspace tools (`mcpjam_*`) are not advertised in
   * those sessions: the surface is for project members, and the live-op
   * pipeline authorizes via membership — a non-member visitor's calls would
   * all fail closed at Convex anyway.
   */
  isChatboxSession?: boolean;
  /** Host's approval policy — a root shell must honor it like MCP tools do. */
  requireToolApproval?: boolean;
  /**
   * Route-layer runner for the `mcpjam_*` live MCP operations (ephemeral
   * authorize→connect→run). Absent on engines that can't open ephemeral
   * connections — those advertise only the runner-free workspace tools.
   */
  mcpjamLiveOps?: McpjamLiveOps;
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
 * Narrow an untrusted runtime-config `computer` value to the resource shape.
 * Tolerates (and ignores) the legacy `toolset` key that pre-split backends
 * still persist; rejects everything else by returning null.
 */
export function narrowHostComputer(
  value: unknown
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
  ctx: BuiltInToolContext | null
): ToolSet | undefined {
  const ids = config.builtInToolIds ?? [];
  if (ids.length === 0) return undefined;
  if (!ctx) {
    logger.debug(
      "[built-in-tools] builtInToolIds requested without Convex auth context; omitting",
      { ids: [...ids] }
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
      });
      continue;
    }
    if (id === BASH_TOOL_NAME) {
      if (!computer) {
        logger.warn(
          "[built-in-tools] bash requested without a computer attached; skipping",
          { projectId: ctx.projectId }
        );
        continue;
      }
      // Guests get bash too: the backend accepts guest bearers on
      // /computers/reserve and contains cost via the guest daily start cap
      // and the idle-delete sweep.
      out[BASH_TOOL_NAME] = buildBashTool({
        authHeader,
        projectId: ctx.projectId,
        workdir: computer.workdir,
        requireToolApproval: ctx.requireToolApproval,
      });
      continue;
    }
    if (isMcpjamToolId(id)) {
      if (ctx.isGuest || ctx.isChatboxSession) {
        logger.debug(
          "[built-in-tools] mcpjam tools not advertised to guest/chatbox actors; skipping",
          { id }
        );
        continue;
      }
      const built = buildMcpjamTool(id, {
        authHeader,
        projectId: ctx.projectId,
        liveOps: ctx.mcpjamLiveOps,
        requireToolApproval: ctx.requireToolApproval,
      });
      if (!built) {
        logger.debug(
          "[built-in-tools] mcpjam live-op id without a runner; skipping",
          { id }
        );
        continue;
      }
      out[id] = built;
      continue;
    }
    logger.warn("[built-in-tools] unknown builtInToolId; skipping", { id });
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
