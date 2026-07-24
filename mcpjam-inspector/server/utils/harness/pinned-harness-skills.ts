/**
 * Pinned-skill delivery for HARNESS turns (Project Environments — B3).
 *
 * An env-based swarm target's skills are snapshot-pinned artifacts fetched via
 * the journey skill route — the harness turn must consume EXACTLY those and
 * never the live Convex pool. This module adapts pinned artifacts onto the
 * existing harness skill machinery:
 *
 *   - {@link pinnedArtifactsToRuntimeSkills} maps artifacts to the
 *     `CloudSkillRuntimeItem` shape the adapter/`skillsFingerprint`/
 *     `reconcileSkillDirs`/`materializeSkillFrontmatter` already consume, so
 *     `skillsHash` derives from the pinned artifact fingerprints and preserved
 *     frontmatter re-materializes through the existing pass.
 *   - {@link materializePinnedSkillFiles} writes the artifacts' INLINE
 *     supporting files (P0.2 host-channel plugin skills). The live path's
 *     `materializeSkillFiles` downloads by URL; pinned envelopes carry file
 *     bodies inline instead, so this is a separate (much smaller) writer with
 *     the same path-validation discipline. Environment-channel skills are
 *     SKILL.md-only under P0.3, but this adapter must not assume the whole
 *     union has no files.
 */
import {
  isValidSkillName,
  type PinnedSkillArtifact,
} from "../../../shared/skill-types.js";
import { isPathWithinDirectory } from "../skill-parser.js";
import { shellQuote } from "./shell-quote.js";
import { logger } from "../logger.js";
import type {
  CloudSkillRuntimeItem,
  SkillExtraFrontmatterInput,
} from "../computers/convex-skills-client.js";

const SKILLS_BASE = "/home/user/.claude/skills";

/** Minimal structural view of the harness sandbox session (file plane). */
export interface PinnedSkillFileSession {
  writeTextFile(args: { path: string; content: string }): PromiseLike<unknown>;
  run(args: {
    command: string;
  }): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
}

/** Defensive projection of the artifact's preserved frontmatter onto the known
 * Agent-Skills envelope. Unknown keys are dropped (the backend re-validates on
 * pin; this only guards against a drifted wire shape). */
