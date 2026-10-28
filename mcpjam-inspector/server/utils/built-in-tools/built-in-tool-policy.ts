/**
 * Which of the requested built-in tools a chat turn actually gets (MJ-008).
 *
 * `builtInToolIds` reaches `/api/web/chat-v2` in the request body, on ad-hoc
 * and host-bound turns alike. This narrows the list, before `resolveHostTools`
 * sees it, in three independent ways:
 *
 *   1. UNKNOWN IDS are dropped. The registry already skipped them, one warning
 *      at a time; dropping them here makes the list the rest of the turn sees
 *      (and records) the list that runs.
 *   2. CONFIGURATION IS AN UPPER BOUND. "Configuration" is the host config the
 *      turn resolves to: the saved host (`hostId`) on a host-bound turn, and
 *      the project's DEFAULT host config (`hostConfigsV2:getProjectDefault`,
 *      the same record the Playground reads when no host is selected) on an
 *      ad-hoc one. The body may narrow it freely and may add only `browser` —
 *      the Playground's documented temporary Browser override. An ad-hoc turn
 *      in a project with no default config has nothing to bound it, which is
 *      today's behavior. Scenario and environment turns never read the body
 *      list at all (see `chat-v2.ts`), so they need no bound here.
 *   3. WORKSPACE TOOLS FOLLOW THE CALLER'S PROJECT ROLE
 *      (`projects:getProjectCapabilities`): none without project access,
 *      reads only for a role that cannot edit, and none at all when access
 *      could not be established. Guests never get them (the registry agrees).
 *
 * It also resolves the turn's WORKSPACE APPROVAL SETTING, from the same
 * configuration: the saved host's `requireToolApproval` on a host-bound or
 * environment turn, the project default's on an ad-hoc one, and ON when
 * nothing is saved. The request can raise it and never lower it. It decides
 * whether the workspace reads that open a connection to a saved server pause
 * (writes always do, pure reads never do; see `mcpjam.ts`), and a workspace
 * tool that would pause is dropped outright on a deployment that cannot
 * verify approvals, so the turn is never handed a tool that cannot run.
 *
 * Nothing here is an authorization boundary on its own — every workspace
 * operation still runs through `/api/v1` with the caller's bearer and Convex
 * still checks it. What this closes is the request body deciding what the
 * MODEL is handed, which is what an injected instruction acts through.
 */
import { BROWSER_BUILT_IN_TOOL_ID } from "@/shared/client-fulfilled-tools";
import { BASH_TOOL_NAME } from "./bash.js";
import { WEB_SEARCH_TOOL_NAME } from "./exa-web-search.js";
import {
  isMcpjamToolId,
  isReadOnlyMcpjamToolId,
  isWorkspaceToolOfferable,
} from "./mcpjam.js";

export type BuiltInToolDropReason =
  | "unknown"
  | "not_configured"
  | "not_a_project_member_surface"
  | "no_project_access"
  | "read_only_role"
  | "access_unverified"
  | "approval_unverifiable";

/** The slice of `projects:getProjectCapabilities` this policy reads. */
export interface WorkspaceToolAccess {
  projectRole?: string | null;
}

/** The slice of the project's default host config this policy reads. */
export interface ProjectDefaultToolConfig {
  builtInToolIds?: unknown;
  requireToolApproval?: unknown;
}

/** Project roles that may run workspace WRITES. Mirrors Convex's `ProjectRole`. */
const EDITING_PROJECT_ROLES: ReadonlySet<string> = new Set(["admin", "editor"]);

/** Ids a Playground turn may add beyond its configuration. */
export const BUILT_IN_TOOL_BODY_OVERRIDES: readonly string[] = [
  BROWSER_BUILT_IN_TOOL_ID,
];

export function isKnownBuiltInToolId(id: string): boolean {
  return (
    id === WEB_SEARCH_TOOL_NAME ||
    id === BASH_TOOL_NAME ||
    id === BROWSER_BUILT_IN_TOOL_ID ||
    isMcpjamToolId(id)
  );
}

export interface BuiltInToolPolicyDecision {
  ids: string[] | undefined;
  dropped: Array<{ id: string; reason: BuiltInToolDropReason }>;
}

export interface TurnBuiltInToolDecision extends BuiltInToolPolicyDecision {
  /**
   * The workspace approval setting for this turn (MJ-008), resolved on the
   * server; see {@link resolveWorkspaceToolApproval}.
   */
  workspaceToolApproval: boolean;
}

/**
 * The workspace approval setting (MJ-008): the SAVED setting, on when nothing
 * is saved, raised — never lowered — by what the request asked for.
 */
