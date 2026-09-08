/**
 * Server-served Agent Skills (SEP-2640) — the verified read path.
 *
 * ONE module sits between every MCPJam surface (routes, chat tools, the
 * capture coordinator, the CLI) and a `skills/*` call, because the SEP's
 * integrity rules are only rules if there is no second way in:
 *
 *   - every SKILL.md is fetched via `resources/read` and verified against its
 *     manifest digest before any caller sees a byte;
 *   - a read of a URI absent from the manifest is a FAILURE, never a fetch;
 *   - every fetched file's byte length is checked against its manifest `size`
 *     BEFORE its digest, because the draft makes a length mismatch its own
 *     verification failure and the two are different diagnoses;
 *   - the fetched frontmatter is re-checked field-by-field against what the
 *     listing advertised, and the name against the URI's final segment;
 *   - the draft's per-skill limits (512 entries, 16 MiB summed) are enforced
 *     from the manifest, before the first byte is fetched;
 *   - a skill with no enumerated manifest is refused outright — whether it
 *     declared `"dynamic"` or omitted `resources` entirely, which are
 *     different server behaviours and get different refusals. SEP-2640 says a
 *     host MAY load content it cannot verify; MCPJam declines, and says so.
 *
 * Everything here is manager-shaped rather than route-shaped so the local
 * (long-lived manager) and hosted (ephemeral per-request manager) paths share
 * one implementation. `mcp-client-manager/skills-integrity.ts` owns the wire
 * and the crypto; this module owns the ORCHESTRATION and the refusals.
 *
 * It lives in the SDK because the sentence above names the CLI, and for as
 * long as this sat in the inspector that was aspiration rather than fact: the
 * CLI and the MCP worker could not import it, so any skills surface they grew
 * would have had to re-decide which server behaviours are refusals. A second
 * implementation of "the SEP's integrity rules" is exactly what the module
 * exists to prevent.
 *
 * Top-level rather than inside `mcp-client-manager/` on purpose: it needs
 * `listAllServerSkills` from `operations.ts`, which itself imports from
 * `mcp-client-manager/`, so living there would close an import cycle.
 *
 * PIN: modelcontextprotocol/modelcontextprotocol @ a3e147ca27 (branch `sep/skills-extension`, `seps/2640-skills-extension.md`).
 */

import type { MCPClientManager } from "./mcp-client-manager/index.js";
import {
  MAX_SKILL_RESOURCE_ENTRIES,
  MAX_SKILL_TOTAL_BYTES,
  SkillIntegrityError,
  checkManifestLimits,
  checkSkillIdentity,
  enumeratedResources,
  findListedResource,
  isDynamicResources,
  isSkillNotFoundError,
  sha256HexOfText,
  verifyDigest,
  verifySize,
  verifySkillMarkdown,
  type SkillEntry,
} from "./mcp-client-manager/index.js";
import { listAllServerSkills } from "./operations.js";

/**
 * Optional sink for the one diagnostic this module emits.
 *
 * A concrete logger import is what kept this module in the inspector: the CLI
 * and the MCP worker have their own, and none of them belong in the SDK. The
 * refusals are the real output — this is only for the missing-probe's
 * inconclusive branch, where an error is deliberately swallowed and would
 * otherwise vanish without trace.
 */
export interface ServerSkillsLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Hard cap on any single fetched skill file, SKILL.md included.
 *
 * This is the SEP's PER-SKILL total, applied per read. It used to be 128 KiB
 * for SKILL.md and 2 MiB for a supporting file — caps invented before the
 * draft had any, and both now sit BELOW what the draft says a host MUST
 * support. A conforming 3 MiB SKILL.md would have been refused as `too_large`,
 * which is our bug to own, not the server's.
 *
 * A file cannot legitimately exceed the whole skill's budget, so reusing the
 * total as the per-read ceiling is both spec-safe and a real bound on a server
 * that streams without end. The manifest-level budget — the sum, and the entry
 * count — is enforced separately in {@link normalizeManifest}, before the
 * first byte is fetched, which is what `size` is for.
 */
export const MAX_SERVER_SKILL_READ_BYTES = MAX_SKILL_TOTAL_BYTES;

