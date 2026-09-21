/**
 * Public types for `io.modelcontextprotocol/skills` (SEP-2640).
 *
 * Kept separate from the zod mirrors so app code can import the shapes without
 * pulling the validators.
 *
 * NO index signatures. The mirrors pass unknown keys through at RUNTIME (a
 * debugger must show what the server sent), but promising them in the PUBLIC
 * type would let consumers write code against arbitrary extension fields and
 * make any future tightening a breaking change. Passthrough is behavior, not
 * contract.
 */

/** One file in a skill's `resources` manifest. */
export interface SkillResourceRef {
  /** Resource URI, resolvable via plain `resources/read`. */
  uri: string;
  /** `<algorithm>:<hex>` — e.g. `sha256:ab12…`. */
  digest: string;
  /**
   * Length in bytes of the file's raw content — the same bytes `digest`
   * covers. The draft makes this REQUIRED, and a read whose byte length
   * differs is "a verification failure equivalent to a digest mismatch".
   *
   * Optional HERE because the SEP is unratified and servers built against the
   * earlier draft omit it. MCPJam enforces it wherever the server sent one and
   * reports its absence rather than refusing the skill — refusing would make
   * us incompatible with every implementation that predates the field, which
   * is a bad trade for a debugger. See `verifySize`.
   */
  size?: number;
}

/**
 * The `resources` value for a skill whose content is generated per request.
 *
 * A dynamic skill offers nothing to digest, count, or budget, so MCPJam
 * refuses to LOAD one — but it must still PARSE, or a conforming server
 * becomes an unexplained wire error instead of a stated policy refusal.
 */
export const DYNAMIC_SKILL_RESOURCES = "dynamic" as const;

/** Limits the draft requires a host to support, per skill. */
export const MAX_SKILL_RESOURCE_ENTRIES = 512;
export const MAX_SKILL_TOTAL_BYTES = 16 * 1024 * 1024;

/**
 * A skill as the server describes it. IDENTITY IS `uri`, not
 * `frontmatter.name` — the SEP is explicit that the name is a label and the
 * URI is the identity, and two skills served by one server may legally share
 * a name (`acme/billing/refunds` vs `acme/support/refunds`).
 */
export interface SkillEntry {
  uri: string;
  /**
   * The SKILL.md frontmatter, VERBATIM. Typed `unknown` because the host
   * re-checks it field-by-field against the fetched file: a parsed-and-
   * re-serialized copy would not be the thing under comparison.
   */
  frontmatter: unknown;
  /**
   * The complete set of files this skill is allowed to fetch, or
   * {@link DYNAMIC_SKILL_RESOURCES} for a skill generated per request. A read
   * of any URI absent from an enumerated manifest MUST fail (SEP-2640
   * integrity rules).
   *
   * The draft makes this REQUIRED. It stays optional in the TYPE so a server
   * that omits it is still parseable and can be refused by name; MCPJam
   * refuses to load an entry without an enumerated manifest either way.
   */
  resources?: SkillResourceRef[] | typeof DYNAMIC_SKILL_RESOURCES;
}

/** `skills/list` result, with SEP-2549 caching attributes preserved. */
export interface SkillsExtListResult {
  skills: SkillEntry[];
  nextCursor?: string;
  /** SEP-2549: how long this listing may be cached, in milliseconds. */
  ttlMs?: number;
  /** SEP-2549: the scope the cache entry is valid for. */
  cacheScope?: string;
}

/** One entry from the optional `resources/directory/read`. */
export interface SkillsDirectoryEntry {
  uri: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

export interface SkillsDirectoryReadResult {
  resources: SkillsDirectoryEntry[];
  nextCursor?: string;
}

/** The mimeType that marks a directory resource (SEP-2640). */
export const INODE_DIRECTORY_MIME_TYPE = "inode/directory" as const;

/**
 * The frontmatter fields SEP-2640 requires a host to re-check field-by-field
 * against the fetched SKILL.md. `name` additionally must equal the URI's final
 * path segment.
 */
export interface SkillIdentityFrontmatter {
  name: string;
  description: string;
}