export function resolveWorkspaceToolApproval(input: {
  saved: unknown;
  requested: boolean | undefined;
}): boolean {
  return input.requested === true || input.saved !== false;
}

/**
 * Pure decision over already-resolved inputs.
 *
 * `configured` undefined means no configuration bounds this turn. `access` is
 * the caller's project access: `null` for none, `"unavailable"` when it could
 * not be read, undefined when it was never looked up — and a workspace id with
 * unestablished access is dropped, not trusted.
 *
 * `workspaceToolApproval` is the turn's resolved workspace approval setting
 * (absent ⇒ on); a workspace id that would pause under it is dropped when
 * this deployment cannot verify approvals.
 */
export function applyBuiltInToolPolicy(input: {
  requested: readonly string[] | undefined;
  configured?: readonly string[];
  /** A guest or shared-scenario turn: workspace tools are never built there. */
  workspaceToolsBarred: boolean;
  access?: WorkspaceToolAccess | null | "unavailable";
  workspaceToolApproval?: boolean;
}): BuiltInToolPolicyDecision {
  if (input.requested === undefined) return { ids: undefined, dropped: [] };
  const ids: string[] = [];
  const dropped: BuiltInToolPolicyDecision["dropped"] = [];
  for (const id of new Set(input.requested)) {
    if (!isKnownBuiltInToolId(id)) {
      dropped.push({ id, reason: "unknown" });
      continue;
    }
    if (
      input.configured !== undefined &&
      !input.configured.includes(id) &&
      !BUILT_IN_TOOL_BODY_OVERRIDES.includes(id)
    ) {
      dropped.push({ id, reason: "not_configured" });
      continue;
    }
    if (isMcpjamToolId(id)) {
      if (input.workspaceToolsBarred) {
        dropped.push({ id, reason: "not_a_project_member_surface" });
        continue;
      }
      if (input.access === undefined || input.access === "unavailable") {
        dropped.push({ id, reason: "access_unverified" });
        continue;
      }
      if (input.access === null) {
        dropped.push({ id, reason: "no_project_access" });
        continue;
      }
      if (
        !EDITING_PROJECT_ROLES.has(input.access.projectRole ?? "") &&
        !isReadOnlyMcpjamToolId(id)
      ) {
        dropped.push({ id, reason: "read_only_role" });
        continue;
      }
      if (!isWorkspaceToolOfferable(id, input.workspaceToolApproval ?? true)) {
        dropped.push({ id, reason: "approval_unverifiable" });
        continue;
      }
    }
    ids.push(id);
  }
  return { ids, dropped };
}

/** A saved config's list: its string entries, or none when it has no list. */
function configuredIdsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];
}

/**
 * Resolve the inputs for {@link applyBuiltInToolPolicy} for one chat turn and
 * apply it, along with the turn's workspace approval setting. Lookups are
 * lazy: a turn that asks for nothing a lookup could change never makes one.
 */
export async function resolveTurnBuiltInToolIds(args: {
  requested: readonly string[] | undefined;
  configuration: ProjectDefaultToolConfig | null;
  configurationUnavailable?: boolean;
  workspaceToolsBarred: boolean;
  requestedToolApproval?: boolean;
  loadProjectAccess: () => Promise<WorkspaceToolAccess | null>;
}): Promise<TurnBuiltInToolDecision> {
  const { requested, workspaceToolsBarred } = args;
  const workspaceToolApproval = () =>
    resolveWorkspaceToolApproval({
      saved: args.configuration?.requireToolApproval,
      requested: args.requestedToolApproval,
    });
  const configured = args.configuration?.builtInToolIds === undefined
    ? undefined
    : configuredIdsOf(args.configuration.builtInToolIds);
  const configUnavailable = args.configurationUnavailable;
  const known = requested?.filter(isKnownBuiltInToolId) ?? [];
  const needsAccess =
    !workspaceToolsBarred &&
    !configUnavailable &&
    known.some(
      (id) =>
        isMcpjamToolId(id) &&
        (configured === undefined || configured.includes(id)),
    );
  let access: WorkspaceToolAccess | null | "unavailable" | undefined;
  if (configUnavailable) {
    access = "unavailable";
  } else if (needsAccess) {
    try {
      access = await args.loadProjectAccess();
    } catch {
      access = "unavailable";
    }
  }

  return {
    ...applyBuiltInToolPolicy({
      requested,
      ...(configured !== undefined ? { configured } : {}),
      workspaceToolsBarred,
      ...(access !== undefined ? { access } : {}),
      workspaceToolApproval: workspaceToolApproval(),
    }),
    workspaceToolApproval: workspaceToolApproval(),
  };
}
