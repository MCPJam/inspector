/**
 * Skills served BY connected MCP servers (SEP-2640), client side.
 *
 * Deliberately separate from `mcp-skills-api.ts`: that module reads AGENT
 * skills (filesystem + Convex), and these are a different kind of thing with a
 * different identity system — a URI rather than a name, owned by a server
 * rather than by the project. The routes are separate for the same reason
 * (`/server-skills`, not `/skills`).
 *
 * Both modes share one shape. What differs is only which manager answers: the
 * long-lived local one, or a hosted ephemeral connection whose declared
 * capabilities come from the host config.
 */

import { authFetch } from "@/lib/session-token";
import { runByMode } from "@/lib/apis/mode-client";
import { webPost } from "@/lib/apis/web/base";

/** The connection's mutual-declaration state (SEP-2133 negotiation). */
export interface ServerSkillsSupport {
  /** The server declared the extension. */
  declared: boolean;
  /** THIS host advertised it. `false` ⇒ we send nothing, by design. */
  advertised: boolean;
  directoryRead: boolean;
  /** `declared && advertised`. The gate every call site checks. */
  active: boolean;
}

export interface ServerSkillSummary {
  serverId: string;
  /** IDENTITY. `name` is a label — two skills may legally share one. */
  skillUri: string;
  name: string;
  description: string;
  frontmatter: unknown;
  resources: Array<{ uri: string; digest: string; size?: number }>;
  /**
   * Present ⇒ discoverable but refused for loading.
   *
   * `dynamic_resources` is a server declaring `"resources": "dynamic"` — a
   * form the draft defines; `no_resources` is a server omitting the field the
   * draft requires. The UI renders `message` and never branches on `reason`,
   * so the distinction exists for the reader of a refusal, not for layout.
   */
  unloadable?: {
    reason: "no_resources" | "dynamic_resources";
    message: string;
  };
}

export interface ServerSkillListing {
  support: ServerSkillsSupport;
  serverId?: string;
  skills: ServerSkillSummary[];
  /** URIs the server listed twice — shown, never silently resolved. */
  duplicateUris: string[];
  rejected: Array<{ skillUri: string; reason: string }>;
  ttlMs?: number;
  cacheScope?: string;
}

/** Why a load was refused, with the specific violation preserved. */
export interface ServerSkillRefusal {
  kind: string;
  message: string;
  skillUri?: string;
  resourceUri?: string;
  expected?: string;
  actual?: string;
  field?: string;
}

export interface VerifiedServerSkill {
  serverId: string;
  skillUri: string;
  name: string;
  description: string;
  content: string;
  contentSha256: string;
  frontmatter: unknown;
  resources: Array<{ uri: string; digest: string; size?: number }>;
}

const EMPTY_SUPPORT: ServerSkillsSupport = {
  declared: false,
  advertised: false,
  directoryRead: false,
  active: false,
};