export interface ServerSkillSummary {
  serverId: string;
  /** IDENTITY. The `name` below is a label; two skills may share one. */
  skillUri: string;
  name: string;
  description: string;
  /** Verbatim frontmatter, as advertised. */
  frontmatter: unknown;
  resources: Array<{ uri: string; digest: string; size?: number }>;
  /** Present ⇒ live-only: discoverable and refused for loading. */
  unloadable?: {
    reason:
      | "no_resources"
      | "dynamic_resources"
      | "too_many_resources"
      | "too_large";
    message: string;
  };
}

export interface ServerSkillListing {
  serverId: string;
  skills: ServerSkillSummary[];
  /** URIs the server listed twice — surfaced, never silently resolved. */
  duplicateUris: string[];
  /** Entries that failed the wire guard or identity checks, with reasons. */
  rejected: Array<{ skillUri: string; reason: string }>;
  /** SEP-2549 caching attributes, when the server sent them. */
  ttlMs?: number;
  cacheScope?: string;
}

export interface VerifiedServerSkill {
  serverId: string;
  skillUri: string;
  name: string;
  description: string;
  /** SKILL.md body, frontmatter stripped, digest- and identity-verified. */
  content: string;
  contentSha256: string;
  frontmatter: unknown;
  resources: Array<{ uri: string; digest: string; size?: number }>;
}

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

function toRefusal(error: unknown, skillUri: string): ServerSkillRefusal {
  if (error instanceof SkillIntegrityError) {
    return {
      kind: error.kind === "not_text" ? "fetch_failed" : error.kind,
      message: error.message,
      skillUri: error.skillUri,
      ...(error.resourceUri ? { resourceUri: error.resourceUri } : {}),
      ...(error.expected ? { expected: error.expected } : {}),
      ...(error.actual ? { actual: error.actual } : {}),
      ...(error.field ? { field: error.field } : {}),
    };
  }
  if (isSkillNotFoundError(error)) {
    return {
      kind: "not_found",
      message: `The server does not serve a skill at "${skillUri}".`,
      skillUri,
    };
  }
  return {
    kind: "fetch_failed",
    message: error instanceof Error ? error.message : String(error),
    skillUri,
  };
}

/** Whether this connection may speak `skills/*` at all. */
export function serverSkillsActive(
  manager: MCPClientManager,
  serverId: string
): boolean {
  try {
    return manager.getSkillsSupport(serverId).active;
  } catch {
    // An unknown / disconnected server is not an error here — it simply has no
    // skills support. Callers that need the distinction ask the manager.
    return false;
  }
}

/**
 * Normalizes untrusted catalog text before it reaches a model prompt or a UI
 * label.
 *
 * A skill `description` is server-authored and lands in the discovery listing
 * the model reads. Control characters, zero-width characters, and
 * bidi-override runs are the cheap prompt-shaping tricks; stripping them is
 * not a defence against a determined injection (the banner in
 * `server-skill-tools.ts` handles that), but it stops a description from
 * silently rewriting the surrounding listing's structure.
 */
export function normalizeCatalogText(raw: unknown, maxLength = 500): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    // C0/C1 control characters and DEL.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    // Zero-width + bidi overrides.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxLength
    ? `${cleaned.slice(0, maxLength)}…`
    : cleaned;
}

/**
 * The skill's directory URI — its own URI with the trailing `SKILL.md` removed.
 *
 * Returns `undefined` when the URI does not end in `SKILL.md`, which the
 * identity check has already rejected by the time this runs.
 */
