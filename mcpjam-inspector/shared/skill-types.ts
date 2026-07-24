// Skill types - shared between client and server

/**
 * Skill name validation constants
 */
export const SKILL_NAME_MIN_LENGTH = 1;
export const SKILL_NAME_MAX_LENGTH = 64;

/**
 * Validates skill name format per Agent Skills spec:
 * - Lowercase letters, numbers, hyphens only
 * - Must not start or end with hyphen
 * - Must not contain consecutive hyphens
 * - 1-64 characters
 */
export function isValidSkillName(name: string): boolean {
  if (
    name.length < SKILL_NAME_MIN_LENGTH ||
    name.length > SKILL_NAME_MAX_LENGTH
  )
    return false;
  if (name.includes("--")) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$|^[a-z0-9]$/.test(name);
}

/**
 * Frontmatter structure from SKILL.md files
 */
export interface SkillFrontmatter {
  name: string; // Required: lowercase letters, numbers, hyphens
  description: string; // Required
}

/**
 * How a durable (cloud) skill record came to exist — distinct from
 * {@link SkillListItem.origin}, which is storage locus (local FS vs cloud).
 * - `authored`         — created via the Skills UI / API (the legacy default).
 * - `computer-adopted` — synced up from a filesystem-installed skill on a
 *                        Computer (`~/.claude/skills`) during a harness turn.
 *
 * The wire may carry values a shipped inspector doesn't know yet (e.g. a future
 * `mcp-server`), so transport DTOs type provenance as a plain `string` and
 * normalize through {@link normalizeProvenance}; this union is the normalized set.
 */
export type SkillProvenance = "authored" | "computer-adopted";

/**
 * The minimal shape both live runtime skills and eval snapshots share, and that
 * a future `mcp-server` catalog adapter can also produce. Deliberately flat:
 * `contentHash` is the drift/identity key (an aggregate hash once supporting
 * files exist), `provenance` is optional so producers without it (e.g. an eval
 * pin) can omit it.
 */
export interface PinnableSkill {
  name: string;
  description: string;
  content: string;
  contentHash: string;
  provenance?: SkillProvenance;
}

/**
 * One supporting file inside a pinned skill's runtime artifact (P0.2). EXACTLY
 * one of `content` (text) / `base64` (binary) is set — encoded as a union so an
 * impossible both-or-neither file can't be constructed. `path` is RELATIVE to
 * the skill's own directory and must be re-validated before any write.
 */
export type PinnedSkillArtifactFile = {
  path: string;
  mimeType?: string;
} & (
  | { content: string; base64?: never }
  | { base64: string; content?: never }
);

/**
 * The COMPLETE pinned runtime artifact for one snapshot-pinned skill, as served
 * by `GET /journey-execution/runs/skill`. The shipped backend serves the
 * SKILL.md-only subset (`name`/`description`/`contentHash`/`content`); the
 * P0.2 union additionally carries channel provenance and — for host-channel
 * plugin skills — supporting `files` and preserved extra `frontmatter`. Every
 * extension field is optional so the SKILL.md-only response stays valid.
 */
export interface PinnedSkillArtifact {
  name: string;
  description: string;
  content: string;
  /** Opaque artifact fingerprint — covers the complete pinned envelope. */
  contentHash: string;
  skillId?: string;
  sharing?: "user" | "project";
  /** P0.2 channel provenance (stable order: host, then environment). */
  channels?: Array<"host" | "environment">;
  /** Preserved extra frontmatter beyond name/description (plugin skills). */
  frontmatter?: Record<string, unknown>;
  /** Supporting files (host-channel plugin skills only under P0.3). */
  files?: PinnedSkillArtifactFile[];
}

/**
 * Full skill with content (used when loading a skill)
 */
export interface Skill {
  name: string;
  description: string;
  content: string; // Markdown body (without frontmatter)
  path: string; // Directory name
}

/**
 * Whether a cloud skill can be pinned into a project environment's skill
 * selection. Mirrors the backend's list-field: `plugin_component` skills,
 * skills with supporting files, and skills with extra frontmatter are
 * ineligible; `reason` is backend-authored copy pickers surface verbatim.
 */
export type SkillPinnability = { ok: true } | { ok: false; reason: string };

/**
 * Skill list item (used for listing skills without full content).
 *
 * Local (filesystem) skills set `path`. Cloud (Convex) skills set `skillId`,
 * `sharing`, `isOwner`, and `origin` so the UI can key mutations by id and badge
 * each row Personal/Shared. All cloud fields are optional for backward-compat
 * with the local shape.
 */
export interface SkillListItem {
  name: string;
  description: string;
  path: string;
  /** Cloud skills only — stable id for mutations (delete/promote/get). */
  skillId?: string;
  /** Cloud skills only — 'user' (personal) or 'project' (shared). */
  sharing?: "user" | "project";
  /** Cloud skills only — whether the caller owns this (personal) skill. */
  isOwner?: boolean;
  /** Where the skill lives: 'local' filesystem or 'cloud' (Convex/Computer). */
  origin?: "local" | "cloud";
  /** Cloud skills only — how the record came to exist (absent ⇒ 'authored'). */
  provenance?: SkillProvenance;
  /**
   * Cloud skills only — whether the skill can be pinned into a project
   * environment's skill selection (backend P0.3 list-field, forwarded through
   * `/api/web/skills/list`). Absent on older backends ⇒ eligibility unknown;
   * pickers treat absent as eligible and rely on the save-time backend gate.
   */
  pinnability?: SkillPinnability;
}

/**
 * Skill result after selection (includes resolved content)
 */
export interface SkillResult {
  name: string;
  description: string;
  content: string;
  path: string;
}

/**
 * File entry in a skill directory
 */
export interface SkillFile {
  path: string; // Relative path (e.g., "scripts/fill.py")
  name: string; // File name only
  type: "file" | "directory";
  size?: number;
  mimeType?: string;
  extension?: string;
  children?: SkillFile[]; // For directories
}

/**
 * Content of a bundled skill file
 */
export interface SkillFileContent {
  path: string;
  name: string;
  content?: string; // Text content
  base64?: string; // Binary content (images)
  mimeType: string;
  size: number;
  isText: boolean;
}