async function localPost<T>(path: string, body: unknown): Promise<T> {
  const response = await authFetch(`/api/mcp/server-skills${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // Parsed BEFORE the ok-check, and tolerantly: a gateway answering 502 with
  // HTML would otherwise throw a SyntaxError that replaces the status message
  // the caller is meant to see — and `ServerSkillsSection` renders that message
  // straight into the panel.
  const json = (await response.json().catch(() => null)) as
    | (T & { success?: boolean; error?: string })
    | null;
  if (!response.ok) {
    throw new Error(json?.error ?? `Request failed (${response.status})`);
  }
  if (!json) {
    throw new Error("The server returned a response that was not JSON.");
  }
  return json;
}

/**
 * Lists one server's skills.
 *
 * An INACTIVE connection returns an empty list with `support.active: false` —
 * never an error. "This host does not declare the extension" and "this server
 * has no skills" are different facts, and the UI renders them differently.
 */
export async function listServerSkills(args: {
  serverId: string;
  projectId?: string;
}): Promise<ServerSkillListing> {
  const empty: ServerSkillListing = {
    support: EMPTY_SUPPORT,
    skills: [],
    duplicateUris: [],
    rejected: [],
  };
  return runByMode({
    local: async () => {
      const result = await localPost<ServerSkillListing>("/list", {
        serverId: args.serverId,
      });
      return { ...empty, ...result };
    },
    hosted: async () => {
      if (!args.projectId) return empty;
      const result = await webPost<
        { serverId: string; projectId: string },
        ServerSkillListing
      >("/api/web/server-skills/list", {
        serverId: args.serverId,
        projectId: args.projectId,
      });
      return { ...empty, ...result };
    },
  });
}

/**
 * Loads one skill by URI, verified.
 *
 * Works for skills the listing never mentioned — that is what `skills/get` is
 * for, and what backs the "Load by URI" affordance.
 *
 * Returns a REFUSAL rather than throwing when the server's content fails a
 * mandatory check: the specific violation (which digest, which field, which
 * URI) is the thing worth showing.
 */
export async function getServerSkill(args: {
  serverId: string;
  uri: string;
  projectId?: string;
}): Promise<
  | { ok: true; skill: VerifiedServerSkill }
  | { ok: false; refusal: ServerSkillRefusal }
> {
  const unwrap = (result: {
    skill?: VerifiedServerSkill;
    refusal?: ServerSkillRefusal;
  }) =>
    result.skill
      ? ({ ok: true, skill: result.skill } as const)
      : ({
          ok: false,
          refusal: result.refusal ?? {
            kind: "fetch_failed",
            message: "The server returned no skill and no reason.",
          },
        } as const);

  return runByMode({
    local: async () =>
      unwrap(
        await localPost<{
          skill?: VerifiedServerSkill;
          refusal?: ServerSkillRefusal;
        }>("/get", { serverId: args.serverId, uri: args.uri })
      ),
    hosted: async () =>
      unwrap(
        await webPost<
          { serverId: string; uri: string; projectId?: string },
          { skill?: VerifiedServerSkill; refusal?: ServerSkillRefusal }
        >("/api/web/server-skills/get", {
          serverId: args.serverId,
          uri: args.uri,
          ...(args.projectId ? { projectId: args.projectId } : {}),
        })
      ),
  });
}

/** Reads one supporting file. A URI outside the skill's manifest is refused. */
export async function readServerSkillFile(args: {
  serverId: string;
  skillUri: string;
  resourceUri: string;
  projectId?: string;
}): Promise<
  | { ok: true; file: { uri: string; text: string; digest: string } }
  | { ok: false; refusal: ServerSkillRefusal }
> {
  const unwrap = (result: {
    file?: { uri: string; text: string; digest: string };
    refusal?: ServerSkillRefusal;
  }) =>
    result.file
      ? ({ ok: true, file: result.file } as const)
      : ({
          ok: false,
          refusal: result.refusal ?? {
            kind: "fetch_failed",
            message: "The server returned no file and no reason.",
          },
        } as const);

  return runByMode({
    local: async () =>
      unwrap(
        await localPost<{
          file?: { uri: string; text: string; digest: string };
          refusal?: ServerSkillRefusal;
        }>("/read-file", {
          serverId: args.serverId,
          skillUri: args.skillUri,
          resourceUri: args.resourceUri,
        })
      ),
    hosted: async () =>
      unwrap(
        await webPost<
          {
            serverId: string;
            skillUri: string;
            resourceUri: string;
            projectId?: string;
          },
          {
            file?: { uri: string; text: string; digest: string };
            refusal?: ServerSkillRefusal;
          }
        >("/api/web/server-skills/read-file", {
          serverId: args.serverId,
          skillUri: args.skillUri,
          resourceUri: args.resourceUri,
          ...(args.projectId ? { projectId: args.projectId } : {}),
        })
      ),
  });
}
