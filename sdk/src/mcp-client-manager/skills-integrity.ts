/**
 * Integrity primitives for `io.modelcontextprotocol/skills` (SEP-2640).
 *
 * SEP-2640 makes four checks MANDATORY for a host, and this module is the one
 * place each is implemented:
 *
 *   1. every fetched file is verified against its manifest `digest`;
 *   2. a read of a URI absent from the manifest is a FAILURE, not a fetch;
 *   3. the fetched SKILL.md's frontmatter is re-checked field-by-field against
 *      the frontmatter the listing claimed;
 *   4. the URI's final path segment must equal `frontmatter.name`.
 *
 * ## Browser-safe by construction
 *
 * `crypto.subtle` (WebCrypto), never `node:crypto`. The SDK is imported by the
 * inspector's client bundle as well as its server, and a `node:crypto` import
 * here would break the browser build the same way the Ajv-backed dialect
 * validator does (which is why `tasks-ext-schemas.ts` uses zod rather than
 * it). WebCrypto's digest is async, so every verification helper here is too.
 *
 * ## Why refusal is the default everywhere
 *
 * Each helper returns a discriminated result rather than a boolean, because
 * every caller must be able to say WHAT failed: MCPJam is a debugger, and
 * "digest mismatch" with no expected/actual pair is not a diagnosis. Callers
 * that only need a gate can check `.ok`.
 */

import type {
  SkillEntry,
  SkillIdentityFrontmatter,
  SkillResourceRef,
} from "./skills-ext-types.js";

/**
 * Digest algorithms this host will verify against.
 *
 * SEP-2640 writes digests as `<algorithm>:<hex>` and does not fix the
 * algorithm set. We accept only SHA-2 family members WebCrypto implements —
 * an unrecognised algorithm produces a REFUSAL, never a skipped check. That
 * is the whole point: a server could otherwise declare `digest: "none:"` and
 * disable verification for its own content.
 */
const SUPPORTED_DIGEST_ALGORITHMS = {
  sha256: "SHA-256",
  sha384: "SHA-384",
  sha512: "SHA-512",
} as const;

export type SupportedDigestAlgorithm = keyof typeof SUPPORTED_DIGEST_ALGORITHMS;

export interface ParsedDigest {
  algorithm: SupportedDigestAlgorithm;
  /** Lowercased hex, already length-checked for the algorithm. */
  hex: string;
}

const DIGEST_HEX_LENGTHS: Record<SupportedDigestAlgorithm, number> = {
  sha256: 64,
  sha384: 96,
  sha512: 128,
};

/**
 * Parses a `<algorithm>:<hex>` digest, or returns `undefined` for anything
 * this host will not verify against (unknown algorithm, wrong hex length,
 * non-hex characters, missing separator).
 *
 * Case: the algorithm and hex are both lowercased before comparison — hex is
 * case-insensitive, and a server writing `SHA256:AB…` is not a threat, just
 * untidy.
 */
export function parseDigest(raw: unknown): ParsedDigest | undefined {
  if (typeof raw !== "string") return undefined;
  const separator = raw.indexOf(":");
  if (separator <= 0) return undefined;
  const algorithm = raw.slice(0, separator).toLowerCase();
  const hex = raw.slice(separator + 1).toLowerCase();
  if (!(algorithm in SUPPORTED_DIGEST_ALGORITHMS)) return undefined;
  const supported = algorithm as SupportedDigestAlgorithm;
  if (hex.length !== DIGEST_HEX_LENGTHS[supported]) return undefined;
  if (!/^[0-9a-f]+$/.test(hex)) return undefined;
  return { algorithm: supported, hex };
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function subtle(): SubtleCrypto {
  const webcrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!webcrypto?.subtle) {
    // Node >= 20 and every supported browser expose this. A missing
    // `crypto.subtle` means verification is IMPOSSIBLE, and the SEP forbids
    // loading unverified content — so this throws rather than degrading.
    throw new Error(
      "WebCrypto (crypto.subtle) is unavailable; skill digests cannot be verified."
    );
  }
  return webcrypto.subtle;
}

