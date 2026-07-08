/**
 * Harness materialization of a skill's SUPPORTING FILES onto the Computer.
 *
 * The harness adapter writes SKILL.md itself (via the `skills` param), but it has
 * no concept of supporting files (`scripts/`, `references/`, `assets/`). This
 * pass — run in `onSandboxSession` right AFTER `reconcileSkillDirs` — fetches
 * each visible skill's file blobs from Convex and writes them onto the box under
 * `~/.claude/skills/<name>/<path>` via `writeBinaryFile` (no 16k exec cap).
 *
 * Invariants:
 *  - Fail-soft ALWAYS: a bad URL / write error skips that file, never the turn.
 *  - Every target path is RE-VALIDATED with `isPathWithinDirectory` against its
 *    skill dir (defense-in-depth over the backend's path validation).
 *  - A 20MB per-turn byte budget bounds the write; files beyond it are skipped
 *    with a logged reason (never silent).
 *  - Stale-file prune covers EVERY delivered skill dir — including a skill whose
 *    file set became empty (reconcile only removes deleted/renamed dirs, so an
 *    existing skill's orphaned files would otherwise linger). One global `find`
 *    scopes the sweep to delivered dirs; the caller must NOT invoke this on a
 *    fetch failure (an empty file set would then delete every skill's files).
 */
import { isPathWithinDirectory } from "../skill-parser.js";
import type { RuntimeSkillFile } from "./runtime-skills.js";
import { logger } from "../logger.js";

const SKILLS_BASE = "/home/user/.claude/skills";
/** Per-turn write budget across ALL skills (matches the backend per-skill cap). */
const MATERIALIZE_BUDGET_BYTES = 20 * 1024 * 1024;

/**
 * POSIX single-quote a shell argument (defense-in-depth). Paths reaching `run`
 * are cloud-managed + `isPathWithinDirectory`-validated, but path containment
 * does NOT neutralize spaces / `;` / `$()`, so we still quote before interpolating
 * into `find`/`rm` — a managed filename must never be able to break out of its arg.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Minimal live-session surface: binary write + exec (for stale-file prune). */
export interface MaterializeSession {
  writeBinaryFile(args: {
    path: string;
    content: Uint8Array;
  }): PromiseLike<unknown>;
  run(args: {
    command: string;
  }): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Remove supporting files ON BOX that are no longer in Convex (deleted/renamed,
 * or a skill whose file set became empty), so a delivered dir doesn't diverge.
 *
 * ONE global `find` over the skills base lists every supporting file across all
 * skills — cheaper than a `find` per dir, and (crucially) it also reaches skills
 * that received NO file this turn, which a per-dir sweep keyed on the write set
 * would miss. Removal is scoped to `deliveredDirs` so an unmanaged / hand-placed
 * skill's files are never touched; SKILL.md is never removed. `keepByDir` maps a
 * skill dir → the abs paths it should still hold (empty ⇒ prune all its files).
 * Fail-soft.
 */
async function pruneStaleSkillFiles(
  session: MaterializeSession,
  deliveredDirs: Set<string>,
  keepByDir: Map<string, Set<string>>
): Promise<void> {
  if (deliveredDirs.size === 0) return;
  try {
    // One sweep: every file under a skill dir, excluding each dir's SKILL.md.
    const ls = await session.run({
      command: `find ${shellQuote(
        SKILLS_BASE
      )} -mindepth 2 -type f ! -name SKILL.md`,
    });
    if (ls.exitCode !== 0) return;
    const onBox = ls.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of onBox) {
      if (!p.startsWith(`${SKILLS_BASE}/`)) continue;
      const rel = p.slice(SKILLS_BASE.length + 1);
      const name = rel.split("/")[0];
      const skillDir = `${SKILLS_BASE}/${name}`;
      // Only prune dirs we delivered this turn — never a foreign/hand-placed skill.
      if (!deliveredDirs.has(skillDir)) continue;
      if (p === `${skillDir}/SKILL.md`) continue; // belt-and-suspenders
      if (keepByDir.get(skillDir)?.has(p)) continue; // still current
      // Paths are cloud-managed + validated, but quote anyway (defense-in-depth)
      // so a space / metacharacter can't break out of the argument.
      try {
        await session.run({ command: `rm -f -- ${shellQuote(p)}` });
      } catch {
        // best-effort per-file removal
      }
    }
  } catch {
    // Best-effort — a prune failure never blocks materialization.
  }
}

