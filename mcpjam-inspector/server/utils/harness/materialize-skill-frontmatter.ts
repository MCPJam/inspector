/**
 * Materialization of a skill's PRESERVED EXTRA FRONTMATTER onto the Computer:
 * the box writer's SKILL.md step (`box-skills-writer.ts` is its only caller).
 *
 * The harness adapter writes SKILL.md from the `skills` param, but that param is
 * structurally `{name, description, content, files?}` — it can't carry the
 * preserved Agent-Skills-spec fields (`license` / `compatibility` /
 * `metadata`), so an adapter-written SKILL.md silently drops them. This pass
 * makes `<runtime skills root>/<name>/SKILL.md` of every delivered skill read
 * as the backend `generateSkillMd` writes it, held to the runtime's frontmatter
 * rules (its skills descriptor).
 *
 * `allowed-tools` is the one stored field never written. The Agent Skills spec
 * makes it a list of pre-approved tools, so a skill could approve its own calls
 * past MCPJam's approval host, and SEP-2640 has hosts ignore it on server
 * skills. The adapter leaves a skill whose hash is unchanged alone, so the
 * pass reads every delivered SKILL.md and rewrites each one that differs: a
 * reused box drops a line an earlier write, or anything on the box, left.
 *
 * Invariants:
 *  - Fail-soft: a write error skips that skill, never the turn, unless the
 *    SKILL.md left on the box may still grant tools: then the skill comes off
 *    the box, or the pass throws (see {@link clearGrantAfterFailedRewrite}).
 *  - A SKILL.md that already reads right is not written again.
 *  - Skill names are re-validated before path interpolation (defense-in-depth;
 *    cloud names are already backend-validated).
 *  - Does NOT touch `skillsFingerprint` — the skill's contentHash already folds
 *    extras in, so an extras edit forks the session and re-runs this pass.
 */
import { parse as parseYaml } from "yaml";
import { isValidSkillName } from "../../../shared/skill-types.js";
import type { SkillExtraFrontmatterInput } from "../computers/convex-skills-client.js";
import type { RuntimeSkill } from "./runtime-skills.js";
import type { HarnessSkillsDescriptor } from "./skills-descriptor.js";
import { shellQuote } from "./shell-quote.js";
import { logger } from "../logger.js";

/** Minimal live-session surface: the text write that replaces SKILL.md, and
 *  the read and command that check and remove a skill when that write fails. */