/** Hex SHA-256 of raw bytes. */
export async function sha256HexOfBytes(
  bytes: Uint8Array | ArrayBuffer
): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // `.slice()` produces a standalone ArrayBuffer, which keeps this correct for
  // a view over a larger (e.g. pooled Node Buffer) backing store.
  const digest = await subtle().digest("SHA-256", view.slice().buffer);
  return toHex(digest);
}

/** Hex SHA-256 of a UTF-8 string. */
export async function sha256HexOfText(text: string): Promise<string> {
  return sha256HexOfBytes(new TextEncoder().encode(text));
}

export type DigestVerification =
  | { ok: true; algorithm: SupportedDigestAlgorithm; digest: string }
  | {
      ok: false;
      reason: "unsupported_digest" | "digest_mismatch";
      expected: string;
      actual?: string;
    };

/**
 * Verifies bytes against a manifest digest string.
 *
 * An UNSUPPORTED digest fails with its own reason rather than
 * `digest_mismatch`: they call for different messages ("this server used an
 * algorithm we do not verify" vs "this file is not what the server said it
 * was"), and conflating them would let an algorithm-downgrade read as
 * tampering, or vice versa.
 */
export async function verifyDigest(
  bytes: Uint8Array | ArrayBuffer,
  expectedDigest: string
): Promise<DigestVerification> {
  const parsed = parseDigest(expectedDigest);
  if (!parsed) {
    return {
      ok: false,
      reason: "unsupported_digest",
      expected: String(expectedDigest),
    };
  }
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const actual = toHex(
    await subtle().digest(
      SUPPORTED_DIGEST_ALGORITHMS[parsed.algorithm],
      view.slice().buffer
    )
  );
  if (actual !== parsed.hex) {
    return {
      ok: false,
      reason: "digest_mismatch",
      expected: `${parsed.algorithm}:${parsed.hex}`,
      actual: `${parsed.algorithm}:${actual}`,
    };
  }
  return {
    ok: true,
    algorithm: parsed.algorithm,
    digest: `${parsed.algorithm}:${parsed.hex}`,
  };
}

/**
 * The manifest entry for `uri`, or `undefined` when the URI is NOT listed.
 *
 * SEP-2640: "hosts MUST treat reads of unlisted files as failures". This is
 * the lookup that makes that enforceable — a caller that fetches without
 * consulting it has bypassed the rule, so every read path in the SDK and the
 * app goes through here first.
 *
 * Matching is EXACT on the URI string. No normalization, no percent-decoding,
 * no trailing-slash tolerance: a normalizing comparison is precisely how an
 * unlisted path sneaks past a listed one.
 */
export function findListedResource(
  entry: Pick<SkillEntry, "resources">,
  uri: string
): SkillResourceRef | undefined {
  return entry.resources?.find((resource) => resource.uri === uri);
}

/** Whether `uri` appears in the entry's manifest. */
export function isListedResource(
  entry: Pick<SkillEntry, "resources">,
  uri: string
): boolean {
  return findListedResource(entry, uri) !== undefined;
}

/**
 * The final path segment of a skill URI — the value SEP-2640 requires to equal
 * `frontmatter.name`.
 *
 * Convention is `skill://<skill-path>/SKILL.md`, so the NAME is the segment
 * BEFORE the trailing `SKILL.md`, not the last segment outright. Non-`skill://`
 * schemes are supported (skill-ness comes from the listing, never the scheme),
 * so this works on the raw string rather than through a URL parser — a custom
 * scheme is not guaranteed to be WHATWG-parseable, and `new URL()` would
 * additionally percent-decode, which would let `%2F` masquerade as a segment
 * boundary.
 *
 * Returns `undefined` when no name segment can be derived; callers treat that
 * as an identity failure, never as "skip the check".
 */
