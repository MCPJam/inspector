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
 *   - `toHarnessSkills` — adapter-agnostic payload with SEMANTIC descriptions.
 *   - `claudeCodeSafeSkills` — Claude-Code-only shim that pre-encodes the
 *     description as a YAML double-quoted scalar, because that adapter interpolates
 *     `description: ${value}` raw (`claude-code-harness.ts`). YAML safety lives
 *     here, NOT in the generic conversion, so other adapters get clean text.
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

/** Structural shape of the harness `skills` param entry (`HarnessV1Skill`). */
export interface HarnessSkillPayload {
  name: string;
  description: string;
  content: string;
}

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
    return { ok: true, skills };
  } catch (error) {
    logger.warn("[runtime-skills] fetch failed; preserving prior skill state", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false };
  }
}

export type RuntimeSkillFile = CloudSkillRuntimeFile;

/**
 * Fetch every visible skill's supporting files (with download URLs) for harness
 * materialization. Returns `[]` on ANY failure (fail-soft — a fetch blip must
 * never wipe or block; the SKILL.md itself is delivered separately). Scoped vs
 * member query mirrors {@link fetchRuntimeSkills}.
 */
export async function fetchRuntimeSkillFiles(
  bearer: string,
  projectId: string,
  executionScope?: ExecutionScope,
): Promise<RuntimeSkillFile[]> {
  try {
    return executionScope
      ? await convexListSkillFilesForRuntimeExecution(bearer, executionScope)
      : await convexListSkillFilesForRuntime(bearer, projectId);
  } catch (error) {
    logger.warn("[runtime-skills] file fetch failed; skipping materialization", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Deterministic fingerprint over the identity + content hash of every skill,
 * order-independent (sorted by skillId). Changes on add / remove / rename / edit.
 * Empty list ⇒ stable sentinel (distinct from "no skills dimension").
 */
export function skillsFingerprint(skills: RuntimeSkill[]): string {
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

/** Adapter-agnostic payload — semantic, unmodified descriptions. */
export function toHarnessSkills(skills: RuntimeSkill[]): HarnessSkillPayload[] {
  return skills.map((s) => ({
    name: s.name,
    description: s.description,
    content: s.content,
  }));
}

const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * Encode a description as a YAML double-quoted scalar (the value AFTER
 * `description: `). Lossless and frontmatter-safe even when the adapter does not
 * quote: `Process: PDFs "safely"` → `"Process: PDFs \"safely\""`. Mirrors the
 * backend's `generateSkillMd` escaping so Claude Code parses back the original.
 */
export function toYamlDoubleQuoted(value: string): string {
  const escaped = value
    .slice(0, MAX_DESCRIPTION_LENGTH)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/**
 * Claude-Code-only payload: the description is pre-encoded as a YAML
 * double-quoted scalar so the adapter's raw `description: ${value}` interpolation
 * stays valid frontmatter. Other adapters must NOT use this.
 */
export function claudeCodeSafeSkills(
  skills: RuntimeSkill[],
): HarnessSkillPayload[] {
  return skills.map((s) => ({
    name: s.name,
    description: toYamlDoubleQuoted(s.description),
    content: s.content,
  }));
}
