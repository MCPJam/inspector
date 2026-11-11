/**
 * Materialization of a skill's PRESERVED EXTRA FRONTMATTER onto the Computer.
 *
 * The harness adapter writes SKILL.md from the `skills` param, but that param is
 * structurally `{name, description, content, files?}` — it can't carry the
 * preserved Agent-Skills-spec fields (`license` / `compatibility` /
 * `metadata`), so an adapter-written SKILL.md silently drops them. This pass
 * rewrites `<runtime skills root>/<name>/SKILL.md` (the adapter's own root —
 * `HarnessRuntimeAdapter.skillsBaseDir`) for every delivered skill that HAS
 * extras, with frontmatter in the backend `generateSkillMd`'s format.
 *
 * `allowed-tools` is the one stored field never written. The Agent Skills spec
 * makes it a list of pre-approved tools, so a skill could approve its own calls
 * past MCPJam's approval host, and SEP-2640 has hosts ignore it on server
 * skills. A skill whose only extra is `allowedTools` is still rewritten, so a
 * reused box drops a line an earlier write left there.
 *
 * MUST run AFTER the harness session is created: the adapter writes SKILL.md in
 * `doStart` (after `onSandboxSession`), and it only writes on a FRESH start —
 * exactly the turns a skill change forces (fingerprint fork). A rewrite inside
 * `onSandboxSession` would therefore be clobbered on the turns that matter.
 *
 * Invariants:
 *  - Fail-soft: a write error skips that skill, never the turn. The one
 *    exception fails closed: a skill that carries `allowedTools` is taken off
 *    the box when its rewrite fails, and the pass throws if it can't be (see
 *    {@link removeSkillAfterFailedRewrite}).
 *  - Zero session calls when no delivered skill carries extras.
 *  - Skill names are re-validated before path interpolation (defense-in-depth;
 *    cloud names are already backend-validated).
 *  - Does NOT touch `skillsFingerprint` — the skill's contentHash already folds
 *    extras in, so an extras edit forks the session and re-runs this pass.
 */
import { isValidSkillName } from "../../../shared/skill-types.js";
import type { SkillExtraFrontmatterInput } from "../computers/convex-skills-client.js";
import type { RuntimeSkill } from "./runtime-skills.js";
import { CLAUDE_CODE_SKILLS_BASE } from "./skill-roots.js";
import { shellQuote } from "./shell-quote.js";
import { logger } from "../logger.js";

/** Minimal live-session surface: the text write that replaces SKILL.md, and
 *  the command that removes a skill folder when that write fails. */
export interface FrontmatterSession {
  writeTextFile(args: { path: string; content: string }): PromiseLike<unknown>;
  run(args: {
    command: string;
  }): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
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
 * Generate the full SKILL.md, byte-identical to the backend `generateSkillMd`
 * minus `allowed-tools` (see the header): `name` unquoted (validated charset),
 * `description` and string extras as YAML double-quoted scalars, `metadata` as
 * JSON (a subset of YAML flow syntax), fields in the backend's stable order.
 * Only these named fields are emitted, so an unknown key a drifted wire adds to
 * `extraFrontmatter` never reaches the box.
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
 * Take a skill off the box after its rewrite failed while it carries
 * `allowedTools`. On a box reused across turns its SKILL.md can still list the
 * grant from an earlier write, and the adapter won't rewrite a skill whose hash
 * is unchanged, so the turn runs without the skill rather than with the grant.
 * Throws when the folder can't be removed, so the turn stops before the model
 * runs.
 */
async function removeSkillAfterFailedRewrite(
  session: FrontmatterSession,
  skillsBase: string,
  skillName: string,
): Promise<void> {
  let failure: string | undefined;
  try {
    const result = await session.run({
      command: `rm -rf -- ${shellQuote(`${skillsBase}/${skillName}`)}`,
    });
    if (result.exitCode !== 0) {
      failure = result.stderr.slice(0, 500) || `exit code ${result.exitCode}`;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (failure !== undefined) {
    logger.warn("[materialize-skill-frontmatter] could not remove skill", {
      skill: skillName,
      error: failure,
    });
    throw new Error(
      `Could not update or remove the skill "${skillName}" in the sandbox, so this turn stopped rather than run with the skill's old tool permissions. Try again.`,
    );
  }
  logger.warn("[materialize-skill-frontmatter] removed skill: write failed", {
    skill: skillName,
  });
}

/**
 * Overwrite the on-box SKILL.md of every delivered skill that carries extra
 * frontmatter. Per-skill fail-soft (a write error logs and skips), except for a
 * skill that carries `allowedTools` (see {@link removeSkillAfterFailedRewrite});
 * makes no session call at all when no skill has extras.
 */
export async function materializeSkillFrontmatter(args: {
  session: FrontmatterSession;
  skills: RuntimeSkill[];
  /** The RUNTIME's skills root (`HarnessRuntimeAdapter.skillsBaseDir`). Defaults
   *  to Claude Code's for legacy callers. */
  skillsBase?: string;
  signal?: AbortSignal;
}): Promise<{ rewritten: number; skipped: number }> {
  const skillsBase = args.skillsBase ?? CLAUDE_CODE_SKILLS_BASE;
  let rewritten = 0;
  let skipped = 0;
  for (const skill of args.skills) {
    if (args.signal?.aborted) break;
    // The stored extras decide, `allowedTools` included: that is what makes
    // a skill whose only extra is `allowedTools` get rewritten without it.
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
        path: `${skillsBase}/${skill.name}/SKILL.md`,
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
      if (skill.extraFrontmatter?.allowedTools !== undefined) {
        await removeSkillAfterFailedRewrite(
          args.session,
          skillsBase,
          skill.name,
        );
      }
    }
  }
  if (rewritten > 0) {
    logger.info("[materialize-skill-frontmatter] rewrote SKILL.md with extras", {
      rewritten,
    });
  }
  return { rewritten, skipped };
}
