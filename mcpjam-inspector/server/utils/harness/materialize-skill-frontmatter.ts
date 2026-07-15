/**
 * Materialization of a skill's PRESERVED EXTRA FRONTMATTER onto the Computer.
 *
 * The harness adapter writes SKILL.md from the `skills` param, but that param is
 * structurally `{name, description, content, files?}` — it can't carry the
 * preserved Agent-Skills-spec fields (`license` / `compatibility` /
 * `allowed-tools` / `metadata`), so an adapter-written SKILL.md silently drops
 * them (an imported marketplace skill would lose its `allowed-tools` semantics
 * on the box). This pass rewrites `~/.claude/skills/<name>/SKILL.md` for every
 * delivered skill that HAS extras, with the full SKILL.md whose frontmatter
 * byte-mirrors the backend's `generateSkillMd` (the same bytes the Computer-FS
 * materializer and the adoption round-trip see).
 *
 * MUST run AFTER the harness session is created: the adapter writes SKILL.md in
 * `doStart` (after `onSandboxSession`), and it only writes on a FRESH start —
 * exactly the turns a skill change forces (fingerprint fork). A rewrite inside
 * `onSandboxSession` would therefore be clobbered on the turns that matter.
 *
 * Invariants:
 *  - Fail-soft ALWAYS: a write error skips that skill, never the turn.
 *  - Zero session calls when no delivered skill carries extras.
 *  - Skill names are re-validated before path interpolation (defense-in-depth;
 *    cloud names are already backend-validated).
 *  - Does NOT touch `skillsFingerprint` — the skill's contentHash already folds
 *    extras in, so an extras edit forks the session and re-runs this pass.
 */
import { isValidSkillName } from "../../../shared/skill-types.js";
import type { SkillExtraFrontmatterInput } from "../computers/convex-skills-client.js";
import type { RuntimeSkill } from "./runtime-skills.js";
import { logger } from "../logger.js";

const SKILLS_BASE = "/home/user/.claude/skills";

/** Minimal live-session surface: the text write that replaces SKILL.md. */
export interface FrontmatterSession {
  writeTextFile(args: { path: string; content: string }): PromiseLike<unknown>;
}

/**
 * Byte-mirror of the backend `generateSkillMd`'s `yamlDoubleQuoted`
 * (convex/lib/projectSkillValidation.ts). Deliberately NOT `toYamlDoubleQuoted`
 * from runtime-skills.ts: that one caps at 1024 chars (a description-only rule
 * that must not truncate `license`/`compatibility`) and escapes `\r` as `\\r`
 * where the backend strips it — this rewrite must reproduce the backend's
 * exact bytes.
 */
function yamlDoubleQuoted(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/**
 * Generate the full SKILL.md, byte-identical to the backend `generateSkillMd`:
 * `name` unquoted (validated charset), `description` and string extras as YAML
 * double-quoted scalars, `allowed-tools`/`metadata` as JSON (a subset of YAML
 * flow syntax), fields in the backend's stable order.
 */
export function generateSkillMdWithExtras(args: {
  name: string;
  description: string;
  content: string;
  extraFrontmatter?: SkillExtraFrontmatterInput;
}): string {
  const description = yamlDoubleQuoted(args.description);
  let frontmatter = `name: ${args.name}\ndescription: ${description}`;
  const extra = args.extraFrontmatter;
  if (extra) {
    if (extra.license !== undefined) {
      frontmatter += `\nlicense: ${yamlDoubleQuoted(extra.license)}`;
    }
    if (extra.compatibility !== undefined) {
      frontmatter += `\ncompatibility: ${yamlDoubleQuoted(extra.compatibility)}`;
    }
    if (extra.allowedTools !== undefined) {
      frontmatter += `\nallowed-tools: ${JSON.stringify(extra.allowedTools)}`;
    }
    if (extra.metadata !== undefined) {
      frontmatter += `\nmetadata: ${JSON.stringify(extra.metadata)}`;
    }
  }
  return `---\n${frontmatter}\n---\n\n${args.content}\n`;
}

/** Whether a runtime skill carries any preserved extra frontmatter. */
function hasExtras(
  extra: SkillExtraFrontmatterInput | undefined
): extra is SkillExtraFrontmatterInput {
  return !!extra && Object.keys(extra).length > 0;
}

/**
 * Overwrite the on-box SKILL.md of every delivered skill that carries extra
 * frontmatter. Per-skill fail-soft (a write error logs and skips); makes no
 * session call at all when no skill has extras.
 */
export async function materializeSkillFrontmatter(args: {
  session: FrontmatterSession;
  skills: RuntimeSkill[];
  signal?: AbortSignal;
}): Promise<{ rewritten: number; skipped: number }> {
  let rewritten = 0;
  let skipped = 0;
  for (const skill of args.skills) {
    if (args.signal?.aborted) break;
    if (!hasExtras(skill.extraFrontmatter)) continue;
    // Never interpolate an unvalidated name into a box path.
    if (!isValidSkillName(skill.name)) {
      logger.info("[materialize-skill-frontmatter] skip: invalid skill name", {
        skill: skill.name,
      });
      skipped += 1;
      continue;
    }
    try {
      await args.session.writeTextFile({
        path: `${SKILLS_BASE}/${skill.name}/SKILL.md`,
        content: generateSkillMdWithExtras({
          name: skill.name,
          description: skill.description,
          content: skill.content,
          extraFrontmatter: skill.extraFrontmatter,
        }),
      });
      rewritten += 1;
    } catch (error) {
      logger.info("[materialize-skill-frontmatter] skip: write failed", {
        skill: skill.name,
        error: error instanceof Error ? error.message : String(error),
      });
      skipped += 1;
    }
  }
  if (rewritten > 0) {
    logger.info("[materialize-skill-frontmatter] rewrote SKILL.md with extras", {
      rewritten,
    });
  }
  return { rewritten, skipped };
}
