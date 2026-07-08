/**
 * Turn-end adoption of filesystem-installed skills on a Computer.
 *
 * A dev who installs a skill the ecosystem-standard way (`npx skills` into
 * `~/.claude/skills`) gets a dir that today works ONLY in harness runs, is
 * invisible to the Skills UI / chat, and is destroyed by computer reset. This
 * pass — run at the END of a successful harness turn, the only point with the
 * user bearer + projectId + a LIVE session — scans the box for such dirs, parses
 * each SKILL.md, and syncs them up into durable Convex storage (provenance
 * 'computer-adopted'). The reverse direction (cloud → box) already works via the
 * adapter + `reconcileSkillDirs`.
 *
 * Invariants:
 *  - NEVER touches a hand-placed dir on disk. It only READS the box and WRITES to
 *    Convex; only truly-adopted dirs are later marked managed (by the caller via
 *    `appendManagedSkills`).
 *  - Fail-soft ALWAYS: any error (missing base dir, unreadable file, backend
 *    down) logs and yields `{ adopted: [] }` — adoption never fails a turn.
 *  - Lenient where safe (per the integration guide): truncate an overlong
 *    description rather than reject, tolerate unknown frontmatter keys (preserved
 *    via extraFrontmatter), skip only truly-unusable dirs — and every skip logs a
 *    reason (diagnostics, not silent drops).
 *  - Content is read via `readTextFile` (sandbox files API, no 16k cap), NEVER
 *    shell `cat` (exec output is capped at 16k).
 */
import matter from "gray-matter";
import { isValidSkillName } from "../../../shared/skill-types.js";
import {
  convexAdoptComputerSkills,
  type AdoptSkillInput,
} from "../computers/convex-skills-client.js";
import { extractExtraFrontmatter } from "../skill-extra-frontmatter.js";
import { shellQuote } from "./shell-quote.js";
import { logger } from "../logger.js";

const SKILLS_BASE = "/home/user/.claude/skills";
const MANIFEST_BASENAME = ".mcpjam-skills.json";
/** Never scan an unbounded dir — a runaway box shouldn't stall the turn. */
const MAX_SCAN_DIRS = 50;
/** Match the backend batch cap; keeps a single turn's write bounded. */
const MAX_ADOPT_PER_TURN = 5;
const SKILL_CONTENT_MAX_BYTES = 128 * 1024;
const SKILL_DESCRIPTION_MAX_CHARS = 1024;
/**
 * Hard cap on the RAW SKILL.md we'll even parse — the 128KB body cap plus
 * headroom for frontmatter. Bounding before `matter()` means an oversized/bad
 * filesystem skill can't spend time+memory parsing before we reject it.
 */
const MAX_RAW_SKILL_MD_BYTES = SKILL_CONTENT_MAX_BYTES + 64 * 1024;

/**
 * Minimal live-session surface this pass needs (subset of the harness sandbox
 * session). Method syntax + `PromiseLike` mirrors `ReconcileSession` so the SDK
 * `Experimental_SandboxSession` is structurally assignable.
 */
export interface AdoptSession {
  readTextFile(args: { path: string }): PromiseLike<string | null>;
  run(args: {
    command: string;
  }): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
}

