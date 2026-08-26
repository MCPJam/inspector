/**
 * Wire evidence for an OpenAI readiness run.
 *
 * Everything here dials the target, and nothing here grades it. The split
 * matters more than usual for this product: the grading half is a pure function
 * a hosted surface can run on evidence gathered elsewhere, and a check module
 * that could open a socket would be a way around the pinned transport a hosted
 * run is required to use.
 *
 * `fetchFn` IS REQUIRED, with no default. In a hosted run it must be the
 * DNS-pinned transport, and a default would make the unguarded case the easy one
 * to reach.
 *
 * WHAT IS OPENAI-SPECIFIC HERE. Only three things; the rest is the shared
 * `directory-readiness/discovery` core:
 *
 *   - EVERY advertised authorization server is fetched, not just the first.
 *     Anthropic's client uses `authorization_servers[0]` and nothing else, so
 *     the Claude runner deliberately stops there; ChatGPT documents support for
 *     multiple issuers, and a runner that looked at one would report a
 *     multi-issuer server as healthy on the strength of an entry the host may
 *     never pick.
 *   - the domain-verification challenge, which is a plain GET at a fixed path.
 *   - the tool listing, read for annotations, schemas and security schemes.
 *
 * Node entry only — it is exported from `sdk/src/index.ts`, never from
 * `browser.ts`, so importing the result model can never pull a transport in.
 */

import {
  discoverProtectedResourceMetadata,
  fetchDiscoveryJson,
  readBoundedText,
  traceRedirects,
  type DirectoryDiscoveryOptions,
  type DirectoryRedirectHop,
  type PrmDiscoveryResult,
} from "../directory-readiness/discovery.js";
import { sha256HexOfBytes } from "../mcp-client-manager/skills-integrity.js";
import { parseYamlLite, splitFrontmatter } from "../plugin-bundle/skill.js";
import {
  OPENAI_DOMAIN_VERIFICATION_PATH,
  OPENAI_MCP_SKILL_LIMITS,
  OPENAI_MCP_SKILLS_METHODS,
} from "./profile.js";

export interface OpenAIDiscoveryOptions extends DirectoryDiscoveryOptions {
  /**
   * Cap on advertised authorization servers to fetch.
   *
   * A bound rather than a policy: `authorization_servers` is
   * server-controlled, and a document listing two hundred issuers would
   * otherwise turn one readiness run into two hundred outbound requests.
   */
  maxAuthorizationServers?: number;
}

const DEFAULT_MAX_AUTHORIZATION_SERVERS = 5;

export interface OpenAIEndpointEvidence {
  /** The endpoint URL exactly as entered — not canonicalized. */
  enteredUrl: string;
  redirectChain: DirectoryRedirectHop[];
  redirectLimitHit?: boolean;
}

export interface OpenAIAuthorizationServerEvidence {
  issuer: string;
  metadataUrl: string;
  document?: Record<string, unknown>;
  fetchError?: string;
}

export interface OpenAIAuthEvidence {
  enteredUrl: string;
  /** An unauthenticated request to the MCP endpoint. */
  unauthenticated?: {
    status: number;
    wwwAuthenticate?: string;
    /** `_meta["mcp/www_authenticate"]` from a JSON-RPC error, when present. */
    metaWwwAuthenticate?: string;
    error?: string;
  };
  prm?: PrmDiscoveryResult;
  /**
   * EVERY advertised issuer, in the order the document lists them.
   *
   * The array is the evidence: a check that only ever saw one issuer could not
   * tell "one issuer" from "we only looked at one".
   */
  authorizationServers?: OpenAIAuthorizationServerEvidence[];
  /** How many the document advertised, before the fetch cap applied. */
  advertisedAuthorizationServerCount?: number;
}

export interface OpenAIDomainVerificationEvidence {
  url: string;
  status?: number;
  /** The response body, trimmed. Compared against a declared token. */
  body?: string;
  fetchError?: string;
}

