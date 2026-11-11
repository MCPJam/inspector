/**
 * Runtime skill delivery for the harness path — the single module that owns the
 * "skills as a runtime concern" mechanics, decoupled from any one adapter.
 *
 * One Convex source of truth (`projectSkills`), delivered to the in-sandbox agent
 * via the harness `skills` param (the adapter writes them natively — Claude Code →
 * `~/.claude/skills`, Codex → a protocol param). This module provides:
 *
 *   - `fetchRuntimeSkills` — TRI-STATE fetch. A transient Convex failure is
 *     `{ ok: false }`, never an empty list, so callers can distinguish "no skills"
 *     from "couldn't load" and avoid wiping the box or churning the session.
 *   - `skillsFingerprint` — deterministic hash folded into the harness runtime
 *     fingerprint so a skill add/edit/delete invalidates a resumable session
 *     (the adapter only (re)writes skills on a fresh start).
 *
 * The box writer (`box-skills-writer.ts`) shapes and writes them per runtime.
 */
import {
  convexListSkillsForRuntime,
  convexListSkillsForRuntimeExecution,
  convexListSkillFilesForRuntime,
  convexListSkillFilesForRuntimeExecution,
  normalizeProvenance,
  type CloudSkillRuntimeItem,
  type CloudSkillRuntimeFile,
} from "../computers/convex-skills-client.js";
import type { PinnableSkill } from "../../../shared/skill-types.js";
import type { ExecutionScope } from "../execution-scope.js";
import { logger } from "../logger.js";

export type RuntimeSkill = CloudSkillRuntimeItem;

export type FetchRuntimeSkillsResult =
  | { ok: true; skills: RuntimeSkill[] }
  | { ok: false };

/**
 * Fetch the project's runtime skills. Tri-state: `{ ok: false }` on ANY failure
 * (never throws, never returns `[]` to mean "failed"). Callers MUST treat
 * `{ ok: false }` as "leave skills state untouched" — see `run-harness-turn`.
 *
 * When an `executionScope` is supplied (guest / swarm grant), the scoped query
 * is used so the backend re-resolves live access and returns shared-only skills;
 * otherwise the legacy member `projectId` query runs unchanged.
 */
export async function fetchRuntimeSkills(
  bearer: string,
  projectId: string,
  executionScope?: ExecutionScope,
): Promise<FetchRuntimeSkillsResult> {
  try {
    const skills = executionScope
      ? await convexListSkillsForRuntimeExecution(bearer, executionScope)
      : await convexListSkillsForRuntime(bearer, projectId);
    // An answer that is not a list says nothing about the skills.
    if (!Array.isArray(skills)) {
      throw new Error("Runtime skills are not a list");
    }
    return { ok: true, skills };
  } catch (error) {
    logger.warn("[runtime-skills] fetch failed; preserving prior skill state", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false };
  }
}

export type RuntimeSkillFile = CloudSkillRuntimeFile;

export type FetchRuntimeSkillFilesResult =
  | { ok: true; files: RuntimeSkillFile[] }
  | { ok: false };

/**
 * Fetch every visible skill's supporting files (with download URLs) for harness
 * materialization. Tri-state: `{ ok: false }` on ANY failure (never throws,
 * never returns `[]` to mean "failed"). This distinction is LOAD-BEARING —
 * `materializeSkillFiles` prunes on-box files absent from the returned set, so a
 * failure surfaced as an empty array would delete every delivered skill's files.
 * The caller MUST skip materialization on `{ ok: false }`. Scoped vs member
 * query mirrors {@link fetchRuntimeSkills}.
 */
export async function fetchRuntimeSkillFiles(
  bearer: string,
  projectId: string,
  executionScope?: ExecutionScope,
): Promise<FetchRuntimeSkillFilesResult> {
  try {
    const files = executionScope
      ? await convexListSkillFilesForRuntimeExecution(bearer, executionScope)
      : await convexListSkillFilesForRuntime(bearer, projectId);
    if (!Array.isArray(files)) {
      throw new Error("Runtime skill files are not a list");
    }
    return { ok: true, files };
  } catch (error) {
    logger.warn(
      "[runtime-skills] file fetch failed; skipping materialization",
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return { ok: false };
  }
}

/**
 * Deterministic fingerprint over the identity + content hash of every skill,
 * order-independent (sorted by skillId). Changes on add / remove / rename / edit.
 * Empty list ⇒ stable sentinel (distinct from "no skills dimension").
 */
export function skillsFingerprint(skills: readonly RuntimeSkill[]): string {
  // Empty list ⇒ "" so it equals an omitted hash (a no-skills project and a
  // transient fetch failure both leave the runtime fingerprint unchanged).
  if (skills.length === 0) return "";
  const canon = skills
    .map((s) => `${s.skillId}:${s.name}:${s.aggregateHash}`)
    .sort()
    .join("\n");
  // FNV-1a, matching `harnessRuntimeFingerprint`'s hashing for consistency.
  let h = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) {
    h ^= canon.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Map a runtime skill to the shared {@link PinnableSkill} contract — the shape
 * both the eval snapshot factory and a future `mcp-server` catalog adapter
 * consume. `contentHash` is the runtime item's `aggregateHash` (the drift key
 * that already folds in supporting files); provenance is normalized off the
 * wire-tolerant DTO field.
 */
export function toPinnableSkill(s: CloudSkillRuntimeItem): PinnableSkill {
  return {
    name: s.name,
    description: s.description,
    content: s.content,
    contentHash: s.aggregateHash,
    provenance: normalizeProvenance(s.provenance),
  };
}
