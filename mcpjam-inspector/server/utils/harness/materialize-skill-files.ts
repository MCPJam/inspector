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
 *  - Zero-cost fast path: returns immediately when no skill has files.
 *  - Fail-soft ALWAYS: a bad URL / write error skips that file, never the turn.
 *  - Every target path is RE-VALIDATED with `isPathWithinDirectory` against its
 *    skill dir (defense-in-depth over the backend's path validation).
 *  - A 20MB per-turn byte budget bounds the write; files beyond it are skipped
 *    with a logged reason (never silent).
 *  - `rm -rf` of a managed skill dir (in reconcile) already removes stale files,
 *    so no manifest change is needed.
 */
import { isPathWithinDirectory } from "../skill-parser.js";
import type { RuntimeSkillFile } from "./runtime-skills.js";
import { logger } from "../logger.js";

const SKILLS_BASE = "/home/user/.claude/skills";
/** Per-turn write budget across ALL skills (matches the backend per-skill cap). */
const MATERIALIZE_BUDGET_BYTES = 20 * 1024 * 1024;

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
 * Remove supporting files a skill dir has ON BOX that are no longer in Convex
 * (deleted/renamed), so the materialized dir doesn't diverge. Precise: lists the
 * dir's files and removes only those NOT in `keepAbsPaths` (never SKILL.md). Only
 * runs for dirs that receive files this turn — a skill whose files were ALL
 * removed isn't in the materialize set, so its residuals are cleaned by the next
 * whole-dir reconcile; that's an accepted tail. Fail-soft.
 */
async function pruneStaleSkillFiles(
  session: MaterializeSession,
  skillDir: string,
  keepAbsPaths: Set<string>,
): Promise<void> {
  try {
    // `find` prints one absolute path per line; -mindepth 1 excludes the dir.
    const ls = await session.run({
      command: `find ${skillDir} -mindepth 1 -type f`,
    });
    if (ls.exitCode !== 0) return;
    const onBox = ls.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const stale = onBox.filter(
      (p) => p !== `${skillDir}/SKILL.md` && !keepAbsPaths.has(p),
    );
    for (const p of stale) {
      // Paths are cloud-managed + validated (isPathWithinDirectory); no shell
      // metacharacters reach here (Convex paths are POSIX-relative).
      try {
        await session.run({ command: `rm -f -- ${p}` });
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
 * maps skillId → on-box dir name (from the already-fetched runtime skills); a file
 * whose skill isn't in the map is skipped (its dir wouldn't exist).
 */
export async function materializeSkillFiles(args: {
  session: MaterializeSession;
  files: RuntimeSkillFile[];
  skillNamesById: Map<string, string>;
  signal?: AbortSignal;
}): Promise<{ written: number; skipped: number }> {
  // Zero-cost fast path — the overwhelmingly common case (no supporting files).
  if (args.files.length === 0) return { written: 0, skipped: 0 };

  let written = 0;
  let skipped = 0;
  let budget = MATERIALIZE_BUDGET_BYTES;

  // Prune stale on-box files per skill dir BEFORE writing, so a file removed or
  // renamed in Convex doesn't linger. Precompute each dir's keep-set (the valid
  // target paths) once.
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
  for (const [skillDir, keep] of keepByDir) {
    if (args.signal?.aborted) break;
    await pruneStaleSkillFiles(args.session, skillDir, keep);
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
    logger.info("[materialize-skill-files] wrote supporting files", { written });
  }
  return { written, skipped };
}
