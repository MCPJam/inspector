/**
 * The one writer of a harness turn's skills to its box, for live, environment
 * and pinned turns alike. `planBoxSkills` picks what the box gets and builds
 * the adapter's `skills` param; `writeBoxSkills` puts it on the box before the
 * runtime starts. Both read one thing about the runtime: its skills
 * descriptor (`skills-descriptor.ts`).
 *
 * A box outlives a turn and may run another runtime next, and runtimes read
 * each other's folders: OpenCode reads Claude Code's and writes Codex's. So
 * the writer also clears MCPJam's skill folders from every other folder the
 * runtime reads: the runtime finds exactly what this turn delivered, plus
 * anything placed there by hand.
 */
import { logger } from "../logger.js";
import {
  payloadDescription,
  materializeSkillFrontmatter,
  type FrontmatterSession,
} from "./materialize-skill-frontmatter.js";
import {
  materializeSkillFiles,
  type BoxSkillFile,
  type MaterializeSession,
} from "./materialize-skill-files.js";
import {
  clearAdapterSkills,
  handOffLegacySkillDirs,
  preseedAdapterSkills,
  type PreseedSession,
} from "./preseed-adapter-skills.js";
import {
  reconcileSkillDirs,
  type ReconcileSession,
} from "./reconcile-skill-dirs.js";
import { skillsFingerprint, type RuntimeSkill } from "./runtime-skills.js";
import {
  foldersToClear,
  type HarnessSkillsDescriptor,
} from "./skills-descriptor.js";

/** Structural shape of the harness `skills` param entry (`HarnessV1Skill`). */
export interface HarnessSkillPayload {
  name: string;
  description: string;
  content: string;
}

/** Why a skill stays off the box this turn: the runtime can't take its name,
 *  or an earlier skill of the turn holds its folder. Neither is a failure. */
export type BoxSkillSkipReason = "invalid-skill-name" | "name-collision";

export interface BoxSkillsPlan {
  /** What the box gets, in the turn's order. */
  deliver: RuntimeSkill[];
  skipped: Array<{ skill: RuntimeSkill; reason: BoxSkillSkipReason }>;
  /** The adapter's `skills` param, one entry per delivered skill. */
  payload: HarnessSkillPayload[];
}

/**
 * Which of a turn's skills go on the box. A name the runtime rejects, or a
 * second skill with a taken name (`writeSkills` throws on a duplicate), would
 * fail the whole turn, so both stay off. The first in the turn's order keeps
 * a folder: pins in pin order, an environment's own picks before its plugins'
 * skills, a hidden environment's skills before the project's pool.
 */
export function planBoxSkills(
  descriptor: HarnessSkillsDescriptor,
  skills: readonly RuntimeSkill[],
): BoxSkillsPlan {
  const deliver: RuntimeSkill[] = [];
  const skipped: BoxSkillsPlan["skipped"] = [];
  const folders = new Set<string>();
  for (const skill of skills) {
    const reason = !descriptor.acceptsName(skill.name)
      ? "invalid-skill-name"
      : folders.has(skill.name)
        ? "name-collision"
        : null;
    if (reason) {
      skipped.push({ skill, reason });
      continue;
    }
    folders.add(skill.name);
    deliver.push(skill);
  }
  return {
    deliver,
    skipped,
    payload: deliver.map((skill) => ({
      name: skill.name,
      description: payloadDescription(
        skill.description,
        descriptor.frontmatter,
      ),
      content: skill.content,
    })),
  };
}

/** The folder a runtime's adapter writes skills to, on a box with this home. */
export function boxSkillsFolder(
  descriptor: HarnessSkillsDescriptor,
  home: string,
): string {
  return `${home}/${descriptor.writeFolder}`;
}

/** A skill the writer reports on, by its id and the folder it holds. */
export interface BoxSkillOutcome {
  skillId: string;
  name: string;
}

/** What one turn's write put on the box. `notDelivered` is counted apart
 *  from `failed`: a skill the runtime can't take is not a failed delivery. */
export interface BoxSkillsResult {
  delivered: BoxSkillOutcome[];
  notDelivered: Array<BoxSkillOutcome & { reason: BoxSkillSkipReason }>;
  /** On the box but not whole (a supporting file is missing), or taken off
   *  because its SKILL.md couldn't be rewritten and may grant tools. */
  failed: Array<BoxSkillOutcome & { error: string }>;
}

/** The delivered skills' supporting files. A skill whose whole list `files`
 *  doesn't hold (`complete` false) keeps the files it has on the box: its list
 *  could not be read this turn, and an empty stand-in would prune them. */
