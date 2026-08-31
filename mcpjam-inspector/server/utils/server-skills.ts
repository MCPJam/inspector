/**
 * Server-served Agent Skills (SEP-2640) — the verified read path.
 *
 * The implementation moved to `@mcpjam/sdk` (`sdk/src/server-skills.ts`). Its
 * own docblock explains why: this module's whole purpose is that there is no
 * second way in to a `skills/*` call, and that promise only holds for surfaces
 * that can import it. The CLI and the MCP worker could not, so the module's
 * claim to sit between EVERY MCPJam surface and the wire was true of the
 * inspector alone.
 *
 * This file stays as the inspector's import path so no call site had to change
 * with the move — routes, the chat tools, and the capture coordinator keep
 * importing `utils/server-skills.js`, and a diff of that move is a diff of
 * imports rather than of behaviour.
 *
 * NOTE for `probeServerSkillMissing`: the SDK version takes an optional
 * `{ logger }` for its one inconclusive-probe diagnostic, because a concrete
 * logger import is precisely what could not travel into the SDK. Inspector
 * callers that want that line in the server log pass `{ logger }` from
 * `./logger.js`.
 */

export {
  EXTENSION_INACTIVE_REFUSAL,
  MAX_SERVER_SKILL_READ_BYTES,
  ServerSkillRefusalError,
  getVerifiedServerSkill,
  isServerSkillRefusalError,
  listServerSkillCatalog,
  normalizeCatalogText,
  probeServerSkillMissing,
  readVerifiedServerSkillFile,
  serverSkillsActive,
} from "@mcpjam/sdk";
export type {
  ServerSkillListing,
  ServerSkillRefusal,
  ServerSkillSummary,
  ServerSkillsLogger,
  VerifiedServerSkill,
} from "@mcpjam/sdk";
