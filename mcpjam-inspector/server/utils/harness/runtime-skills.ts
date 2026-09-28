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
 *   - `frontmatterSafeSkills` — shim for adapters that interpolate
 *     `description: ${value}` RAW into SKILL.md frontmatter (Claude Code's
 *     `claude-code-harness.ts` and Codex's `codex-harness.ts` both do): it
 *     pre-encodes the description as a YAML double-quoted scalar. YAML safety
 *     lives here, NOT in the generic conversion, so an adapter that composes
 *     frontmatter structurally still gets clean text.
 *   - `prepareClaudeCodeSkills` / `prepareCodexSkills` — the per-adapter
 *     `HarnessRuntimeAdapter.prepareSkills` implementations: the `skills` param
 *     payload AND which skills that actually amounts to, so the caller's own
 *     passes (supporting files, frontmatter, dir reconcile) address exactly the
 *     dirs the adapter will write.
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
import {
  isValidSkillName,
  type PinnableSkill,
} from "../../../shared/skill-types.js";
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
 * Payload for adapters that interpolate `description: ${value}` RAW into SKILL.md
 * frontmatter (Claude Code and Codex both do): the description is pre-encoded as
 * a YAML double-quoted scalar so the written file stays valid frontmatter. An
 * adapter that composes frontmatter structurally must NOT use this.
 */
export function frontmatterSafeSkills(
  skills: RuntimeSkill[],
): HarnessSkillPayload[] {
  return skills.map((s) => ({
    name: s.name,
    description: toYamlDoubleQuoted(s.description),
    content: s.content,
  }));
}

/**
 * What an adapter will actually deliver this turn. `delivered` is the subset of
 * the runtime skills handed to the adapter (so the caller's supporting-file /
 * frontmatter passes only touch dirs that will exist), and `skipped` records why
 * anything was dropped — a drop is logged, never silent.
 */
export interface PreparedHarnessSkills {
  payload: HarnessSkillPayload[];
  delivered: RuntimeSkill[];
  skipped: Array<{ name: string; reason: string }>;
}

/** Claude Code: every runtime skill is delivered, descriptions YAML-encoded. */
export function prepareClaudeCodeSkills(
  skills: RuntimeSkill[],
): PreparedHarnessSkills {
  return {
    payload: frontmatterSafeSkills(skills),
    delivered: skills,
    skipped: [],
  };
}

/**
 * Codex: the same YAML pre-encoding, plus a name FILTER.
 *
 * `codex-harness.ts` validates every skill name (`safeCodexSkillName`) and
 * THROWS on a reject — inside `doStart`, so one unusable name would fail the
 * whole TURN rather than that one skill. MCPJam's own `isValidSkillName`
 * (Agent-Skills spec: `[a-z0-9-]`, no leading/trailing/double hyphen, ≤64) is a
 * strict SUBSET of what Codex accepts (`[A-Za-z0-9._-]+`, not `.`/`..`), so a
 * name that passes here always passes there — asserted against the REAL adapter
 * in `__tests__/codex-skill-parity.test.ts` rather than assumed. A name that
 * fails the shared validator has no valid on-box dir under any runtime anyway
 * (every other pass validates it the same way), so it is dropped with a reason.
 */
export function prepareCodexSkills(
  skills: RuntimeSkill[],
): PreparedHarnessSkills {
  const delivered: RuntimeSkill[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const skill of skills) {
    if (!isValidSkillName(skill.name)) {
      skipped.push({ name: skill.name, reason: "invalid-skill-name" });
      continue;
    }
    delivered.push(skill);
  }
  if (skipped.length > 0) {
    logger.info("[runtime-skills] codex: skipped undeliverable skills", {
      skipped,
    });
  }
  return { payload: frontmatterSafeSkills(delivered), delivered, skipped };
}

/**
 * A harness that delivers no skills at all (`supportsSkills: false`).
 *
 * `runHarnessTurn` never calls `prepareSkills` for such an adapter, so this is
 * reached only if that guard is ever removed. It reports the honest answer —
 * nothing delivered, nothing skipped — rather than a payload that would claim a
 * delivery the runtime does not perform. Every skill is listed as skipped so a
 * caller inspecting the result can say WHY the skills it fetched are missing
 * from the box instead of finding an empty structure with no explanation.
 */
export function prepareNoSkills(skills: RuntimeSkill[]): PreparedHarnessSkills {
  return {
    payload: [],
    delivered: [],
    skipped: skills.map((skill) => ({
      name: skill.name,
      reason: "harness-does-not-deliver-skills",
    })),
  };
}