/** A skill dir that materialized into Convex, for the caller to mark managed. */
export interface AdoptedSkillEntry {
  skillId: string;
  name: string;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Whether a skill dir contains any file other than SKILL.md (fail-soft). */
async function dirHasSupportingFiles(
  session: AdoptSession,
  name: string
): Promise<boolean> {
  try {
    const res = await session.run({
      command: `find ${shellQuote(
        `${SKILLS_BASE}/${name}`
      )} -mindepth 1 -type f ! -name SKILL.md -print -quit`,
    });
    // A non-zero `find` exit means the scan errored (permission denied, dir
    // disappeared mid-scan, …) — we CAN'T be sure the dir is SKILL.md-only.
    // Adoption is SKILL.md-only by design, and managed reconciliation may
    // later delete un-adopted files, so treat an undetermined scan
    // conservatively as file-backed → return true so the candidate is
    // skipped rather than adopted stripped. (Mirrors the base-dir `ls`
    // `exitCode !== 0` guard below.)
    if (res.exitCode !== 0) return true;
    return res.stdout.trim().length > 0;
  } catch {
    // Can't tell → be conservative and treat as file-backed (skip adoption).
    return true;
  }
}

/**
 * Lenient parse of a SKILL.md for adoption. Returns the adopt input or `null`
 * (with a logged reason) when the dir is truly unusable. The dir name must equal
 * the frontmatter `name` — a mismatch is skipped (auto-suffixing would fork cloud
 * identity from the on-box dir name forever).
 */
function parseAdoptCandidate(
  raw: string,
  dirName: string
): AdoptSkillInput | null {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err) {
    logger.info("[adopt-sandbox-skills] skip: unparseable SKILL.md", {
      dir: dirName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const data = parsed.data as Record<string, unknown>;
  const name = typeof data.name === "string" ? data.name : undefined;
  if (!name || !isValidSkillName(name)) {
    logger.info(
      "[adopt-sandbox-skills] skip: missing/invalid frontmatter name",
      {
        dir: dirName,
        name,
      }
    );
    return null;
  }
  if (name !== dirName) {
    logger.info("[adopt-sandbox-skills] skip: dir name != frontmatter name", {
      dir: dirName,
      name,
    });
    return null;
  }
  let description =
    typeof data.description === "string" ? data.description.trim() : "";
  if (!description) {
    logger.info("[adopt-sandbox-skills] skip: missing description", {
      dir: dirName,
    });
    return null;
  }
  // Lenient: truncate rather than reject an overlong description.
  if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
    description = description.slice(0, SKILL_DESCRIPTION_MAX_CHARS);
  }
  const content = parsed.content.trim();
  if (!content) {
    logger.info("[adopt-sandbox-skills] skip: empty body", { dir: dirName });
    return null;
  }
  if (byteLength(content) > SKILL_CONTENT_MAX_BYTES) {
    logger.info("[adopt-sandbox-skills] skip: body exceeds size cap", {
      dir: dirName,
      bytes: byteLength(content),
    });
    return null;
  }
  const extraFrontmatter = extractExtraFrontmatter(data);
  return {
    name,
    description,
    content,
    ...(extraFrontmatter ? { extraFrontmatter } : {}),
  };
}

/**
 * Scan the box's `~/.claude/skills` for unmanaged skill dirs and adopt them into
 * Convex. `managedNames` are the names already delivered as cloud skills this
 * turn — those dirs are the adapter's own output, so they're skipped. Returns the
 * dirs that TRULY adopted (status 'adopted'), for the caller to mark managed.
 */
export async function adoptSandboxSkills(args: {
  session: AdoptSession;
  authHeader: string;
  projectId: string;
  managedNames: Set<string>;
  signal?: AbortSignal;
}): Promise<{ adopted: AdoptedSkillEntry[] }> {
  try {
    if (args.signal?.aborted) return { adopted: [] };
    // List entries (small output — bounded dir). `-1` one per line; dotfiles
    // (the manifest) are hidden without `-a`, but guard anyway.
    let ls: { exitCode: number; stdout: string; stderr: string } | null = null;
    try {
      ls = await args.session.run({ command: `ls -1 ${SKILLS_BASE}` });
    } catch {
      ls = null;
    }
    if (!ls || ls.exitCode !== 0) return { adopted: [] }; // base dir absent → nothing

    const names = ls.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_SCAN_DIRS);

    const candidates: AdoptSkillInput[] = [];
    for (const name of names) {
      if (candidates.length >= MAX_ADOPT_PER_TURN) break;
      if (name === MANIFEST_BASENAME) continue;
      if (!isValidSkillName(name)) {
        logger.info("[adopt-sandbox-skills] skip: invalid dir name", {
          dir: name,
        });
        continue;
      }
      // Already a cloud skill (the adapter wrote this dir) → not an adoption.
      if (args.managedNames.has(name)) continue;
      let raw: string | null = null;
      try {
        raw = await args.session.readTextFile({
          path: `${SKILLS_BASE}/${name}/SKILL.md`,
        });
      } catch {
        raw = null;
      }
      if (!raw) continue; // not a skill dir (no SKILL.md) — silent, not a skill
      // Bound the raw file BEFORE parsing so an oversized/bad SKILL.md can't
      // spend time+memory in gray-matter before we'd reject it anyway.
      if (byteLength(raw) > MAX_RAW_SKILL_MD_BYTES) {
        logger.info(
          "[adopt-sandbox-skills] skip: SKILL.md too large to parse",
          {
            dir: name,
            bytes: byteLength(raw),
          }
        );
        continue;
      }
      const candidate = parseAdoptCandidate(raw, name);
      if (!candidate) continue;
      // Adoption is SKILL.md-ONLY (adopting on-box files into org storage needs
      // its own threat review). A file-backed dir must NOT be adopted: the cloud
      // record would carry no file metadata to re-materialize after a reset, and
      // marking it managed would let a later cloud delete remove the dir WITH its
      // un-adopted files. Skip such dirs until package adoption is designed.
      if (await dirHasSupportingFiles(args.session, name)) {
        logger.info(
          "[adopt-sandbox-skills] skip: dir has supporting files (SKILL.md-only adoption)",
          { dir: name }
        );
        continue;
      }
      candidates.push(candidate);
    }

    if (candidates.length === 0) return { adopted: [] };
    if (args.signal?.aborted) return { adopted: [] };

    const { results } = await convexAdoptComputerSkills(
      args.authHeader,
      args.projectId,
      candidates
    );

    const adopted: AdoptedSkillEntry[] = [];
    for (const r of results) {
      if (r.status === "adopted" && r.skillId) {
        adopted.push({ skillId: r.skillId, name: r.name });
      } else if (r.status !== "adopted") {
        logger.info("[adopt-sandbox-skills] not adopted", {
          name: r.name,
          status: r.status,
          ...(r.message ? { reason: r.message } : {}),
        });
      }
    }
    if (adopted.length > 0) {
      logger.info("[adopt-sandbox-skills] adopted computer skills", {
        count: adopted.length,
      });
    }
    return { adopted };
  } catch (error) {
    logger.warn("[adopt-sandbox-skills] failed; skipping adoption this turn", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { adopted: [] };
  }
}