export function skillNameFromUri(uri: string): string | undefined {
  if (typeof uri !== "string" || uri.length === 0) return undefined;
  // Strip query/fragment before segmenting — `…/SKILL.md?v=2` must still
  // resolve to the same name segment.
  const withoutQuery = uri.split(/[?#]/, 1)[0] ?? "";
  // Strip the scheme, so `skill://SKILL.md` has NO name segment rather than
  // the scheme token `skill:` standing in for one. Done by hand rather than
  // with `new URL()` for the reasons in the doc comment.
  const schemeEnd = withoutQuery.indexOf("://");
  const authorityStart =
    schemeEnd >= 0
      ? schemeEnd + 3
      : (() => {
          const colon = withoutQuery.indexOf(":");
          const slash = withoutQuery.indexOf("/");
          return colon > 0 && (slash === -1 || colon < slash) ? colon + 1 : 0;
        })();
  const path = withoutQuery.slice(authorityStart);
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return undefined;
  const last = segments[segments.length - 1];
  if (last?.toLowerCase() === "skill.md") {
    const name = segments[segments.length - 2];
    return name && name.length > 0 ? name : undefined;
  }
  return last && last.length > 0 ? last : undefined;
}

export type FrontmatterIdentityCheck =
  | { ok: true; name: string; description: string }
  | {
      ok: false;
      reason:
        | "not_an_object"
        | "missing_name"
        | "missing_description"
        | "name_uri_mismatch"
        | "field_drift";
      /** The frontmatter field that failed, when the failure is field-scoped. */
      field?: string;
      expected?: string;
      actual?: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks a skill's identity: the frontmatter carries a usable `name` /
 * `description`, and the `name` equals the URI's final path segment.
 *
 * This is the FIRST of the two identity checks. The second — that the
 * frontmatter the server ADVERTISED matches the frontmatter actually present
 * in the fetched SKILL.md — is {@link checkFrontmatterDrift}, which needs the
 * fetched bytes and therefore cannot run at listing time.
 */
export function checkSkillIdentity(
  uri: string,
  frontmatter: unknown
): FrontmatterIdentityCheck {
  if (!isRecord(frontmatter)) {
    return { ok: false, reason: "not_an_object" };
  }
  const name = frontmatter.name;
  const description = frontmatter.description;
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, reason: "missing_name", field: "name" };
  }
  if (typeof description !== "string" || description.length === 0) {
    return { ok: false, reason: "missing_description", field: "description" };
  }
  const uriName = skillNameFromUri(uri);
  if (uriName !== name) {
    return {
      ok: false,
      reason: "name_uri_mismatch",
      field: "name",
      expected: uriName ?? "(no final path segment)",
      actual: name,
    };
  }
  return { ok: true, name, description };
}

/**
 * Field-by-field re-check of the ADVERTISED frontmatter against the
 * frontmatter parsed out of the FETCHED SKILL.md.
 *
 * SEP-2640 requires this explicitly, and the direction matters: every field
 * the server advertised must be present and identical in the fetched file.
 * The converse is NOT required — a fetched file may carry extra frontmatter
 * the listing omitted (the listing is a summary), and rejecting that would
 * break conforming servers.
 *
 * Comparison is on a canonical JSON serialization, so nested values (an
 * `allowed-tools` array, a metadata object) are compared structurally rather
 * than by reference. Key order within an object is normalized; array order is
 * NOT (order is semantic in every frontmatter list we know of).
 */
export function checkFrontmatterDrift(
  advertised: unknown,
  fetched: unknown
): FrontmatterIdentityCheck {
  if (!isRecord(advertised)) {
    return { ok: false, reason: "not_an_object" };
  }
  if (!isRecord(fetched)) {
    return { ok: false, reason: "not_an_object" };
  }
  for (const field of Object.keys(advertised)) {
    const expected = canonicalJson(advertised[field]);
    const actual = canonicalJson(fetched[field]);
    if (expected !== actual) {
      return {
        ok: false,
        reason: "field_drift",
        field,
        expected,
        actual,
      };
    }
  }
  const name = advertised.name;
  const description = advertised.description;
  return {
    ok: true,
    name: typeof name === "string" ? name : "",
    description: typeof description === "string" ? description : "",
  };
}

/**
 * Deterministic JSON with object keys sorted, used for structural comparison
 * and for content-addressed version hashing.
 *
 * `undefined` serializes to the literal `"undefined"` sentinel rather than
 * disappearing, so "field absent" and "field present as null" stay distinct in
 * a drift comparison.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortValue(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * The content-addressed identity of one captured skill VERSION.
 *
 * Covers everything that makes a version distinct: the skill's URI, its
 * verbatim frontmatter, its complete (sorted) resource manifest, and the hash
 * of its SKILL.md body. Two captures agreeing on all four are the same
 * version, and an append-only version store keys on exactly this.
 *
 * The manifest is sorted by `uri` before hashing so a server that reorders its
 * `resources` array between listings does not mint a spurious new version;
 * within an entry, `uri` and `digest` are the only fields hashed, because a
 * `.loose()` passthrough key is not part of the skill's identity.
 */
export async function computeSkillVersionHash(args: {
  skillUri: string;
  frontmatter: unknown;
  resources: ReadonlyArray<{ uri: string; digest: string }>;
  contentSha256: string;
}): Promise<string> {
  const manifest = [...args.resources]
    .map((resource) => ({ uri: resource.uri, digest: resource.digest }))
    .sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  return sha256HexOfText(
    canonicalJson({
      skillUri: args.skillUri,
      frontmatter: args.frontmatter,
      resources: manifest,
      contentSha256: args.contentSha256,
    })
  );
}

/**
 * Structured integrity failure. Thrown by the verified-load helpers so a
 * caller can render the specific violation (which file, which digest, which
 * frontmatter field) instead of a generic "load failed".
 */
export class SkillIntegrityError extends Error {
  readonly skillUri: string;
  readonly kind:
    | "unlisted_resource"
    | "digest_mismatch"
    | "unsupported_digest"
    | "frontmatter_drift"
    | "identity_mismatch"
    | "no_resources"
    | "fetch_failed"
    | "not_text";
  readonly resourceUri?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly field?: string;

  constructor(args: {
    message: string;
    skillUri: string;
    kind: SkillIntegrityError["kind"];
    resourceUri?: string;
    expected?: string;
    actual?: string;
    field?: string;
  }) {
    super(args.message);
    this.name = "SkillIntegrityError";
    this.skillUri = args.skillUri;
    this.kind = args.kind;
    if (args.resourceUri !== undefined) this.resourceUri = args.resourceUri;
    if (args.expected !== undefined) this.expected = args.expected;
    if (args.actual !== undefined) this.actual = args.actual;
    if (args.field !== undefined) this.field = args.field;
  }
}

export function isSkillIntegrityError(
  error: unknown
): error is SkillIntegrityError {
  return error instanceof Error && error.name === "SkillIntegrityError";
}

/**
 * Splits a SKILL.md into its YAML frontmatter block and body.
 *
 * Deliberately minimal and NOT a YAML parser: the only fields the SEP requires
 * a host to compare are scalars (`name`, `description`), and pulling a full
 * YAML implementation into the browser bundle to compare two strings would be
 * a poor trade. Nested/complex frontmatter is preserved as raw text under the
 * `__raw` key so a drift check against a server that advertises it fails
 * LOUDLY (raw-text inequality) rather than silently passing.
 */
export function splitSkillMarkdown(markdown: string): {
  frontmatter: Record<string, unknown> | undefined;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return { frontmatter: undefined, body: markdown };
  const block = match[1] ?? "";
  const body = markdown.slice(match[0].length);
  const frontmatter: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const keyed = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!keyed) continue;
    const key = keyed[1] as string;
    let value = (keyed[2] ?? "").trim();
    // Strip one layer of matching quotes; YAML scalars are commonly quoted and
    // the quotes are not part of the value being compared.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) frontmatter[key] = value;
  }
  frontmatter.__raw = block;
  return { frontmatter, body };
}

