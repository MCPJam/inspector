/**
 * Moved to `shared/secret-scrubber.ts`, re-exported here.
 *
 * The bundled daemon needs it: the daemon first records page output (ledger,
 * `/v1/trace`, durable mirror), so scrubbing only in the server is too late.
 *
 * Kept so existing server importers keep working.
 */
export {
  createSecretScrubber,
  escapeDepthOf,
  MIN_SCRUBBABLE_LENGTH,
  type SecretRegistryEntry,
  type SecretReplacement,
  type SecretScrubber,
} from "../../../shared/secret-scrubber";