/** Walk the endpoint's redirect chain, hop by hop. */
export async function traceOpenAIEndpoint(
  options: OpenAIDiscoveryOptions,
): Promise<OpenAIEndpointEvidence> {
  return traceRedirects(options);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Read `_meta["mcp/www_authenticate"]` out of a JSON-RPC error payload.
 *
 * A server may carry the challenge in the JSON-RPC error rather than only in
 * the HTTP header, and a runner that read only the header would report a
 * conforming server as publishing no challenge at all.
 */
function readMetaWwwAuthenticate(
  document: Record<string, unknown> | undefined,
): string | undefined {
  const error = document?.error;
  if (typeof error !== "object" || error === null) return undefined;
  const meta = (error as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)["mcp/www_authenticate"];
  return typeof value === "string" ? value : undefined;
}

/**
 * The unauthenticated probe: a JSON-RPC `initialize` with no credentials.
 *
 * `initialize` rather than a bare GET because it is the request the host
 * actually makes first, so the response is the one the host actually sees. It
 * creates no resources and consumes nothing beyond a session the server is free
 * to discard.
 */
async function probeUnauthenticated(
  options: OpenAIDiscoveryOptions,
): Promise<OpenAIAuthEvidence["unauthenticated"]> {
  const result = await fetchDiscoveryJson(options.enteredUrl, options, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcpjam-openai-readiness", version: "1" },
      },
    }),
  });

  return {
    status: result.status,
    wwwAuthenticate: result.headers.get("www-authenticate") ?? undefined,
    metaWwwAuthenticate: readMetaWwwAuthenticate(result.document),
    error: result.error,
  };
}

/**
 * The `resource_metadata` pointer out of a `WWW-Authenticate` challenge.
 *
 * The quantifier is BOUNDED. Unbounded — `[^"]+` — this has the same quadratic
 * shape CodeQL flagged in the migration checks: the pattern is unanchored, and
 * a header of many repeated `resource_metadata="` with no closing quote makes
 * every restart scan to the end. The header comes from the server under test,
 * so it is exactly as untrusted as a submitted manifest. No real pointer
 * approaches this length, and one that did would be refused by the same-origin
 * check anyway.
 */
function challengePointer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /resource_metadata\s*=\s*"([^"]{1,2048})"/i.exec(header);
  return match?.[1];
}

/**
 * Fetch the authorization-server metadata for EVERY advertised issuer.
 *
 * Both well-known forms are tried per issuer, OAuth's first and then OpenID
 * Connect's, because an issuer that publishes only the OIDC document is
 * perfectly usable and a probe that tried one form would report it as
 * unreachable.
 */
async function fetchAuthorizationServers(
  options: OpenAIDiscoveryOptions,
  issuers: string[],
): Promise<OpenAIAuthorizationServerEvidence[]> {
  const limit =
    options.maxAuthorizationServers ?? DEFAULT_MAX_AUTHORIZATION_SERVERS;
  const out: OpenAIAuthorizationServerEvidence[] = [];

  for (const issuer of issuers.slice(0, limit)) {
    let base: URL;
    try {
      base = new URL(issuer);
    } catch {
      out.push({
        issuer,
        metadataUrl: issuer,
        fetchError: "issuer is not a parseable URL",
      });
      continue;
    }
    const path = base.pathname.replace(/\/$/, "");
    const candidates = [
      `${base.origin}/.well-known/oauth-authorization-server${path}`,
      `${base.origin}${path}/.well-known/openid-configuration`,
    ];

    let lastError: string | undefined;
    let recorded = false;
    for (const url of candidates) {
      const result = await fetchDiscoveryJson(url, options);
      if (result.status >= 200 && result.status < 300 && result.document) {
        out.push({ issuer, metadataUrl: url, document: result.document });
        recorded = true;
        break;
      }
      lastError = result.error ?? `${url} answered ${result.status}`;
    }
    if (!recorded) {
      out.push({ issuer, metadataUrl: candidates[0], fetchError: lastError });
    }
  }

  return out;
}

/**
 * Gather the authorization evidence: the unauthenticated challenge, the PRM
 * document, and every issuer it names.
 */
