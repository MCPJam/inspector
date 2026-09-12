/**
 * Moved to `shared/secret-scrubber.ts`, re-exported here.
 *
 * WHY IT MOVED. The daemon needs it: a secret typed into a page comes back in
 * the accessibility tree, the page text and the DOM, and the daemon is where
 * those are first written down (the ledger row, `/v1/trace`, the durable
 * mirror) — scrubbing only on the way out of the server is scrubbing a value
 * that was already recorded. The daemon is BUNDLED, and the bundler refuses
 * anything outside `daemon/`, `protocol.ts` and `shared/`.
 *
 * This file stays so the three existing importers keep working; they are all
 * server-side and have no reason to care where it lives.
 */
export {
  createSecretScrubber,
  escapeDepthOf,
  MIN_SCRUBBABLE_LENGTH,
  type SecretRegistryEntry,
  type SecretReplacement,
  type SecretScrubber,
} from "../../../shared/secret-scrubber";