/**
 * The advertised-frontmatter subset a drift check can honestly compare against
 * the minimal parser above: scalar string fields only.
 *
 * A server that advertises a nested `metadata: {…}` object cannot be compared
 * field-for-field without a YAML parser, so those fields are EXCLUDED from the
 * comparison rather than compared against `undefined` (which would fail every
 * conforming server that uses them). The SEP's required identity fields —
 * `name` and `description` — are always scalars, so the mandatory check is
 * unaffected; this only bounds the optional extra-field comparison to what can
 * be checked soundly.
 */
export function comparableAdvertisedFrontmatter(
  advertised: unknown
): Record<string, unknown> {
  if (!isRecord(advertised)) return {};
  const comparable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(advertised)) {
    if (typeof value === "string") comparable[key] = value;
  }
  return comparable;
}

/**
 * Verifies a fetched SKILL.md against its listing entry: digest (when the
 * SKILL.md URI is itself in the manifest, which conforming servers do),
 * identity, and frontmatter drift.
 *
 * `resources` presence is checked by the CALLER, not here — refusing a
 * resource-less skill is MCPJam policy (we decline the SEP's "MAY" to load
 * unverifiable content), and policy belongs at the call site that can explain
 * it to a user.
 */
export async function verifySkillMarkdown(args: {
  entry: SkillEntry;
  markdown: string;
  bytes?: Uint8Array;
}): Promise<{ frontmatter: SkillIdentityFrontmatter; body: string }> {
  const { entry, markdown } = args;

  const identity = checkSkillIdentity(entry.uri, entry.frontmatter);
  if (!identity.ok) {
    throw new SkillIntegrityError({
      message:
        identity.reason === "name_uri_mismatch"
          ? `Skill "${entry.uri}" advertises name "${identity.actual}" but its URI's final path segment is "${identity.expected}".`
          : `Skill "${entry.uri}" has invalid frontmatter (${identity.reason}).`,
      skillUri: entry.uri,
      kind:
        identity.reason === "name_uri_mismatch"
          ? "identity_mismatch"
          : "frontmatter_drift",
      ...(identity.field !== undefined ? { field: identity.field } : {}),
      ...(identity.expected !== undefined
        ? { expected: identity.expected }
        : {}),
      ...(identity.actual !== undefined ? { actual: identity.actual } : {}),
    });
  }

  const listed = findListedResource(entry, entry.uri);
  if (listed) {
    const bytes = args.bytes ?? new TextEncoder().encode(markdown);
    const verification = await verifyDigest(bytes, listed.digest);
    if (!verification.ok) {
      throw new SkillIntegrityError({
        message:
          verification.reason === "unsupported_digest"
            ? `Skill "${entry.uri}" declares an unsupported digest algorithm (${verification.expected}); MCPJam will not load content it cannot verify.`
            : `Skill "${entry.uri}" did not match its advertised digest.`,
        skillUri: entry.uri,
        kind: verification.reason,
        resourceUri: entry.uri,
        expected: verification.expected,
        ...(verification.ok === false && verification.actual !== undefined
          ? { actual: verification.actual }
          : {}),
      });
    }
  }

  const { frontmatter: parsed, body } = splitSkillMarkdown(markdown);
  const drift = checkFrontmatterDrift(
    comparableAdvertisedFrontmatter(entry.frontmatter),
    parsed ?? {}
  );
  if (!drift.ok) {
    throw new SkillIntegrityError({
      message: `Skill "${entry.uri}" frontmatter field "${drift.field}" differs from what the server advertised.`,
      skillUri: entry.uri,
      kind: "frontmatter_drift",
      ...(drift.field !== undefined ? { field: drift.field } : {}),
      ...(drift.expected !== undefined ? { expected: drift.expected } : {}),
      ...(drift.actual !== undefined ? { actual: drift.actual } : {}),
    });
  }

  return {
    frontmatter: { name: identity.name, description: identity.description },
    body,
  };
}
