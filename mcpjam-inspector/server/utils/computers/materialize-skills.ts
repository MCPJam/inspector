/**
 * Materialize a project's durable skills (Convex source of truth) onto a
 * Computer's filesystem at `~/.claude/skills/<name>/SKILL.md`, so the in-sandbox
 * Claude Code harness discovers them natively.
 *
 * The Computer FS is a CACHE — wiped by delete/reset/reprovision — so this runs
 * each harness turn (in `run-harness-turn`'s `onSandboxSession`, after `.mcp.json`
 * is written) and reconciles via a manifest:
 *   - skip skills whose `aggregateHash` (+ name) already match on the box,
 *   - (re)write changed/new skills,
 *   - remove ONLY manifest-managed dirs that are gone/renamed in Convex (never
 *     touch a hand-placed, unmanaged skill dir).
 *
 * Best-effort: any failure logs and is swallowed so a materialize problem never
 * fails the harness turn.
 */
import { isValidSkillName } from "../../../shared/skill-types.js";
import { convexListSkillsForMaterialize } from "./convex-skills-client.js";
import { logger } from "../logger.js";

/**
 * Minimal structural view of the harness sandbox session — just the file +
 * exec primitives the materializer needs. Decouples this module from the exact
 * harness session type (network vs not), so it works with whatever
 * `onSandboxSession` hands us.
 */
export interface MaterializeSession {
  readTextFile(args: { path: string }): PromiseLike<string | null>;
  writeTextFile(args: { path: string; content: string }): PromiseLike<unknown>;
  run(args: { command: string }): PromiseLike<unknown>;
}

const SKILLS_BASE = "/home/user/.claude/skills";
const MANIFEST_PATH = `${SKILLS_BASE}/.mcpjam-skills.json`;
const MANIFEST_SCHEMA_VERSION = 1 as const;

interface ManagedSkillEntry {
  skillId: string;
  name: string;
  aggregateHash: string;
}
interface ManagedSkillsManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  skills: Record<string, ManagedSkillEntry>; // keyed by skillId
}

export interface MaterializeSkillsResult {
  written: number;
  removed: number;
  skipped: number;
}

function emptyManifest(): ManagedSkillsManifest {
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, skills: {} };
}

async function readManifest(
  session: MaterializeSession,
): Promise<ManagedSkillsManifest> {
  try {
    const raw = await session.readTextFile({ path: MANIFEST_PATH });
    if (!raw) return emptyManifest();
    const parsed = JSON.parse(raw) as ManagedSkillsManifest;
    if (parsed?.schemaVersion !== MANIFEST_SCHEMA_VERSION || !parsed.skills) {
      return emptyManifest();
    }
    return parsed;
  } catch {
    // Missing/corrupt manifest ⇒ treat as empty (we'll rewrite it).
    return emptyManifest();
  }
}

/** Remove a managed skill dir. `name` is validated, so the path is safe. */
async function removeManagedSkillDir(
  session: MaterializeSession,
  name: string,
): Promise<void> {
  if (!isValidSkillName(name)) return; // never rm an unvalidated path
  // `--` guards against option-like names (the validator already forbids
  // leading hyphens); name charset is [a-z0-9-], so no shell metacharacters.
  await session.run({ command: `rm -rf -- ${SKILLS_BASE}/${name}` });
}

export async function materializeSkills(args: {
  session: MaterializeSession;
  projectId: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<MaterializeSkillsResult> {
  const result: MaterializeSkillsResult = { written: 0, removed: 0, skipped: 0 };
  try {
    const skills = await convexListSkillsForMaterialize(
      args.bearer,
      args.projectId,
    );
    const manifest = await readManifest(args.session);
    const next: ManagedSkillsManifest = emptyManifest();
    const seenSkillIds = new Set<string>();

    for (const skill of skills) {
      if (!isValidSkillName(skill.name)) {
        // Defensive: backend validates names, but never write an unsafe path.
        logger.warn("[materialize-skills] skipping invalid skill name", {
          name: skill.name,
        });
        continue;
      }
      seenSkillIds.add(skill.skillId);
      const prev = manifest.skills[skill.skillId];

      // Renamed: drop the old managed dir before writing the new one.
      if (prev && prev.name !== skill.name) {
        await removeManagedSkillDir(args.session, prev.name).catch(() => {});
      }

      const unchanged =
        prev &&
        prev.name === skill.name &&
        prev.aggregateHash === skill.aggregateHash;
      if (!unchanged) {
        await args.session.writeTextFile({
          path: `${SKILLS_BASE}/${skill.name}/SKILL.md`,
          content: skill.skillMd,
        });
        result.written += 1;
      } else {
        result.skipped += 1;
      }
      next.skills[skill.skillId] = {
        skillId: skill.skillId,
        name: skill.name,
        aggregateHash: skill.aggregateHash,
      };
    }

    // Orphan cleanup: managed skills gone from Convex → remove their dirs.
    for (const [skillId, entry] of Object.entries(manifest.skills)) {
      if (seenSkillIds.has(skillId)) continue;
      await removeManagedSkillDir(args.session, entry.name).catch(() => {});
      result.removed += 1;
    }

    await args.session.writeTextFile({
      path: MANIFEST_PATH,
      content: JSON.stringify(next),
    });
    return result;
  } catch (error) {
    logger.warn("[materialize-skills] failed; continuing harness turn", {
      error: error instanceof Error ? error.message : String(error),
    });
    return result;
  }
}