export interface BoxSkillFiles {
  files: readonly BoxSkillFile[];
  complete(skillId: string): boolean;
}

export type BoxSkillsSession = ReconcileSession &
  PreseedSession &
  MaterializeSession &
  FrontmatterSession;

const outcome = (skill: RuntimeSkill): BoxSkillOutcome => ({
  skillId: skill.skillId,
  name: skill.name,
});

const skippedOutcomes = (plan: BoxSkillsPlan) =>
  plan.skipped.map(({ skill, reason }) => ({ ...outcome(skill), reason }));

/** A write that threw: the runtime never starts on it, so none of the
 *  planned skills arrived. */
export function failedBoxSkills(
  plan: BoxSkillsPlan,
  error: unknown,
): BoxSkillsResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    delivered: [],
    notDelivered: skippedOutcomes(plan),
    failed: plan.deliver.map((skill) => ({
      ...outcome(skill),
      error: message,
    })),
  };
}

/**
 * Put a planned turn's skills on the box. Runs before the runtime starts, on
 * every turn, resumed ones included. Throws only where the turn must not run:
 * the adapter's own write fails (it would fail the same way when the runtime
 * starts), or a SKILL.md that may grant tools can't be rewritten, read or
 * removed.
 */
export async function writeBoxSkills(args: {
  session: BoxSkillsSession;
  descriptor: HarnessSkillsDescriptor;
  /** The box's home; the descriptor's folders are relative to it. */
  home: string;
  plan: BoxSkillsPlan;
  /** Read once, and only when the box gets a skill. */
  readFiles(): Promise<BoxSkillFiles>;
  /** The computer row whose upload quota downloads count against. */
  computerId?: string;
  signal?: AbortSignal;
}): Promise<BoxSkillsResult> {
  const { session, descriptor, plan, signal } = args;
  const result: BoxSkillsResult = {
    delivered: [],
    notDelivered: skippedOutcomes(plan),
    failed: [],
  };
  if (plan.skipped.length > 0) {
    // Ids and reasons only: a skill name is user-authored content.
    logger.info("[box-skills-writer] skills left off the box", {
      skipped: plan.skipped.map(({ skill, reason }) => ({
        skillId: skill.skillId,
        reason,
      })),
    });
  }
  for (const folder of foldersToClear(descriptor)) {
    await clearSkillsFolder(session, `${args.home}/${folder}`, signal);
  }
  const skillsBase = boxSkillsFolder(descriptor, args.home);
  if (plan.deliver.length === 0) {
    await clearSkillsFolder(session, skillsBase, signal);
    return result;
  }
  if (signal?.aborted) return result;

  await reconcileSkillDirs({
    session,
    skills: plan.deliver,
    skillsHash: skillsFingerprint(plan.deliver),
    skillsBase,
  });
  await handOffLegacySkillDirs({
    session,
    skillsBase,
    deliveredNames: plan.deliver.map((skill) => skill.name),
    ...(signal ? { signal } : {}),
  });
  await preseedAdapterSkills({
    session,
    skillsBase,
    payload: plan.payload,
    trailingNewline: descriptor.trailingNewline,
    ...(signal ? { signal } : {}),
  });
  const { removed } = await materializeSkillFrontmatter({
    session,
    skills: plan.deliver,
    skillsBase,
    rules: descriptor.frontmatter,
    ...(signal ? { signal } : {}),
  });
  const listing = await args.readFiles();
  const { failed } = await materializeSkillFiles({
    session,
    files: listing.files,
    skillNamesById: new Map(
      plan.deliver
        .filter(
          (skill) =>
            !removed.has(skill.name) && listing.complete(skill.skillId),
        )
        .map((skill) => [skill.skillId, skill.name]),
    ),
    skillsBase,
    ...(args.computerId ? { computerId: args.computerId } : {}),
    ...(signal ? { signal } : {}),
  });
  for (const skill of plan.deliver) {
    const error = removed.get(skill.name) ?? failed.get(skill.name);
    if (error) result.failed.push({ ...outcome(skill), error });
    else result.delivered.push(outcome(skill));
  }
  return result;
}

/** Take every skill folder MCPJam's record or the adapter's manifest lists in
 *  `skillsBase` off the box. A folder MCPJam never wrote to is left as is. */
async function clearSkillsFolder(
  session: BoxSkillsSession,
  skillsBase: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  await reconcileSkillDirs({ session, skills: [], skillsHash: "", skillsBase });
  await clearAdapterSkills({
    session,
    skillsBase,
    ...(signal ? { signal } : {}),
  });
}