export async function discoverOpenAIAuthEvidence(
  options: OpenAIDiscoveryOptions,
): Promise<OpenAIAuthEvidence> {
  const unauthenticated = await probeUnauthenticated(options);
  const pointer =
    challengePointer(unauthenticated?.wwwAuthenticate) ??
    challengePointer(unauthenticated?.metaWwwAuthenticate);
  const prm = await discoverProtectedResourceMetadata(options, pointer);

  const issuers = stringArray(prm.document?.authorization_servers);
  const authorizationServers =
    issuers.length > 0
      ? await fetchAuthorizationServers(options, issuers)
      : undefined;

  return {
    enteredUrl: options.enteredUrl,
    unauthenticated,
    prm,
    authorizationServers,
    advertisedAuthorizationServerCount: issuers.length,
  };
}

/**
 * Fetch the domain-verification challenge.
 *
 * A plain GET at a fixed path on the endpoint's own origin. This can establish
 * that the path RESPONDS and what it says; it cannot establish that the portal
 * issued the token, which is why the check that reads this keeps the declared
 * half honest about being declared.
 */
export async function fetchOpenAIDomainVerification(
  options: OpenAIDiscoveryOptions,
): Promise<OpenAIDomainVerificationEvidence> {
  let url: string;
  try {
    url = new URL(
      OPENAI_DOMAIN_VERIFICATION_PATH,
      new URL(options.enteredUrl).origin,
    ).toString();
  } catch {
    return {
      url: OPENAI_DOMAIN_VERIFICATION_PATH,
      fetchError: "endpoint URL is not parseable",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("domain verification probe timed out")),
    options.timeoutMs ?? 15_000,
  );
  try {
    const response = await options.fetchFn(url, {
      method: "GET",
      headers: { accept: "text/plain" },
      signal: controller.signal,
    });
    // Bounded like every other document this module reads: the body is a short
    // token, and an endpoint that answers this path with a gigabyte is a
    // problem to report rather than to buffer.
    const body = await readBoundedText(response, 64 * 1024);
    return { url, status: response.status, body: body?.trim() };
  } catch (error) {
    return {
      url,
      fetchError: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Imported skills.
// ---------------------------------------------------------------------------

/** One skill the server advertises for import, as the scan saw it. */
export interface OpenAIImportedSkillEvidence {
  /** The skill's frontmatter name, when the server supplies one. */
  name?: string;
  description?: string;
  /** The digest the listing declares for the skill's markdown. */
  declaredDigest?: string;
  /** The resource the skill's markdown is served from. */
  resourceUri?: string;
  /** The frontmatter object advertised by a current SEP-2640 listing. */
  declaredFrontmatter?: Record<string, unknown>;
  /** The complete resource manifest advertised by a current SEP-2640 listing. */
  declaredResources?: OpenAIImportedSkillResourceEvidence[];
  /** Bytes of the markdown actually fetched. */
  markdownBytes?: number;
  /** SHA-256 of the markdown actually fetched, when it was fetched. */
  observedDigest?: string;
  /** Frontmatter parsed out of the fetched markdown. */
  frontmatter?: Record<string, unknown>;
  pages?: { uri: string; bytes: number }[];
  /**
   * How many pages the server DECLARED, before the read cap.
   *
   * Separate from `pages.length`, which is capped: the cap is a bound on what
   * this run will fetch, not a statement about the skill, and grading the
   * page-count limit against the capped figure could never report a skill that
   * exceeds it.
   */
  declaredPageCount?: number;
  /**
   * How many of this skill's pages had no size anyone could establish.
   *
   * Recorded rather than folded into `totalBytes` as a zero, because those two
   * say different things: a page of zero bytes is a measurement, and a page
   * nobody could measure is a gap. When this is set, `totalBytes` is absent.
   */
  unmeasuredPages?: number;
  /** Markdown plus every page. Absent when any page could not be sized. */
  totalBytes?: number;
  fetchError?: string;
}

/** One supporting resource from a current SEP-2640 skill manifest. */
export interface OpenAIImportedSkillResourceEvidence {
  uri: string;
  declaredDigest?: string;
  declaredSize?: number;
}

export interface OpenAISkillsEvidence {
  /** Whether the server advertised the skills extension at all. */
  extensionAdvertised: boolean;
  skills: OpenAIImportedSkillEvidence[];
  /** How many `skills/list` pages were walked. */
  pagesWalked: number;
  /** Set when the listing was still paginating at the page cap. */
  paginationCapHit?: boolean;
  /**
   * Set when `skills/list` produced no answer this run could read at all —
   * a transport failure, a timeout, or a status carrying no JSON body.
   *
   * SEPARATE FROM `listError`, which is also set when the server answered
   * perfectly well and said "no". Whether the extension is advertised is
   * unestablished in the first case and answered in the second, and the check
   * that grades it has to be able to tell them apart: an unreachable host is a
   * gap in this run, not a fault in the submission.
   */
  listUnreachable?: boolean;
  listError?: string;
  /**
   * When the listing was read.
   *
   * Imported skills are a SUBMISSION-TIME SNAPSHOT, not a live resource, so
   * this timestamp is what a later drift comparison is against. Recording it
   * here rather than deriving it at grade time is what keeps a replayed
   * evidence object honest about when it was gathered.
   */
  scannedAt?: string;
}

/** Pages of `skills/list` to walk before giving up. */
const MAX_SKILL_LIST_PAGES = 10;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * One JSON-RPC call against the endpoint.
 *
 * Ids increment across a run so a server that echoes them can be seen to; the
 * caller passes the id rather than this closing over a counter, because a
 * gatherer that mutated hidden state would make two runs over the same server
 * produce different evidence.
 */
async function callJsonRpc(
  options: OpenAIDiscoveryOptions,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<{
  document?: Record<string, unknown>;
  status?: number;
  transportError?: string;
}> {
  const result = await fetchDiscoveryJson(options.enteredUrl, options, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  // THE STATUS AND THE ERROR RIDE ALONG, because "the server answered, and its
  // answer was not a result" and "nothing answered at all" are different facts
  // and only one of them is the server's fault. Returning the document alone
  // collapsed them: a timeout and a 401 both arrived at the caller as
  // `undefined`, which it read as "this server does not implement the
  // extension" — a class-`required` violation raised against a host nobody
  // reached.
  return {
    document: result.document,
    status: result.status,
    transportError: result.error,
  };
}

/** The content returned by one standard `resources/read` response. */
interface ReadResourceContent {
  bytes: Uint8Array;
  text?: string;
}

function parseDeclaredResources(
  value: unknown
): OpenAIImportedSkillResourceEvidence[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const resources: OpenAIImportedSkillResourceEvidence[] = [];
  for (const candidate of value) {
    const resource = asRecord(candidate);
    const uri = resource && asString(resource.uri);
    if (!uri) continue;
    const declaredSize =
      typeof resource.size === "number" &&
      Number.isInteger(resource.size) &&
      resource.size >= 0
        ? resource.size
        : undefined;
    resources.push({
      uri,
      declaredDigest: asString(resource.digest),
      declaredSize,
    });
  }
  return resources;
}

function decodeBase64(value: string): Uint8Array | undefined {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function readResourceContent(
  document: Record<string, unknown>,
  uri: string
): ReadResourceContent | undefined {
  const result = asRecord(document.result);
  const contents =
    result && Array.isArray(result.contents) ? result.contents : [];
  const content = contents
    .map((candidate) => asRecord(candidate))
    .find((candidate) => candidate && asString(candidate.uri) === uri);
  if (!content) return undefined;

  const text = asString(content.text);
  if (text !== undefined) {
    return { bytes: new TextEncoder().encode(text), text };
  }
  const blob = asString(content.blob);
  const bytes = blob === undefined ? undefined : decodeBase64(blob);
  return bytes ? { bytes } : undefined;
}

function parseFetchedMarkdown(
  skill: OpenAIImportedSkillEvidence,
  content: ReadResourceContent
): string {
  const markdown = content.text ?? new TextDecoder().decode(content.bytes);
  skill.markdownBytes = content.bytes.byteLength;
  return markdown;
}

function recordFetchedMarkdown(
  skill: OpenAIImportedSkillEvidence,
  content: ReadResourceContent
): Promise<void> {
  const markdown = parseFetchedMarkdown(skill, content);
  return sha256HexOfBytes(content.bytes).then((digest) => {
    skill.observedDigest = digest;
    const split = splitFrontmatter(markdown);
    if (split) {
      const parsed = parseYamlLite(split.frontmatter);
      // `tooDeep` is an ARRAY of paths, so an empty array is the successful parse.
      if (parsed.tooDeep.length === 0) skill.frontmatter = parsed.data;
    }
  });
}

async function fetchCurrentSepSkillBody(
  options: OpenAIDiscoveryOptions,
  id: number,
  skill: OpenAIImportedSkillEvidence,
  entry: Record<string, unknown>
): Promise<void> {
  const uri = skill.resourceUri;
  if (!uri) {
    skill.fetchError = "the SEP-2640 listing entry declared no skill URI";
    return;
  }

  const resources =
    parseDeclaredResources(entry.resources) ?? skill.declaredResources;
  if (resources) {
    skill.declaredResources = resources;
    const pageResources = resources.filter((resource) => resource.uri !== uri);
    skill.declaredPageCount = pageResources.length;
  }

  const markdownCall = await callJsonRpc(options, id + 1, "resources/read", {
    uri,
  });
  if (!markdownCall.document) {
    skill.fetchError =
      markdownCall.transportError ??
      (markdownCall.status !== undefined
        ? `resources/read answered ${markdownCall.status} with no readable JSON body`
        : "resources/read returned no result");
    return;
  }
  if (asRecord(markdownCall.document.error)) {
    skill.fetchError =
      asString(asRecord(markdownCall.document.error)?.message) ??
      "resources/read returned an error";
    return;
  }
  const markdownContent = readResourceContent(markdownCall.document, uri);
  if (!markdownContent) {
    skill.fetchError = "resources/read returned no readable SKILL.md content";
    return;
  }
  await recordFetchedMarkdown(skill, markdownContent);
  const markdownBytes = skill.markdownBytes;
  if (markdownBytes === undefined) {
    skill.fetchError = "resources/read returned no measurable SKILL.md content";
    return;
  }

  const pageResources = (resources ?? []).filter(
    (resource) => resource.uri !== uri
  );
  const pages: { uri: string; bytes: number }[] = [];
  let unmeasuredPages = Math.max(
    0,
    pageResources.length - OPENAI_MCP_SKILL_LIMITS.maxPagesPerSkill
  );

  for (const resource of pageResources.slice(
    0,
    OPENAI_MCP_SKILL_LIMITS.maxPagesPerSkill
  )) {
    // SEP-2640 requires hosts to retrieve supporting files lazily. Their
    // manifest sizes are enough for the readiness cap checks, so do not read
    // every reference/template/script merely because it was listed.
    const page = { uri: resource.uri, bytes: resource.declaredSize ?? 0 };
    pages.push(page);
    if (resource.declaredSize === undefined) unmeasuredPages += 1;
  }

  if (pages.length > 0) skill.pages = pages;
  if (unmeasuredPages > 0) skill.unmeasuredPages = unmeasuredPages;
  skill.totalBytes =
    unmeasuredPages > 0
      ? undefined
      : markdownBytes + pages.reduce((sum, page) => sum + page.bytes, 0);
}

/**
 * Read ONE skill's body.
 *
 * Current SEP-2640 servers return metadata from `skills/get` and content from
 * the standard `resources/read` method. The legacy branch remains tolerant of
 * the pre-draft `{name, content}` shape so existing readiness evidence can be
 * replayed while servers migrate.
 */
async function fetchImportedSkillBody(
  options: OpenAIDiscoveryOptions,
  id: number,
  skill: OpenAIImportedSkillEvidence
): Promise<void> {
  const uri = skill.resourceUri;
  const name = skill.name;
  if (!uri && !name) {
    skill.fetchError =
      "the listing entry declared neither a skill URI nor name";
    return;
  }

  const call = await callJsonRpc(
    options,
    id,
    OPENAI_MCP_SKILLS_METHODS.get,
    uri ? { uri } : { name }
  );
  const document = call.document;
  if (!document) {
    skill.fetchError =
      call.transportError ??
      (call.status !== undefined
        ? `skills/get answered ${call.status} with no readable JSON body`
        : "skills/get returned no result");
    return;
  }
  const error = asRecord(document.error);
  if (error) {
    skill.fetchError =
      asString(error.message) ?? "skills/get returned an error";
    return;
  }
  const result = asRecord(document.result);
  if (!result) {
    skill.fetchError = "skills/get returned no result";
    return;
  }

  const body = asRecord(result.skill) ?? result;
  // SEP-2640's entry has a URI plus frontmatter/resources metadata and no
  // inline body. A conforming host reads the actual bytes through resources/read.
  if (
    uri &&
    asString(body.uri) === uri &&
    ("frontmatter" in body || "resources" in body)
  ) {
    await fetchCurrentSepSkillBody(options, id, skill, body);
    return;
  }

  // Legacy response compatibility: older readiness fixtures embedded markdown
  // directly in skills/get and called supporting files "pages".
  const markdown =
    asString(body.content) ?? asString(body.markdown) ?? asString(body.text);
  if (markdown === undefined) {
    skill.fetchError = "skills/get returned no markdown body";
    return;
  }
  await recordFetchedMarkdown(skill, {
    bytes: new TextEncoder().encode(markdown),
    text: markdown,
  });
  const markdownBytes = skill.markdownBytes;
  if (markdownBytes === undefined) {
    skill.fetchError = "skills/get returned no measurable markdown body";
    return;
  }

  const listed = Array.isArray(body.pages)
    ? body.pages
    : Array.isArray(body.resources)
    ? body.resources
    : [];
  const pages: { uri: string; bytes: number }[] = [];
  let unmeasuredPages = 0;
  const declaredPageCount = listed.length;
  if (declaredPageCount > 0) skill.declaredPageCount = declaredPageCount;
  for (const entry of listed.slice(
    0,
    OPENAI_MCP_SKILL_LIMITS.maxPagesPerSkill
  )) {
    const page = asRecord(entry);
    if (!page) continue;
    const pageUri = asString(page.uri) ?? asString(page.resourceUri);
    const text =
      asString(page.content) ?? asString(page.markdown) ?? asString(page.text);
    if (!pageUri) continue;
    let bytes: number | undefined;
    if (text !== undefined) bytes = new TextEncoder().encode(text).length;
    else if (
      typeof page.bytes === "number" &&
      Number.isInteger(page.bytes) &&
      page.bytes >= 0
    ) {
      bytes = page.bytes;
    }
    if (bytes === undefined) unmeasuredPages += 1;
    pages.push({ uri: pageUri, bytes: bytes ?? 0 });
  }
  if (declaredPageCount > OPENAI_MCP_SKILL_LIMITS.maxPagesPerSkill) {
    unmeasuredPages +=
      declaredPageCount - OPENAI_MCP_SKILL_LIMITS.maxPagesPerSkill;
  }
  if (pages.length > 0) skill.pages = pages;
  if (unmeasuredPages > 0) skill.unmeasuredPages = unmeasuredPages;
  skill.totalBytes =
    unmeasuredPages > 0
      ? undefined
      : markdownBytes + pages.reduce((sum, page) => sum + page.bytes, 0);
}

/**
 * Read the server's advertised skills, walking `skills/list` pagination.
 *
 * PAGINATION IS NOT OPTIONAL HERE. A server with six skills and a page size of
 * five returns the sixth on page two, and a reader that stopped at the first
 * page would report five — under the cap, passing a limit the submission
 * actually exceeds. The page walk is bounded so a server with a broken cursor
 * cannot spin, and hitting that bound is RECORDED rather than silently treated
 * as the end of the list.
 */
export async function discoverOpenAIImportedSkills(
  options: OpenAIDiscoveryOptions,
  now: () => Date = () => new Date()
): Promise<OpenAISkillsEvidence> {
  const skills: OpenAIImportedSkillEvidence[] = [];
  let cursor: string | undefined;
  let pagesWalked = 0;
  let paginationCapHit = false;
  let listError: string | undefined;
  let listUnreachable = false;
  let sawResult = false;

  for (let page = 0; page < MAX_SKILL_LIST_PAGES; page += 1) {
    const call = await callJsonRpc(
      options,
      100 + page,
      OPENAI_MCP_SKILLS_METHODS.list,
      cursor ? { cursor } : {}
    );
    const document = call.document;
    pagesWalked += 1;

    // NOTHING ANSWERED. Not the same as a server that answered without a
    // result: this run never established anything about the extension, so the
    // grade owes a coverage gap rather than a verdict. Recorded as its own
    // field because `listError` alone cannot carry the distinction — it is set
    // on both paths, and the check has to know which one it is reading.
    if (!document) {
      listUnreachable = true;
      listError =
        call.transportError ??
        (call.status !== undefined
          ? `skills/list answered ${call.status} with no readable JSON body`
          : "skills/list could not be reached");
      break;
    }

    const error = asRecord(document.error);
    if (error) {
      listError = asString(error.message) ?? "skills/list returned an error";
      break;
    }
    const result = asRecord(document.result);
    if (!result) {
      listError = "skills/list returned no result";
      break;
    }
    sawResult = true;

    const listed = Array.isArray(result.skills) ? result.skills : [];
    for (const entry of listed) {
      const skill = asRecord(entry);
      if (!skill) continue;

      // Current SEP-2640 entries are identified by URI and carry the complete
      // frontmatter plus a manifest of individually readable resources.
      const uri = asString(skill.uri);
      const frontmatter = asRecord(skill.frontmatter);
      if (uri && frontmatter) {
        const declaredResources = parseDeclaredResources(skill.resources);
        const ownResource = declaredResources?.find(
          (resource) => resource.uri === uri
        );
        const pageCount = declaredResources
          ? declaredResources.filter((resource) => resource.uri !== uri).length
          : undefined;
        skills.push({
          name: asString(frontmatter.name),
          description: asString(frontmatter.description),
          declaredFrontmatter: frontmatter,
          declaredDigest: ownResource?.declaredDigest,
          resourceUri: uri,
          declaredResources,
          declaredPageCount: pageCount,
        });
        continue;
      }

      // Keep accepting the pre-draft shape for already captured evidence and
      // servers that have not migrated yet.
      skills.push({
        name: asString(skill.name),
        description: asString(skill.description),
        declaredDigest:
          asString(skill.digest) ?? asString(skill.sha256),
        resourceUri: asString(skill.resourceUri) ?? asString(skill.uri),
      });
    }

    cursor = asString(result.nextCursor);
    if (!cursor) break;
    if (page === MAX_SKILL_LIST_PAGES - 1) paginationCapHit = true;
  }

  // THE BODIES, one call each. Bounded by the same cap the size checks grade
  // against plus a margin, so a server advertising a thousand skills cannot
  // turn a preflight into a crawl — and the cap is not silent: a listing over
  // the limit is already `violated` by the count check, which names the real
  // problem, and the skills past the cap keep their derived fields absent so
  // nothing reads as graded that was not fetched.
  const bodiesToFetch = Math.min(
    skills.length,
    OPENAI_MCP_SKILL_LIMITS.maxSkills + 1
  );
  for (let index = 0; index < bodiesToFetch; index += 1) {
    await fetchImportedSkillBody(options, 200 + index, skills[index]);
  }

  return {
    // A server that answered `skills/list` with a result advertises the
    // extension, whatever it listed. A server that errored does not — and the
    // difference decides whether the absence of skills is a badge or a fault.
    extensionAdvertised: sawResult,
    skills,
    pagesWalked,
    paginationCapHit: paginationCapHit || undefined,
    listUnreachable: listUnreachable || undefined,
    listError,
    scannedAt: now().toISOString(),
  };
}
