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
  if (typeof frontmatter.license === "string") out.license = frontmatter.license;
  if (typeof frontmatter.compatibility === "string") {
    out.compatibility = frontmatter.compatibility;
  }
  const allowedTools = frontmatter["allowedTools"] ?? frontmatter["allowed-tools"];
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
 * Write the pinned artifacts' inline supporting files under each skill's own
 * dir (`~/.claude/skills/<name>/<path>`). Path-validated per file (defense in
 * depth over the backend's pin-time validation); binary files ride base64
 * through `base64 -d` (the b64 alphabet is single-quote safe). Best-effort per
 * file: a single bad file logs and is skipped — the pinned SKILL.md already
 * shipped via the adapter — but this NEVER prunes anything (pruning stays the
 * live path's reconcile concern).
 */
export async function materializePinnedSkillFiles(args: {
  session: PinnedSkillFileSession;
  artifacts: PinnedSkillArtifact[];
  signal?: AbortSignal;
}): Promise<void> {
  const { session, artifacts, signal } = args;
  for (const artifact of artifacts) {
    const files = artifact.files;
    if (!files || files.length === 0) continue;
    if (!isValidSkillName(artifact.name)) {
      logger.warn("[pinned-harness-skills] invalid skill name; skipping files", {
        name: artifact.name,
      });
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
            command: `printf '%s' ${shellQuote(file.base64)} | base64 -d > ${shellQuote(target)}`,
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