function toExtraFrontmatter(
  frontmatter: Record<string, unknown> | undefined
): SkillExtraFrontmatterInput | undefined {
  if (!frontmatter) return undefined;
  const out: SkillExtraFrontmatterInput = {};
  if (typeof frontmatter.license === "string")
    out.license = frontmatter.license;
  if (typeof frontmatter.compatibility === "string") {
    out.compatibility = frontmatter.compatibility;
  }
  const allowedTools =
    frontmatter["allowedTools"] ?? frontmatter["allowed-tools"];
  if (
    Array.isArray(allowedTools) &&
    allowedTools.every((t) => typeof t === "string")
  ) {
    out.allowedTools = allowedTools as string[];
  }
  const metadata = frontmatter.metadata;
  if (
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    Object.values(metadata).every((v) => typeof v === "string")
  ) {
    out.metadata = metadata as Record<string, string>;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Map pinned artifacts onto the runtime-skill shape the harness machinery
 * consumes. `aggregateHash` is the artifact's `contentHash` (the complete
 * pinned-envelope fingerprint), so `skillsFingerprint` over this list IS the
 * pinned-artifact fingerprint hash. `skillId` falls back to a content-derived
 * synthetic id when the pin lost its source skill pointer — it only needs to
 * be stable within the run for reconcile/fingerprint bookkeeping.
 */
export function pinnedArtifactsToRuntimeSkills(
  artifacts: PinnedSkillArtifact[]
): CloudSkillRuntimeItem[] {
  return artifacts.map((a) => ({
    skillId: a.skillId ?? `pinned:${a.contentHash}`,
    name: a.name,
    description: a.description,
    content: a.content,
    aggregateHash: a.contentHash,
    ...(toExtraFrontmatter(a.frontmatter)
      ? { extraFrontmatter: toExtraFrontmatter(a.frontmatter) }
      : {}),
  }));
}

/**
 * Remove supporting files ON BOX under a pinned skill's dir that aren't in that
 * artifact's file set (files dropped/renamed between snapshots, or a skill whose
 * file set became empty), so a REUSED sandbox reflects the target's exact
 * snapshot instead of retaining a prior run's files. Mirrors the live path's
 * `pruneStaleSkillFiles`: one global `find` (reaches dirs that received NO file
 * this turn), removal scoped to delivered dirs, SKILL.md never touched, fail-soft.
 * `keepByDir` maps a skill dir → the abs paths it should still hold (empty ⇒
 * prune all its supporting files).
 */
async function pruneStalePinnedSkillFiles(
  session: PinnedSkillFileSession,
  deliveredDirs: Set<string>,
  keepByDir: Map<string, Set<string>>,
  signal?: AbortSignal
): Promise<void> {
  if (deliveredDirs.size === 0) return;
  // Check abort BEFORE the sweep: the `find` is sandbox-wide, so an already
  // cancelled turn must not pay for it. Matches the per-file write loop below,
  // which checks `signal?.aborted` before each `session.run`.
  if (signal?.aborted) return;
  try {
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
      if (signal?.aborted) return;
      if (!p.startsWith(`${SKILLS_BASE}/`)) continue;
      const name = p.slice(SKILLS_BASE.length + 1).split("/")[0];
      const skillDir = `${SKILLS_BASE}/${name}`;
      if (!deliveredDirs.has(skillDir)) continue; // never a foreign skill
      if (p === `${skillDir}/SKILL.md`) continue; // belt-and-suspenders
      if (keepByDir.get(skillDir)?.has(p)) continue; // still current
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
 * Write the pinned artifacts' inline supporting files under each skill's own
 * dir (`~/.claude/skills/<name>/<path>`). Path-validated per file (defense in
 * depth over the backend's pin-time validation); binary files ride base64
 * through `base64 -d` (the b64 alphabet is single-quote safe). Best-effort per
 * file: a single bad file logs and is skipped — the pinned SKILL.md already
 * shipped via the adapter.
 *
 * FIRST prunes stale supporting files not present in each artifact's file set
 * ({@link pruneStalePinnedSkillFiles}) so a reused sandbox reflects the pinned
 * snapshot EXACTLY — the whole point of a pinned env run. The caller passes
 * EVERY pinned skill (not only those with files) so a skill whose file set
 * became empty still gets its orphans pruned.
 */
export async function materializePinnedSkillFiles(args: {
  session: PinnedSkillFileSession;
  artifacts: PinnedSkillArtifact[];
  signal?: AbortSignal;
}): Promise<void> {
  const { session, artifacts, signal } = args;

  // Prune before write: build delivered dirs + the files each should keep from
  // the authoritative pinned artifacts, then remove anything else on box.
  const deliveredDirs = new Set<string>();
  const keepByDir = new Map<string, Set<string>>();
  for (const artifact of artifacts) {
    if (!isValidSkillName(artifact.name)) continue;
    const skillDir = `${SKILLS_BASE}/${artifact.name}`;
    deliveredDirs.add(skillDir);
    const keep = new Set<string>();
    for (const file of artifact.files ?? []) {
      const target = `${skillDir}/${file.path}`;
      if (isPathWithinDirectory(skillDir, file.path)) keep.add(target);
    }
    keepByDir.set(skillDir, keep);
  }
  await pruneStalePinnedSkillFiles(session, deliveredDirs, keepByDir, signal);

  for (const artifact of artifacts) {
    const files = artifact.files;
    if (!files || files.length === 0) continue;
    if (!isValidSkillName(artifact.name)) {
      logger.warn(
        "[pinned-harness-skills] invalid skill name; skipping files",
        {
          name: artifact.name,
        }
      );
      continue;
    }
    const skillDir = `${SKILLS_BASE}/${artifact.name}`;
    for (const file of files) {
      if (signal?.aborted) return;
      if (!isPathWithinDirectory(skillDir, file.path)) {
        logger.warn(
          "[pinned-harness-skills] file path escapes its skill dir; skipping",
          { name: artifact.name, path: file.path }
        );
        continue;
      }
      const target = `${skillDir}/${file.path}`;
      const parent = target.slice(0, target.lastIndexOf("/"));
      try {
        await session.run({ command: `mkdir -p ${shellQuote(parent)}` });
        if (typeof file.content === "string") {
          await session.writeTextFile({ path: target, content: file.content });
        } else if (typeof file.base64 === "string") {
          await session.run({
            command: `printf '%s' ${shellQuote(
              file.base64
            )} | base64 -d > ${shellQuote(target)}`,
          });
        }
      } catch (err) {
        logger.warn("[pinned-harness-skills] file write failed; skipping", {
          name: artifact.name,
          path: file.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