export interface FrontmatterSession {
  writeTextFile(args: { path: string; content: string }): PromiseLike<unknown>;
  readTextFile(args: { path: string }): PromiseLike<string | null>;
  run(args: {
    command: string;
  }): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Byte-mirror of the backend `generateSkillMd`'s `yamlDoubleQuoted`
 * (convex/lib/projectSkillValidation.ts), so this rewrite reproduces the
 * backend's exact bytes. It caps nothing: only the description has a limit
 * (`renderSkillMd`), which must not truncate `license` or `compatibility`.
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

type FrontmatterRules = HarnessSkillsDescriptor["frontmatter"];

/** A description as the adapter's `skills` param carries it: the adapter
 *  interpolates it raw after `description: `, so it arrives YAML-quoted, and
 *  in the encoding {@link renderSkillMd} uses so their SKILL.md texts agree. */
export function payloadDescription(
  description: string,
  rules: FrontmatterRules,
): string {
  return yamlDoubleQuoted(description.slice(0, rules.descriptionMaxLength));
}

/**
 * The SKILL.md a runtime gets for a skill: {@link generateSkillMdWithExtras}
 * with the description cut to the runtime's limit and `metadata.surfaces`
 * naming the runtime's surface when the skill lists any. Its frontmatter is
 * strict YAML for every runtime: double-quoted scalars and JSON-flow mappings.
 */
export function renderSkillMd(
  skill: Pick<
    RuntimeSkill,
    "name" | "description" | "content" | "extraFrontmatter"
  >,
  rules: FrontmatterRules,
): string {
  return generateSkillMdWithExtras({
    name: skill.name,
    description: skill.description.slice(0, rules.descriptionMaxLength),
    content: skill.content,
    extraFrontmatter: withSurface(skill.extraFrontmatter, rules.surface),
  });
}

function withSurface(
  extra: SkillExtraFrontmatterInput | undefined,
  surface: string | undefined,
): SkillExtraFrontmatterInput | undefined {
  const listed = extra?.metadata?.surfaces
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (
    !surface ||
    !extra?.metadata ||
    !listed?.length ||
    listed.includes(surface)
  ) {
    return extra;
  }
  return {
    ...extra,
    metadata: { ...extra.metadata, surfaces: [...listed, surface].join(",") },
  };
}

/** A SKILL.md's leading `---` frontmatter block; group 1 is its YAML. */
const FRONTMATTER_BLOCK =
  /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/**
 * Whether a SKILL.md may grant tools: its frontmatter, parsed as YAML, has a
 * top-level `allowed-tools` key in any spelling (`allowed_tools`,
 * `allowedTools`, any case). Fails closed: no frontmatter block, frontmatter
 * that doesn't parse, or frontmatter that isn't a mapping all count as a
 * grant. Parsed with `yaml` directly: gray-matter picks its parser from the
 * opening line, and this text comes from the box.
 */
export function hasAllowedToolsGrant(skillMd: string): boolean {
  const match = FRONTMATTER_BLOCK.exec(skillMd);
  if (!match) return true;
  let data: unknown;
  try {
    // Merge keys on, so a grant pulled in through `<<` is seen; warnings off,
    // since the text is the box's, while errors still throw.
    data = parseYaml(match[1] ?? "", { merge: true, logLevel: "error" });
  } catch {
    return true;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return true;
  }
  return Object.keys(data).some(
    (key) => key.replace(/[\s_-]/g, "").toLowerCase() === "allowedtools",
  );
}

/**
 * After a skill's rewrite fails, decide from the SKILL.md already on the box,
 * not from the stored extras. The adapter's hash covers only name,
 * description, body and files, so when only the extras change it leaves the
 * file an earlier write put on a reused box, and that file can list
 * `allowed-tools` the stored extras no longer have. A file with no grant stays.
 * One that may grant tools ({@link hasAllowedToolsGrant}) comes off the box,
 * so the turn runs without the skill, and this returns true.
 * Throws, which stops the turn before the model runs, when the file can't be
 * read or the folder can't be removed.
 */
async function clearGrantAfterFailedRewrite(
  session: FrontmatterSession,
  skillsBase: string,
  skillName: string,
): Promise<boolean> {
  let current: string | null;
  try {
    current = await session.readTextFile({
      path: `${skillsBase}/${skillName}/SKILL.md`,
    });
  } catch (error) {
    logger.warn("[materialize-skill-frontmatter] could not read skill", {
      skill: skillName,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `Could not update or read the skill "${skillName}" in the sandbox, so this turn stopped rather than risk running with the skill's old tool permissions. Try again.`,
    );
  }
  if (current === null || !hasAllowedToolsGrant(current)) return false;
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
  return true;
}

/** How many SKILL.md files the pass reads at once. */
const READ_BATCH = 8;

/**
 * Make the on-box SKILL.md of every delivered skill read as
 * {@link renderSkillMd} renders it, writing only the ones that differ. The
 * files are read up front, several at a time, to keep the turn's start quick.
 * Per-skill fail-soft (a write error logs and skips), except where the file
 * left on the box may still grant tools: that skill comes off the box and is
 * returned in `removed`, or the pass throws (see
 * {@link clearGrantAfterFailedRewrite}).
 */
export async function materializeSkillFrontmatter(args: {
  session: FrontmatterSession;
  skills: readonly RuntimeSkill[];
  /** The runtime's skills folder, absolute. */
  skillsBase: string;
  rules: FrontmatterRules;
  signal?: AbortSignal;
}): Promise<{
  rewritten: number;
  skipped: number;
  removed: Map<string, string>;
}> {
  const { skillsBase } = args;
  let rewritten = 0;
  let skipped = 0;
  const removed = new Map<string, string>();
  const read = async (skill: RuntimeSkill) => {
    if (!isValidSkillName(skill.name)) return null;
    try {
      return await args.session.readTextFile({
        path: `${skillsBase}/${skill.name}/SKILL.md`,
      });
    } catch (error) {
      logger.info("[materialize-skill-frontmatter] could not read; rewriting", {
        skill: skill.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };
  const onBox: Array<string | null> = [];
  for (let start = 0; start < args.skills.length; start += READ_BATCH) {
    onBox.push(
      ...(await Promise.all(
        args.skills.slice(start, start + READ_BATCH).map(read),
      )),
    );
  }
  for (const [index, skill] of args.skills.entries()) {
    if (args.signal?.aborted) break;
    // Never interpolate an unvalidated name into a box path.
    if (!isValidSkillName(skill.name)) {
      logger.info("[materialize-skill-frontmatter] skip: invalid skill name", {
        skill: skill.name,
      });
      skipped += 1;
      continue;
    }
    const content = renderSkillMd(skill, args.rules);
    if (onBox[index] === content) continue;
    try {
      await args.session.writeTextFile({
        path: `${skillsBase}/${skill.name}/SKILL.md`,
        content,
      });
      rewritten += 1;
    } catch (error) {
      logger.info("[materialize-skill-frontmatter] skip: write failed", {
        skill: skill.name,
        error: error instanceof Error ? error.message : String(error),
      });
      skipped += 1;
      if (
        await clearGrantAfterFailedRewrite(args.session, skillsBase, skill.name)
      ) {
        removed.set(
          skill.name,
          "SKILL.md could not be rewritten and may grant tools, so the skill was removed",
        );
      }
    }
  }
  if (rewritten > 0) {
    logger.info("[materialize-skill-frontmatter] rewrote SKILL.md", {
      rewritten,
    });
  }
  return { rewritten, skipped, removed };
}