function skillDirectoryOf(skillUri: string): string | undefined {
  // Query and fragment are stripped first, matching the SDK's
  // `skillNameFromUri`. Without this a URI like `…/refunds/SKILL.md?v=2`
  // passes the identity check and then fails here, so a skill the SDK
  // considers well-formed would be rejected for an "invalid manifest".
  const withoutQuery = skillUri.split(/[?#]/, 1)[0] ?? "";
  const match = /^(.*\/)SKILL\.md$/i.exec(withoutQuery);
  return match?.[1];
}

/**
 * Validates and normalizes a skill's file manifest.
 *
 * The manifest IS the read allowlist — `readVerifiedServerSkillFile` will fetch
 * any URI it contains — so copying it verbatim lets a skill authorize reads of
 * arbitrary resources on the same server. A skill that lists
 * `skill://acme/other-skill/secrets.env`, or the server's own
 * `file:///etc/passwd`, would have that read performed on its behalf and
 * digest-"verified" against a digest it chose itself.
 *
 * SEP-2640 requires each URI to appear exactly ONCE and to live within the
 * skill's own directory. Both are enforced here, at the single point where a
 * wire manifest becomes a summary the rest of the app trusts.
 *
 * Containment is an exact string prefix against the skill directory, with no
 * normalization — the same posture as `findListedResource`, because a
 * normalizing comparison is how an outside path sneaks past an inside one. A
 * `..` segment is refused outright rather than resolved: prefix matching alone
 * would accept `skill://acme/refunds/../../secrets` since it does start with
 * the directory, and it is the SERVER that would resolve it.
 */
function normalizeManifest(
  skillUri: string,
  raw: unknown
):
  | {
      ok: true;
      resources: Array<{ uri: string; digest: string; size?: number }>;
    }
  | {
      ok: false;
      reason: string;
      kind?: "too_many_resources" | "too_large";
    } {
  if (!Array.isArray(raw)) return { ok: true, resources: [] };
  const root = skillDirectoryOf(skillUri);
  if (root === undefined) {
    return { ok: false, reason: `skill URI does not end in SKILL.md` };
  }
  const resources: Array<{ uri: string; digest: string; size?: number }> = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const uri = String((entry as { uri?: unknown })?.uri ?? "");
    const digest = String((entry as { digest?: unknown })?.digest ?? "");
    // The wire guard has already constrained `size` to a non-negative integer
    // when present; anything else never reaches here.
    const size = (entry as { size?: unknown })?.size;
    if (uri.length === 0 || digest.length === 0) {
      return { ok: false, reason: "manifest entry is missing uri or digest" };
    }
    if (seen.has(uri)) {
      // A manifest that lists one URI twice contradicts itself, and picking
      // either copy would be a guess about which digest is authoritative.
      return { ok: false, reason: `manifest lists "${uri}" more than once` };
    }
    seen.add(uri);
    if (!uri.startsWith(root)) {
      return {
        ok: false,
        reason: `manifest entry "${uri}" is outside the skill directory "${root}"`,
      };
    }
    if (uri.slice(root.length).split("/").includes("..")) {
      return {
        ok: false,
        reason: `manifest entry "${uri}" contains a parent-directory segment`,
      };
    }
    resources.push({
      uri,
      digest,
      ...(typeof size === "number" ? { size } : {}),
    });
  }

  // The draft's per-skill limits, enforced from the manifest BEFORE the first
  // fetch — which is the whole reason `size` exists. A skill over either limit
  // is "not guaranteed to be loadable by any conforming host", and the draft
  // asks that a host declining on this basis say why rather than fail silently
  // on a later read.
  const limits = checkManifestLimits(resources);
  if (!limits.ok) {
    return limits.reason === "too_many_resources"
      ? {
          ok: false,
          kind: "too_many_resources",
          reason: `manifest lists ${limits.actual} files, over the ${MAX_SKILL_RESOURCE_ENTRIES}-entry limit`,
        }
      : {
          ok: false,
          kind: "too_large",
          reason: `manifest totals ${limits.actual} bytes, over the ${MAX_SKILL_TOTAL_BYTES}-byte per-skill limit`,
        };
  }
  return { ok: true, resources };
}

/**
 * Turns a wire entry into a summary, or explains why it cannot be one.
 *
 * The identity rules (`name` present, equal to the URI's final segment) are
 * applied HERE rather than at load time, so a malformed entry never reaches a
 * picker where a user could select it.
 */
function toSummary(
  serverId: string,
  entry: SkillEntry
): { ok: true; skill: ServerSkillSummary } | { ok: false; reason: string } {
  const frontmatter = entry.frontmatter;
  if (
    typeof frontmatter !== "object" ||
    frontmatter === null ||
    Array.isArray(frontmatter)
  ) {
    return { ok: false, reason: "frontmatter is not an object" };
  }
  const record = frontmatter as Record<string, unknown>;
  // The FULL SEP-2640 identity rule, including `name` == the URI's final path
  // segment. Applied here rather than only at load time so a mismatched entry
  // is REJECTED into the listing's `rejected` list instead of appearing in the
  // catalog as a normal skill that always fails when clicked.
  const identity = checkSkillIdentity(entry.uri, frontmatter);
  if (!identity.ok) {
    return {
      ok: false,
      reason:
        identity.reason === "name_uri_mismatch"
          ? `frontmatter.name "${identity.actual}" is not the URI's final path segment ("${identity.expected}")`
          : `invalid frontmatter (${identity.reason})`,
    };
  }
  const name = identity.name;
  const description = normalizeCatalogText(record.description);
  if (description.length === 0) {
    return { ok: false, reason: "frontmatter.description is missing" };
  }
  const dynamic = isDynamicResources(entry);
  const manifest = normalizeManifest(
    entry.uri,
    dynamic ? undefined : enumeratedResources(entry)
  );
  if (!manifest.ok) {
    // A LIMIT breach is not a malformed manifest. The skill is real, its
    // manifest parses, and a user should see it in the catalog for the same
    // reason a `dynamic` one is shown — dropping it into `rejected` hides a
    // real skill behind what reads as a server bug. Only a manifest we cannot
    // make sense of is rejected outright.
    if (manifest.kind !== undefined) {
      const advertised = enumeratedResources(entry) ?? [];
      return {
        ok: true,
        skill: {
          serverId,
          skillUri: entry.uri,
          name,
          description,
          frontmatter,
          resources: advertised,
          unloadable: {
            reason: manifest.kind,
            message: `This skill exceeds what a host is required to support: its ${manifest.reason}. MCPJam declines to load it.`,
          },
        },
      };
    }
    return { ok: false, reason: manifest.reason };
  }
  const resources = manifest.resources;

  return {
    ok: true,
    skill: {
      serverId,
      skillUri: entry.uri,
      name,
      description,
      frontmatter,
      resources,
      // Recorded, not rejected: the skill is real and a user should see it in
      // the catalog. Loading is what we refuse.
      //
      // `"dynamic"` and a MISSING manifest are both unloadable and are kept
      // apart deliberately: one is a server exercising a form the draft
      // defines, the other is a server omitting a field the draft requires.
      // Collapsing them would tell a server author their conforming skill is
      // malformed.
      ...(dynamic
        ? {
            unloadable: {
              reason: "dynamic_resources" as const,
              message:
                "This skill generates its content per request, so there is no manifest to verify it against. MCPJam declines to load unverifiable skills.",
            },
          }
        : resources.length === 0
          ? {
              unloadable: {
                reason: "no_resources" as const,
                message:
                  "This skill does not advertise a file manifest, so MCPJam cannot verify its contents and declines to load it.",
              },
            }
          : {}),
    },
  };
}

/**
 * Drains `skills/list` and shapes it for a catalog.
 *
 * Remember what a listing is NOT: proof of absence. SEP-2640 allows a partial
 * listing, so a skill missing from this result may still exist — confirm with
 * {@link getVerifiedServerSkill}, which is also how the capture coordinator
 * decides whether a skill really disappeared.
 */
export async function listServerSkillCatalog(
  manager: MCPClientManager,
  serverId: string
): Promise<ServerSkillListing> {
  const drained = await listAllServerSkills(manager, { serverId });
  const skills: ServerSkillSummary[] = [];
  const rejected: ServerSkillListing["rejected"] = [];
  const duplicates = new Set(drained.duplicateUris);

  for (const entry of drained.skills) {
    if (duplicates.has(entry.uri)) {
      // A self-contradictory listing is a server bug to surface, not resolve.
      // Both copies are refused; last-in-wins would hide the contradiction.
      rejected.push({
        skillUri: entry.uri,
        reason: "listed more than once in a single listing",
      });
      continue;
    }
    const summary = toSummary(serverId, entry);
    if (!summary.ok) {
      rejected.push({ skillUri: entry.uri, reason: summary.reason });
      continue;
    }
    skills.push(summary.skill);
  }

  return {
    serverId,
    skills,
    duplicateUris: [...duplicates],
    rejected,
    ...(drained.ttlMs !== undefined ? { ttlMs: drained.ttlMs } : {}),
    ...(drained.cacheScope !== undefined
      ? { cacheScope: drained.cacheScope }
      : {}),
  };
}

/** Reads a resource and returns its text, or throws a structured refusal. */
async function readResourceText(
  manager: MCPClientManager,
  serverId: string,
  uri: string,
  maxBytes: number
): Promise<string> {
  const result = (await manager.readResource(serverId, { uri })) as {
    contents?: Array<{ text?: string; blob?: string; mimeType?: string }>;
  };
  const first = result.contents?.[0];
  if (!first) {
    throw new ServerSkillRefusalError({
      kind: "fetch_failed",
      message: `The server returned no contents for "${uri}".`,
      resourceUri: uri,
    });
  }
  if (typeof first.text !== "string") {
    throw new ServerSkillRefusalError({
      kind: "fetch_failed",
      message: `"${uri}" is not text (${
        first.mimeType ?? "unknown type"
      }), so it cannot be read as a skill file.`,
      resourceUri: uri,
    });
  }
  const bytes = new TextEncoder().encode(first.text).byteLength;
  if (bytes > maxBytes) {
    throw new ServerSkillRefusalError({
      kind: "too_large",
      message: `"${uri}" is ${bytes} bytes, over the ${maxBytes}-byte limit.`,
      resourceUri: uri,
    });
  }
  return first.text;
}

/**
 * The ONE verified load path: `skills/get` (or a supplied listing entry), then
 * `resources/read`, then every mandatory check.
 *
 * Passing an `entry` skips the `skills/get` round trip when the caller already
 * drained a listing. Passing only a `uri` is the DIRECT path — the one that
 * makes an unlisted skill reachable, which is why `skills/get` exists at all: a
 * skill URI can arrive from server `instructions`, from another skill's body,
 * or from the user.
 */
export async function getVerifiedServerSkill(
  manager: MCPClientManager,
  args: { serverId: string; uri: string; entry?: SkillEntry }
): Promise<VerifiedServerSkill> {
  const { serverId, uri } = args;
  let entry: SkillEntry;
  try {
    entry = args.entry ?? (await manager.getServerSkill(serverId, uri));
  } catch (error) {
    throw new ServerSkillRefusalError(toRefusal(error, uri));
  }

  // On the `skills/get` path the SERVER chooses `entry.uri`. Answering a
  // request for URI A with an entry whose URI is B keeps the integrity chain
  // internally consistent while silently replacing the identity the user (or
  // the approval card) asked for. That is a substitution, not a redirect.
  if (entry.uri !== uri) {
    throw new ServerSkillRefusalError({
      kind: "identity_mismatch",
      message: `The server answered "${uri}" with a skill whose URI is "${entry.uri}".`,
      skillUri: uri,
      expected: uri,
      actual: entry.uri,
    });
  }

  // MCPJam policy, applied before any fetch: nothing to verify against means
  // we decline the SEP's permission to load unverified content. The two ways
  // that happens get their own refusals — see `toSummary` for why.
  if (isDynamicResources(entry)) {
    throw new ServerSkillRefusalError({
      kind: "dynamic_resources",
      message: `Skill "${uri}" declares "dynamic" content, so there is no manifest to verify it against. MCPJam declines to load unverifiable skills.`,
      skillUri: uri,
    });
  }
  const advertised = enumeratedResources(entry);
  if (!advertised || advertised.length === 0) {
    throw new ServerSkillRefusalError({
      kind: "no_resources",
      message: `Skill "${uri}" does not advertise a file manifest, so its contents cannot be verified. MCPJam declines to load unverifiable skills.`,
      skillUri: uri,
    });
  }

  // The manifest is the read allowlist, so it is validated BEFORE the first
  // fetch — containment and uniqueness, same rule the listing path applies. A
  // manifest reaching `readVerifiedServerSkillFile` unchecked would let a skill
  // authorize reads of resources outside its own directory.
  const manifest = normalizeManifest(entry.uri, advertised);
  if (!manifest.ok) {
    throw new ServerSkillRefusalError({
      // A limit breach is not a malformed manifest — the draft asks a host
      // declining on that basis to say WHY, and `unlisted_resource` would
      // point the reader at a containment bug that isn't there.
      kind: manifest.kind ?? "unlisted_resource",
      message: `Skill "${uri}" advertises an invalid file manifest: ${manifest.reason}.`,
      skillUri: uri,
    });
  }

  const markdown = await readResourceText(
    manager,
    serverId,
    entry.uri,
    MAX_SERVER_SKILL_READ_BYTES
  );

  let verified;
  try {
    verified = await verifySkillMarkdown({ entry, markdown });
  } catch (error) {
    throw new ServerSkillRefusalError(toRefusal(error, entry.uri));
  }

  return {
    serverId,
    skillUri: entry.uri,
    name: verified.frontmatter.name,
    description: normalizeCatalogText(verified.frontmatter.description),
    content: verified.body,
    contentSha256: await sha256HexOfText(verified.body),
    frontmatter: entry.frontmatter,
    resources: manifest.resources,
  };
}

/**
 * Reads ONE supporting file, enforcing the manifest as a read allowlist.
 *
 * The unlisted-URI check happens BEFORE the fetch, not after: SEP-2640 says
 * unlisted reads are failures, and a server that serves the file anyway (the
 * fixture's `serveUnlistedFile` mode does exactly this) must not be able to get
 * bytes in front of a model just because it answered.
 */
export async function readVerifiedServerSkillFile(
  manager: MCPClientManager,
  args: {
    serverId: string;
    entry: Pick<SkillEntry, "uri" | "resources">;
    resourceUri: string;
  }
): Promise<{ uri: string; text: string; digest: string }> {
  // Normalize BEFORE the allowlist check, rather than trusting the caller to
  // have passed a manifest that `getVerifiedServerSkill` already validated.
  //
  // Every caller in this repo does pass one, so this changes no behaviour
  // today — it removes the requirement to. Containment (an entry may not point
  // outside its own skill directory) is what stops a manifest authorizing a
  // read of `skill://other-skill/secrets.env`, and a check that holds only
  // while callers remember it is the "second way in" this module exists to
  // prevent. That argument got sharper when this became a public SDK export:
  // the CLI and the MCP worker now call it directly.
  const manifest = normalizeManifest(args.entry.uri, args.entry.resources);
  if (!manifest.ok) {
    throw new ServerSkillRefusalError({
      kind: manifest.kind ?? "unlisted_resource",
      message: `Skill "${args.entry.uri}" advertises an invalid file manifest: ${manifest.reason}.`,
      skillUri: args.entry.uri,
      resourceUri: args.resourceUri,
    });
  }
  const listed = findListedResource(
    { resources: manifest.resources },
    args.resourceUri
  );
  if (!listed) {
    throw new ServerSkillRefusalError({
      kind: "unlisted_resource",
      message: `"${args.resourceUri}" is not in the manifest for "${args.entry.uri}". MCPJam refuses reads of files a skill did not list.`,
      skillUri: args.entry.uri,
      resourceUri: args.resourceUri,
    });
  }

  const text = await readResourceText(
    manager,
    args.serverId,
    args.resourceUri,
    MAX_SERVER_SKILL_READ_BYTES
  );
  const bytes = new TextEncoder().encode(text);
  // Size before digest, same order and same reasoning as `verifySkillMarkdown`:
  // a truncated read and a tampered file are different diagnoses, and only the
  // length check can tell them apart.
  const sizing = verifySize(bytes.byteLength, listed);
  if (!sizing.ok) {
    throw new ServerSkillRefusalError({
      kind: "size_mismatch",
      message: `"${args.resourceUri}" is advertised as ${sizing.expected} bytes but the server returned ${sizing.actual}.`,
      skillUri: args.entry.uri,
      resourceUri: args.resourceUri,
      expected: String(sizing.expected),
      actual: String(sizing.actual),
    });
  }
  const verification = await verifyDigest(bytes, listed.digest);
  if (!verification.ok) {
    throw new ServerSkillRefusalError({
      kind: verification.reason,
      message:
        verification.reason === "unsupported_digest"
          ? `"${args.resourceUri}" declares a digest algorithm MCPJam does not verify (${verification.expected}).`
          : `"${args.resourceUri}" did not match its advertised digest.`,
      skillUri: args.entry.uri,
      resourceUri: args.resourceUri,
      expected: verification.expected,
      ...(verification.actual !== undefined
        ? { actual: verification.actual }
        : {}),
    });
  }

  return { uri: args.resourceUri, text, digest: listed.digest };
}

/**
 * Probes whether a previously-seen skill is really gone.
 *
 * `true` ⇒ the server answered `-32602` for the URI, which is the ONLY
 * evidence of absence SEP-2640 provides. An absent listing entry means
 * nothing; a transport failure means nothing either (returns `false`, so a
 * flaky connection never tombstones a skill).
 */
export async function probeServerSkillMissing(
  manager: MCPClientManager,
  serverId: string,
  uri: string,
  options?: { logger?: ServerSkillsLogger }
): Promise<boolean> {
  try {
    await manager.getServerSkill(serverId, uri);
    return false;
  } catch (error) {
    if (isSkillNotFoundError(error)) return true;
    options?.logger?.debug("[server-skills] missing-probe inconclusive", {
      serverId,
      uri,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
