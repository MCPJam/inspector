/**
 * The refusal a server-skill load or read ends in (SEP-2640).
 *
 * Split out of `server-skills.ts` so the verified read path, the read cache
 * and any route can share one definition without importing each other.
 */

/**
 * Why a load was refused, in a shape a tool result / route response can render
 * without losing the specific violation.
 *
 * A debugger's users need to know WHICH digest, WHICH field, WHICH URI — a
 * bare "failed to load" turns a server bug into a mystery.
 */
export interface ServerSkillRefusal {
  kind:
    | "no_resources"
    | "dynamic_resources"
    | "unlisted_resource"
    | "digest_mismatch"
    | "unsupported_digest"
    | "size_mismatch"
    | "too_many_resources"
    | "frontmatter_drift"
    | "identity_mismatch"
    | "not_found"
    | "too_large"
    | "fetch_failed"
    | "extension_inactive";
  message: string;
  skillUri?: string;
  resourceUri?: string;
  expected?: string;
  actual?: string;
  field?: string;
}

/**
 * The refusal every route returns for a connection where the extension is not
 * mutually declared.
 *
 * Shared rather than written per route: the client turns a failed response with
 * NO refusal into a generic `fetch_failed`, so a route that forgot this would
 * report a network problem for what is a capability state. One definition means
 * `/get` and `/read-file`, local and hosted, cannot drift apart in that wording.
 */
export const EXTENSION_INACTIVE_REFUSAL: ServerSkillRefusal = {
  kind: "extension_inactive",
  message:
    "This connection does not have Skills over MCP active, so there is nothing to load. The server must declare the skills extension and the client must advertise it.",
};

export class ServerSkillRefusalError extends Error {
  readonly refusal: ServerSkillRefusal;
  constructor(refusal: ServerSkillRefusal) {
    super(refusal.message);
    this.name = "ServerSkillRefusalError";
    this.refusal = refusal;
  }
}

export function isServerSkillRefusalError(
  error: unknown
): error is ServerSkillRefusalError {
  return error instanceof Error && error.name === "ServerSkillRefusalError";
}