/**
 * Write every runtime skill file onto the box under its skill dir. `skillNamesById`
 * maps skillId → on-box dir name for ALL skills delivered this turn (not only
 * those with files); a file whose skill isn't in the map is skipped (its dir
 * wouldn't exist). The prune sweep uses every delivered dir so a skill whose file
 * set became empty still has its orphaned files removed. The CALLER must only
 * invoke this after a SUCCESSFUL file fetch — an empty `files` from a failed
 * fetch would otherwise prune every delivered skill's files.
 */
export async function materializeSkillFiles(args: {
  session: MaterializeSession;
  files: RuntimeSkillFile[];
  skillNamesById: Map<string, string>;
  signal?: AbortSignal;
}): Promise<{ written: number; skipped: number }> {
  let written = 0;
  let skipped = 0;
  let budget = MATERIALIZE_BUDGET_BYTES;

  // Every delivered skill dir is a prune candidate (even with zero files this
  // turn). Build the keep-set (valid target paths) per dir from the file list;
  // a delivered dir absent from `keepByDir` prunes all its supporting files.
  const deliveredDirs = new Set<string>();
  for (const name of args.skillNamesById.values()) {
    deliveredDirs.add(`${SKILLS_BASE}/${name}`);
  }
  const keepByDir = new Map<string, Set<string>>();
  for (const file of args.files) {
    const skillName = args.skillNamesById.get(file.skillId);
    if (!skillName) continue;
    const skillDir = `${SKILLS_BASE}/${skillName}`;
    if (!isPathWithinDirectory(skillDir, file.path)) continue;
    let keep = keepByDir.get(skillDir);
    if (!keep) {
      keep = new Set<string>();
      keepByDir.set(skillDir, keep);
    }
    keep.add(`${skillDir}/${file.path}`);
  }
  if (!args.signal?.aborted) {
    await pruneStaleSkillFiles(args.session, deliveredDirs, keepByDir);
  }

  for (const file of args.files) {
    if (args.signal?.aborted) break;
    const skillName = args.skillNamesById.get(file.skillId);
    if (!skillName) {
      skipped += 1;
      continue; // dir wouldn't exist (skill not delivered this turn)
    }
    const skillDir = `${SKILLS_BASE}/${skillName}`;
    // Defense-in-depth: the target must stay within the skill dir.
    if (!isPathWithinDirectory(skillDir, file.path)) {
      logger.info("[materialize-skill-files] skip: path escapes skill dir", {
        skill: skillName,
        path: file.path,
      });
      skipped += 1;
      continue;
    }
    if (!file.url) {
      skipped += 1;
      continue;
    }
    // Cheap early skip on declared size; the authoritative check is on the
    // actual downloaded bytes below (declared size is not trusted).
    if (file.size > budget) {
      logger.info("[materialize-skill-files] skip: over per-turn budget", {
        skill: skillName,
        path: file.path,
      });
      skipped += 1;
      continue;
    }
    try {
      const res = await fetch(file.url, {
        ...(args.signal ? { signal: args.signal } : {}),
      });
      if (!res.ok) {
        skipped += 1;
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      // Enforce the budget against ACTUAL bytes (declared file.size may understate).
      if (bytes.byteLength > budget) {
        logger.info("[materialize-skill-files] skip: actual size over budget", {
          skill: skillName,
          path: file.path,
        });
        skipped += 1;
        continue;
      }
      budget -= bytes.byteLength;
      await args.session.writeBinaryFile({
        path: `${skillDir}/${file.path}`,
        content: bytes,
      });
      written += 1;
    } catch (error) {
      logger.info("[materialize-skill-files] skip: write failed", {
        skill: skillName,
        path: file.path,
        error: error instanceof Error ? error.message : String(error),
      });
      skipped += 1;
    }
  }
  if (written > 0) {
    logger.info("[materialize-skill-files] wrote supporting files", {
      written,
    });
  }
  return { written, skipped };
}
