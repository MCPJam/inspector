/**
 * Cleanup-only reconciliation of on-box skill directories.
 *
 * In the host-agnostic design the harness ADAPTER writes skills (Claude Code →
 * `~/.claude/skills/<name>/SKILL.md` at the real `$HOME`), but the adapter has no
 * deletion semantics and the E2B box is a long-lived, reconnected sandbox — so a
 * deleted/renamed skill would linger and stay discoverable (`skills: "all"`).
 * This pass removes only the dirs WE manage that are gone/renamed in Convex,
 * never touching a hand-placed dir, and records the current `skillsHash` so a
 * later transient-fetch-failure turn can keep the fingerprint stable.
 *
 * It does NOT write skill content (that's the adapter's job). Best-effort: any
 * failure logs and is swallowed so it never fails the harness turn.
 *
 * MUST run only on a successful skills fetch — a failed fetch must never drive
 * removal (callers pass the already-fetched set, never `[]`-on-failure).
 */
import { isValidSkillName } from "../../../shared/skill-types.js";
import { logger } from "../logger.js";

/** Minimal structural view of the harness sandbox session. */
export interface ReconcileSession {
  readTextFile(args: { path: string }): PromiseLike<string | null>;
  writeTextFile(args: { path: string; content: string }): PromiseLike<unknown>;
  run(args: { command: string }): PromiseLike<unknown>;
}

/** A skill as needed for reconciliation (subset of the runtime skill). */
export interface ReconcileSkill {
  skillId: string;
  name: string;
}

const SKILLS_BASE = "/home/user/.claude/skills";
const MANIFEST_PATH = `${SKILLS_BASE}/.mcpjam-skills.json`;
const MANIFEST_SCHEMA_VERSION = 1 as const;

interface ManagedSkillEntry {
  skillId: string;
  name: string;
}
interface ManagedSkillsManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  /** Last delivered skills fingerprint — reused on a fetch-failure turn. */
  skillsHash?: string;
  skills: Record<string, ManagedSkillEntry>; // keyed by skillId
}

export interface ReconcileResult {
  removed: number;
  managed: number;
}

function emptyManifest(): ManagedSkillsManifest {
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, skills: {} };
}

async function readManifest(
  session: ReconcileSession
): Promise<ManagedSkillsManifest> {
  try {
    const raw = await session.readTextFile({ path: MANIFEST_PATH });
    if (!raw) return emptyManifest();
    const parsed = JSON.parse(raw) as ManagedSkillsManifest;
    // Tolerate the older materializer manifest shape (entries carried an
    // `aggregateHash`; we ignore it now). Only require the skills map.
    if (parsed?.schemaVersion !== MANIFEST_SCHEMA_VERSION || !parsed.skills) {
      return emptyManifest();
    }
    return parsed;
  } catch {
    return emptyManifest();
  }
}

/** Remove a managed skill dir. `name` is validated, so the path is safe. */
async function removeManagedSkillDir(
  session: ReconcileSession,
  name: string
): Promise<void> {
  if (!isValidSkillName(name)) return; // never rm an unvalidated path
  // `--` guards option-like names (the validator forbids leading hyphens); the
  // charset is [a-z0-9-], so there are no shell metacharacters.
  await session.run({ command: `rm -rf -- ${SKILLS_BASE}/${name}` });
}

/**
 * Remove managed dirs whose skill is gone/renamed in Convex, then rewrite the
 * manifest to the current set + `skillsHash`. Order-independent vs. the adapter's
 * write (orphans are never in the current set).
 */
export async function reconcileSkillDirs(args: {
  session: ReconcileSession;
  skills: ReconcileSkill[];
  skillsHash: string;
  signal?: AbortSignal;
}): Promise<ReconcileResult> {
  const result: ReconcileResult = { removed: 0, managed: 0 };
  try {
    const manifest = await readManifest(args.session);
    const next = emptyManifest();
    next.skillsHash = args.skillsHash;
    const currentBySkillId = new Map<string, ReconcileSkill>();
    for (const s of args.skills) {
      if (!isValidSkillName(s.name)) continue;
      currentBySkillId.set(s.skillId, s);
      next.skills[s.skillId] = { skillId: s.skillId, name: s.name };
    }
    result.managed = currentBySkillId.size;

    // Renamed: drop the old managed dir (the adapter writes the new name).
    for (const [skillId, prev] of Object.entries(manifest.skills)) {
      const current = currentBySkillId.get(skillId);
      if (current && current.name !== prev.name) {
        await removeManagedSkillDir(args.session, prev.name).catch(() => {});
      }
    }
    // Orphans: managed skills gone from Convex → remove their dirs.
    for (const [skillId, prev] of Object.entries(manifest.skills)) {
      if (currentBySkillId.has(skillId)) continue;
      await removeManagedSkillDir(args.session, prev.name).catch(() => {});
      result.removed += 1;
    }

    await args.session.writeTextFile({
      path: MANIFEST_PATH,
      content: JSON.stringify(next),
    });
    return result;
  } catch (error) {
    logger.warn("[reconcile-skill-dirs] failed; continuing harness turn", {
      error: error instanceof Error ? error.message : String(error),
    });
    return result;
  }
}
