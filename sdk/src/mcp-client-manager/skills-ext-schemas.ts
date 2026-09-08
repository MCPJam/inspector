/**
 * PIN: modelcontextprotocol/modelcontextprotocol @ a3e147ca27 (branch `sep/skills-extension`, `seps/2640-skills-extension.md`).
 * Re-diff against that commit when re-syncing.
 */
/**
 * Runtime validation for `io.modelcontextprotocol/skills` (SEP-2640)
 * payloads.
 *
 * VENDORED-FROM-SEP-2640-DRAFT — zod mirrors of the extension's wire shapes.
 * SEP-2640 ships prose plus TypeScript interfaces rather than a
 * `schema.json`, so these mirrors are hand-derived from the SEP body; the
 * `PIN` above is what a re-sync diffs against.
 *
 * Skill payloads come from an untrusted server and are the INPUT to a
 * security-relevant integrity check (digest verification, frontmatter
 * identity), so a `typeof entry.uri === "string"` sniff is not enough: a
 * malformed `resources` entry that slips through would produce a manifest the
 * verifier silently treats as "no such file".
 *
 * Unknown keys are PASSED THROUGH (`.loose()`): a debugger must show whatever
 * the server actually sent, and this is a draft extension that may grow
 * fields. `frontmatter` in particular is deliberately `z.unknown()`-valued —
 * SEP-2640 requires it be reproduced VERBATIM, so narrowing it here would
 * discard the very bytes the identity re-check compares.
 */

import { z } from "zod";
import { DYNAMIC_SKILL_RESOURCES } from "./skills-ext-types.js";

/**
 * One entry in a skill's `resources` manifest: the complete list of files the
 * host is allowed to fetch for that skill.
 *
 * `digest` is validated for PRESENCE only — not for the `<algo>:<hex>` shape
 * and not for algorithm support. Both live in `skills-integrity.ts`
 * (`parseDigest`), deliberately: an unrecognised algorithm is a server the
 * host must REFUSE to verify against, and refusing with a useful message needs
 * the offending value to have survived parsing rather than being erased into a
 * generic schema error.
 */
export const skillResourceRefSchema = z
  .object({
    uri: z.string().min(1),
    digest: z.string().min(1),
    // REQUIRED by the draft, optional here. A non-negative integer when
    // present: this is untrusted input that flows into a length comparison and
    // a pre-fetch budget, and a negative or fractional byte count has no
    // meaning in either. Absence is a server that predates the field, which
    // `verifySize` reports rather than refuses — see `skills-ext-types.ts`.
    size: z.number().int().nonnegative().optional(),
  })
  .loose();

/**
 * A skill entry, as returned by BOTH `skills/list` (in `skills[]`) and
 * `skills/get` (as the whole result). SEP-2640 gives them the same shape on
 * purpose: a host that can render a listing entry can render a get.
 *
 * `resources` is REQUIRED by the draft and takes one of two forms — an
 * enumerated manifest, or the string `"dynamic"`. It stays OPTIONAL here
 * anyway, for the same reason `digest` is presence-checked rather than
 * shape-checked: a server that omits it must survive parsing so the refusal
 * can name the skill and the violation. MCPJam declines to load anything
 * without an enumerated manifest, and that policy lives in
 * `skills-integrity.ts` / `server-skills.ts`, not here.
 */
export const skillEntrySchema = z
  .object({
    uri: z.string().min(1),
    // VERBATIM: the SEP requires the frontmatter be reproduced exactly as it
    // appears in SKILL.md, and the host re-checks it field-by-field against
    // the fetched file. Any narrowing here would be a lossy copy of the thing
    // being compared.
    //
    // REQUIRED, via the explicit `undefined` refinement: on this zod version a
    // bare `z.unknown()` value makes the KEY optional at runtime, so an entry
    // with no `frontmatter` at all would parse and then skip the identity
    // re-check entirely — the check would report success having compared
    // nothing.
    frontmatter: z.unknown().refine((value) => value !== undefined, {
      message: "frontmatter is required",
    }),
    // A UNION, not just an array: the draft's second form is the bare string
    // `"dynamic"`, for a skill whose content is generated per request. Parsing
    // only the array turns a conforming dynamic server into an
    // `InvalidSkillsPayloadError` — a wire error where a stated policy refusal
    // belongs, and one the user cannot act on.
    resources: z
      .union([
        z.array(skillResourceRefSchema),
        z.literal(DYNAMIC_SKILL_RESOURCES),
      ])
      .optional(),
  })
  .loose();

/**
 * `skills/list` result.
 *
 * `ttlMs` / `cacheScope` are SEP-2549 (client-side caching) attributes that
 * MAY ride any paginated list result. They are preserved through the guard
 * and surfaced to callers rather than dropped: the capture coordinator uses
 * them to decide how long a drained listing stays fresh, and dropping a
 * caching directive silently would make MCPJam a worse citizen than the hosts
 * it emulates.
 */
export const skillsListResultSchema = z
  .object({
    skills: z.array(skillEntrySchema),
    nextCursor: z.string().optional(),
    // Non-negative integer: this is untrusted server input that flows into a
    // freshness calculation, and a negative or fractional TTL has no meaning
    // there. Constrained at the boundary rather than left for each consumer
    // to guess at.
    ttlMs: z.number().int().nonnegative().optional(),
    cacheScope: z.string().optional(),
  })
  .loose();

/**
 * `resources/directory/read` result — the OPTIONAL readdir gated on the
 * server's `{ directoryRead: true }` setting.
 *
 * Entries are `{ uri, mimeType?, name?, size? }`; a directory entry is one
 * whose `mimeType` is `inode/directory`. Nothing here interprets that — the
 * classification is a caller concern — but `uri` is required because an entry
 * that cannot be addressed is not an entry.
 */
export const directoryEntrySchema = z
  .object({
    uri: z.string().min(1),
    name: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .loose();

export const directoryReadResultSchema = z
  .object({
    // `resources`, not `entries` — this is the SEP's field name, and it is
    // also what `resources/list` calls the same shape. Reading the wrong key
    // rejects every conforming server while accepting only a server that
    // repeats our mistake.
    resources: z.array(directoryEntrySchema),
    nextCursor: z.string().optional(),
  })
  .loose();

/**
 * `skills/get` result — an ENVELOPE around one entry, not a bare entry.
 *
 * SEP-2640 returns `{ skill: SkillEntry }`. Validating the whole result as a
 * `SkillEntry` fails on every conforming server, because the required `uri`
 * lives one level down; it only appears to work against a server that flattens
 * the envelope the same way.
 */
export const skillsGetResultSchema = z
  .object({
    skill: skillEntrySchema,
  })
  .loose();

export type SkillResourceRefWire = z.infer<typeof skillResourceRefSchema>;
export type SkillEntryWire = z.infer<typeof skillEntrySchema>;
export type SkillsListResultWire = z.infer<typeof skillsListResultSchema>;
export type DirectoryEntryWire = z.infer<typeof directoryEntrySchema>;
export type DirectoryReadResultWire = z.infer<typeof directoryReadResultSchema>;
export type SkillsGetResultWire = z.infer<typeof skillsGetResultSchema>;
