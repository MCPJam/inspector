/**
 * Ownership pre-seed for the adapter's on-box skills write.
 *
 * Since the stable `@ai-sdk/harness` line, the ADAPTER re-writes its skills at
 * the start of EVERY prompt turn (each adapter's `doPromptTurn`: Claude Code,
 * Codex, OpenCode, ACP) through `writeSkills`, which tracks ownership in a
 * `.ai-sdk-harness-skills.json` manifest and REFUSES any pre-existing skill
 * dir that manifest does not list. That collides with the box writer's other
 * steps (`box-skills-writer.ts`), all of which run earlier (in
 * `onSandboxSession`) and create or rewrite exactly those dirs:
 *
 *   - `materializeSkillFiles` writes a skill's
 *     supporting files (signed-URL blobs the `skills` param cannot carry),
 *     creating the dir before the adapter ever writes it → the adapter's
 *     "already exists and is not owned" refusal fails the whole turn;
 *   - `materializeSkillFrontmatter` re-writes SKILL.md with preserved extra
 *     frontmatter, which an adapter write in the SAME turn would clobber;
 *   - boxes from before the stable line hold dirs MCPJam managed (delivered or
 *     adopted) that the adapter manifest has never seen, so a current project
 *     skill becomes permanently undeliverable there.
 *
 * The fix is to run the adapter's OWN write first, from `onSandboxSession`:
 * same payload, same options, same `@ai-sdk/harness` `writeSkills` ⇒ the same
 * per-skill content hash lands in the adapter manifest, so the adapter's
 * turn-time call sees every skill unchanged and touches nothing. Dirs are
 * adapter-owned before any MCPJam pass targets them, and what those passes add
 * survives because `writeSkills` never touches a hash-unchanged skill.
 *
 * VERSION LOCKSTEP: the no-op depends on this package's `@ai-sdk/harness`
 * hashing byte-identically to the copy each harness adapter resolves (one
 * deduped 1.0.158 copy today; no adapter nests its own). If they drift,
 * nothing breaks loudly, but the adapter re-writes every skill on every turn,
 * so MCPJam's supporting files and preserved frontmatter never reach the
 * runtime. `__tests__/preseed-adapter-skills.test.ts` asserts the no-op
 * against this package's copy; check for a nested copy on adapter bumps.
 */
import { writeSkills } from "@ai-sdk/harness/utils";
import { posix } from "node:path";
import { shellQuote } from "./shell-quote.js";
import type { HarnessSkillPayload } from "./box-skills-writer.js";
import { logger } from "../logger.js";

/** Minimal structural view of the harness sandbox session (dual-`ai` boundary:
 *  the live session object comes from an adapter's nested `@ai-sdk/harness`
 *  copy, nominally distinct from this package's — structurally identical). */
export interface PreseedSession {
  readTextFile(args: {
    path: string;
    abortSignal?: AbortSignal;
  }): PromiseLike<string | null>;
  writeTextFile(args: {
    path: string;
    content: string;
    abortSignal?: AbortSignal;
  }): PromiseLike<unknown>;
  run(args: {
    command: string;
    abortSignal?: AbortSignal;
  }): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
}

/** The adapter core's ownership manifest (`writeSkills` reads/writes it). */
const ADAPTER_MANIFEST_BASENAME = ".ai-sdk-harness-skills.json";
/** MCPJam's managed-dirs manifest (see `reconcile-skill-dirs.ts`). */
const MCPJAM_MANIFEST_BASENAME = ".mcpjam-skills.json";

function adapterManifestNames(parsed: unknown): string[] {
  const skills = (parsed as { skills?: Array<{ name?: unknown }> })?.skills;
  return (Array.isArray(skills) ? skills : [])
    .map((entry) => entry?.name)
    .filter((name): name is string => typeof name === "string");
}

async function readManifestNames(
  session: PreseedSession,
  path: string,
  extract: (parsed: unknown) => string[],
): Promise<Set<string> | null> {
  let raw: string | null;
  try {
    raw = await session.readTextFile({ path });
  } catch {
    return null; // unreadable ≠ empty: the caller must not treat this as "owns nothing"
  }
  if (!raw) return new Set();
  try {
    return new Set(extract(JSON.parse(raw)));
  } catch {
    return null;
  }
}

/**
 * Hand legacy MCPJam-managed skill dirs over to the adapter: remove any dir
 * that (a) is being delivered this turn, (b) MCPJam's manifest claims as
 * managed, and (c) the adapter's manifest does not own. The pre-seed that
 * follows re-writes it in the same breath, adapter-owned.
 *
 * Only MCPJam-managed dirs are eligible — a hand-placed dir that merely shares
 * a delivered skill's name is user data, and deleting it is not ours to do;
 * the pre-seed's own "not owned" refusal surfaces that collision instead.
 *
 * Best-effort: an unreadable manifest or a failed removal logs and returns —
 * the pre-seed's refusal is the loud backstop.
 */
export async function handOffLegacySkillDirs(args: {
  session: PreseedSession;
  skillsBase: string;
  deliveredNames: string[];
  signal?: AbortSignal;
}): Promise<{ removed: string[] }> {
  const { session, skillsBase } = args;
  const mcpjamManaged = await readManifestNames(
    session,
    `${skillsBase}/${MCPJAM_MANIFEST_BASENAME}`,
    (parsed) => {
      const skills = (parsed as { skills?: Record<string, { name?: unknown }> })
        ?.skills;
      return Object.values(skills ?? {})
        .map((entry) => entry?.name)
        .filter((name): name is string => typeof name === "string");
    },
  );
  if (mcpjamManaged === null || mcpjamManaged.size === 0) {
    return { removed: [] };
  }
  const adapterOwned = await readManifestNames(
    session,
    `${skillsBase}/${ADAPTER_MANIFEST_BASENAME}`,
    adapterManifestNames,
  );
  if (adapterOwned === null) return { removed: [] };

  const toRemove = args.deliveredNames.filter(
    (name) => mcpjamManaged.has(name) && !adapterOwned.has(name),
  );
  if (toRemove.length === 0) return { removed: [] };

  const command = `rm -rf -- ${toRemove
    .map((name) => shellQuote(`${skillsBase}/${name}`))
    .join(" ")}`;
  try {
    const result = await session.run({
      command,
      ...(args.signal ? { abortSignal: args.signal } : {}),
    });
    if (result.exitCode !== 0) {
      logger.warn("[preseed-adapter-skills] legacy hand-off rm failed", {
        skillsBase,
        exitCode: result.exitCode,
        stderr: result.stderr?.slice(0, 500),
      });
      return { removed: [] };
    }
  } catch (error) {
    logger.warn("[preseed-adapter-skills] legacy hand-off errored", {
      skillsBase,
      error: error instanceof Error ? error.message : String(error),
    });
    return { removed: [] };
  }
  logger.info("[preseed-adapter-skills] handed legacy dirs to adapter", {
    skillsBase,
    removed: toRemove,
  });
  return { removed: toRemove };
}

/**
 * Run the adapter's skills write ahead of it. Options MUST mirror the
 * adapter's own `writeSkills` invocation exactly (the per-adapter divergence —
 * Claude Code passes `trailingNewline: true`, Codex the default — travels on
 * the runtime's skills descriptor); the payload is the same object handed to
 * `HarnessAgent`'s `skills` param, so the projected content hash is identical
 * and the adapter's turn-time write is a no-op.
 *
 * Throws on a genuinely foreign colliding dir — the same "already exists and
 * is not owned" refusal the adapter itself would raise a moment later, just
 * before MCPJam's passes have touched anything.
 */
export async function preseedAdapterSkills(args: {
  session: PreseedSession;
  skillsBase: string;
  payload: readonly HarnessSkillPayload[];
  trailingNewline: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  await writeSkills({
    // Dual-`ai` boundary cast, same as the adapters in `registry.ts`.
    sandbox: args.session as unknown as Parameters<
      typeof writeSkills
    >[0]["sandbox"],
    // `writeSkills` takes the root as `homePath` + a relative `skillsDir` and
    // joins them back (`@ai-sdk/harness` >= 1.0.117). Splitting the absolute
    // base at its last segment lands on the exact same root, so the manifest
    // and every skill dir match what the adapter itself writes.
    homePath: posix.dirname(args.skillsBase),
    skillsDir: posix.basename(args.skillsBase),
    skills: args.payload,
    trailingNewline: args.trailingNewline,
    ...(args.signal ? { abortSignal: args.signal } : {}),
  });
}

/**
 * Take every folder the adapter manifest in `skillsBase` lists off the box,
 * through the adapter's own write, so the manifest stays true: a later write
 * of any of those skills puts it back rather than finding it "unchanged". A
 * folder whose manifest is missing, empty or unreadable is left exactly as it
 * is: the adapter that owns it refuses that manifest on its own turn.
 *
 * Best-effort: a failed removal logs and never fails the turn.
 */
export async function clearAdapterSkills(args: {
  session: PreseedSession;
  skillsBase: string;
  signal?: AbortSignal;
}): Promise<void> {
  const owned = await readManifestNames(
    args.session,
    `${args.skillsBase}/${ADAPTER_MANIFEST_BASENAME}`,
    adapterManifestNames,
  );
  if (!owned?.size) return;
  try {
    await preseedAdapterSkills({
      ...args,
      payload: [],
      trailingNewline: false,
    });
  } catch (error) {
    logger.warn("[preseed-adapter-skills] could not clear skills folder", {
      skillsBase: args.skillsBase,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
