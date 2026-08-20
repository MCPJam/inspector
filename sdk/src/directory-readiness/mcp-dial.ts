/**
 * One MCP session, dialled by hand, for readiness evidence.
 *
 * WHY NOT `MCPClientManager`. The manager is the right tool for a conformance
 * suite: it negotiates, retries, falls back between transports and keeps a
 * connection alive. Every one of those is a liability here. A readiness run is
 * an evidence-gathering pass whose whole value is that a hosted node can
 * REPRODUCE it — same pinned transport, same bounded reads, same recorded
 * completeness — and a client that silently retried or fell back would produce
 * evidence that did not match what the host under grading would have seen.
 * What this needs is the opposite of resilience: exactly the requests a host
 * makes, once each, with every truncation recorded.
 *
 * WHAT THIS FIXES. `gatherOpenAIReadinessEvidence` accepted a tool listing as
 * an ARGUMENT and never fetched one. A wire run therefore graded every
 * tool-annotation requirement as `not-evaluated` forever — the checks existed,
 * were wired up, and could not fire. That is the failure mode the whole
 * `incomplete` design exists to make visible, and it was invisible because the
 * gap looked like a missing caller input rather than a missing dial.
 *
 * COMPLETENESS IS THE PRODUCT. Every listing here reports whether it finished.
 * A truncated `tools/list` that reported only its first page would let a
 * submission with forty tools be graded on five and called ready — so a run
 * that hits the page cap says so, and the caller turns that into a missing
 * input rather than a pass.
 *
 * `fetchFn` IS REQUIRED, with no default, exactly as in `discovery.ts`: in a
 * hosted run it must be the DNS-pinned transport, and a default would make the
 * unguarded case the easy one to reach.
 *
 * Node entry only — exported from `sdk/src/index.ts`, never from `browser.ts`.
 */

import {
  fetchDiscoveryJson,
  type DirectoryDiscoveryOptions,
} from "./discovery.js";

/** The client this product presents itself as. Stable, and deliberately named. */
export const DIRECTORY_DIAL_CLIENT_INFO = Object.freeze({
  name: "mcpjam-directory-readiness",
  version: "1",
});

/**
 * The protocol version the dial negotiates with.
 *
 * PINNED, not "latest". Readiness grades what a specific host would see, and
 * hosts pin too; following the newest revision the SDK happens to know would
 * make the same server produce different evidence across an SDK upgrade that
 * changed nothing about the server.
 */
export const DIRECTORY_DIAL_PROTOCOL_VERSION = "2025-06-18";

export interface DirectoryDialOptions extends DirectoryDiscoveryOptions {
  /**
   * Pages of a paginated listing to walk before stopping.
   *
   * A bound on this run, never a statement about the server: hitting it is
   * recorded as incompleteness, so the grade reports a gap instead of a
   * verdict reached from a partial list.
   */
  maxListPages?: number;
  /** Entries to keep from a listing, across all pages. */
  maxListEntries?: number;
}

export const DIRECTORY_DIAL_DEFAULTS = Object.freeze({
  maxListPages: 10,
  maxListEntries: 500,
});

/** What `initialize` established, or why it did not. */
export interface DirectoryInitializeEvidence {
  ok: boolean;
  status?: number;
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
  /** `Mcp-Session-Id`, when the server opened a session. */
  sessionId?: string;
  /** Server-declared instructions, bounded. */
  instructions?: string;
  /** A JSON-RPC error the server returned, or a transport failure. */
  error?: string;
  /**
   * Whether anything answered at all.
   *
   * Distinct from `ok`. A server that answered `401` is REACHABLE and refusing;
   * one that timed out is unestablished. Only the second is a gap in this run
   * rather than a fact about the target, and a grader that could not tell them
   * apart would raise a runtime blocker against a host nobody reached.
   */
  unreachable?: boolean;
}

/** The subset of a tool definition readiness grades. Shape-compatible across publishers. */
export interface DirectoryToolEvidence {
  name: string;
  title?: string;
  description?: string;
  annotations?: Record<string, unknown>;
  inputSchema?: unknown;
  outputSchema?: unknown;
  _meta?: Record<string, unknown>;
  securitySchemes?: unknown;
}

/** One resource the server serves, as the listing described it. */
export interface DirectoryResourceEvidence {
  uri: string;
  name?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}

/**
 * A listing, plus whether it is the whole listing.
 *
 * The three completeness fields are separate because they are closed by
 * different actions: a capped page walk needs a bigger budget, an entry cap
 * needs a smaller server, and an unreachable listing needs a working host.
 */
export interface DirectoryListingEvidence<Entry> {
  entries: Entry[];
  pagesWalked: number;
  /** Set when the walk stopped at `maxListPages` with a cursor still open. */
  paginationCapHit?: boolean;
  /** Set when the walk stopped at `maxListEntries`. */
  entryCapHit?: boolean;
  /** Set when the server answered but declared no such capability. */
  unsupported?: boolean;
  /** Set when nothing readable answered. */
  unreachable?: boolean;
  error?: string;
  /**
   * The single question every consumer actually asks: may this listing be
   * graded as the complete set?
   *
   * Derived once here rather than by each caller re-deriving it from four
   * fields, because a caller that forgot one of them would grade a partial
   * listing as complete — which is the exact bug this module was written to
   * fix.
   */
  complete: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A cap that is a positive, finite, safe integer — or the default. */
function boundedCap(value: number | undefined, fallback: number): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : fallback;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Cap on a server-controlled free-text field we only ever display. */
const MAX_INSTRUCTIONS_CHARS = 4_000;

interface JsonRpcCall {
  document?: Record<string, unknown>;
  status?: number;
  headers?: Headers;
  transportError?: string;
}

/**
 * One JSON-RPC request, with the status and transport error riding along.
 *
 * "The server answered and its answer was not a result" and "nothing answered"
 * are different facts and only one is the target's fault. A helper that
 * returned the document alone collapses them, and the collapse always fails in
 * the same direction: an unreachable host is graded as a non-conforming one.
 */
async function callJsonRpc(
  options: DirectoryDialOptions,
  id: number,
  method: string,
  params: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Promise<JsonRpcCall> {
  const result = await fetchDiscoveryJson(options.enteredUrl, options, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": DIRECTORY_DIAL_PROTOCOL_VERSION,
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return {
    document: result.document,
    status: result.status,
    headers: result.headers,
    transportError: result.error,
  };
}

/**
 * Send `notifications/initialized`, the half of the handshake that has no reply.
 *
 * IT IS NOT OPTIONAL. The lifecycle says the client MUST send it once
 * `initialize` returns, and server frameworks enforce that literally — the
 * Python SDK errors any request that arrives before it. Skipping it because
 * "nothing depends on a notification" would leave every server built on one
 * refusing to list, and the refusal would arrive here as a listing gap: the
 * grade would read "we could not read this server's tools", which is
 * indistinguishable from a server that really is unreachable and is wrong
 * about a server that is perfectly conformant.
 *
 * Failures are swallowed on purpose. Whether the notification landed is not
 * evidence about the target — a notification has no answer to grade — and the
 * listings that follow report their own reachability. What matters is that it
 * was sent before them.
 */
async function sendInitializedNotification(
  options: DirectoryDialOptions,
  sessionId: string | undefined,
): Promise<void> {
  try {
    await fetchDiscoveryJson(options.enteredUrl, options, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": DIRECTORY_DIAL_PROTOCOL_VERSION,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
  } catch {
    // See above: the listings that follow are what report reachability.
  }
}

/**
 * Open a session with `initialize`, then complete the handshake.
 *
 * The `notifications/initialized` follow-up is sent for the reason
 * `sendInitializedNotification` documents: a server entitled to refuse every
 * request until it arrives would otherwise be graded on answers it was never
 * going to give.
 */
export async function dialInitialize(
  options: DirectoryDialOptions,
): Promise<DirectoryInitializeEvidence> {
  const call = await callJsonRpc(options, 1, "initialize", {
    protocolVersion: DIRECTORY_DIAL_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: DIRECTORY_DIAL_CLIENT_INFO,
  });

  if (!call.document) {
    return {
      ok: false,
      status: call.status,
      unreachable: call.transportError !== undefined || !call.status,
      error:
        call.transportError ??
        (call.status !== undefined
          ? `initialize answered ${call.status} with no readable JSON body`
          : "initialize could not be reached"),
    };
  }

  const error = asRecord(call.document.error);
  if (error) {
    return {
      ok: false,
      status: call.status,
      error: asString(error.message) ?? "initialize returned an error",
    };
  }

  const result = asRecord(call.document.result);
  if (!result) {
    return {
      ok: false,
      status: call.status,
      error: "initialize returned no result",
    };
  }

  const serverInfo = asRecord(result.serverInfo);
  const instructions = asString(result.instructions);
  const sessionId = call.headers?.get("mcp-session-id") ?? undefined;

  // Before anything else is asked of the server, and awaited so it cannot
  // arrive after the listing it was supposed to unlock.
  await sendInitializedNotification(options, sessionId);

  return {
    ok: true,
    status: call.status,
    protocolVersion: asString(result.protocolVersion),
    serverInfo: serverInfo
      ? {
          name: asString(serverInfo.name),
          version: asString(serverInfo.version),
        }
      : undefined,
    capabilities: asRecord(result.capabilities),
    sessionId,
    instructions:
      instructions === undefined
        ? undefined
        : instructions.slice(0, MAX_INSTRUCTIONS_CHARS),
  };
}

/**
 * Walk one paginated listing method to its end, or to a cap it records.
 *
 * A CURSOR THAT DOES NOT ADVANCE ends the walk. A server echoing the same
 * cursor forever is a broken server, and the page cap alone would spend the
 * whole budget on it before reporting a gap that is really a defect.
 */
async function walkListing<Entry>(
  options: DirectoryDialOptions,
  method: string,
  resultKey: string,
  idBase: number,
  sessionId: string | undefined,
  read: (entry: Record<string, unknown>) => Entry | undefined,
): Promise<DirectoryListingEvidence<Entry>> {
  // CAPS ARE SANITISED BEFORE THE WALK, and the reason is specific: a
  // `maxListPages` of `0`, `-1` or `NaN` makes the loop body never run, and
  // the walk then returns zero entries with `complete: true` — an unread
  // listing graded as "this server advertises nothing", which is the single
  // worst thing this module can produce. `Infinity` fails the other way, by
  // removing the bound entirely. Neither is worth propagating as an error: a
  // nonsense cap is a caller bug, and falling back to the default keeps the
  // run honest while it is fixed.
  const maxPages = boundedCap(
    options.maxListPages,
    DIRECTORY_DIAL_DEFAULTS.maxListPages,
  );
  const maxEntries = boundedCap(
    options.maxListEntries,
    DIRECTORY_DIAL_DEFAULTS.maxListEntries,
  );
  const headers = sessionId ? { "mcp-session-id": sessionId } : undefined;

  const entries: Entry[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pagesWalked = 0;
  let paginationCapHit = false;
  let entryCapHit = false;
  let unsupported = false;
  let unreachable = false;
  let error: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const call = await callJsonRpc(
      options,
      idBase + page,
      method,
      cursor ? { cursor } : {},
      headers,
    );
    pagesWalked += 1;

    if (!call.document) {
      unreachable = true;
      error =
        call.transportError ??
        (call.status !== undefined
          ? `${method} answered ${call.status} with no readable JSON body`
          : `${method} could not be reached`);
      break;
    }

    const rpcError = asRecord(call.document.error);
    if (rpcError) {
      // A METHOD THE SERVER DOES NOT IMPLEMENT is not a gap in this run. JSON-RPC
      // -32601 is the server saying "there is nothing here", which is an answer;
      // treating it as unreachable would report a resource-less server as one
      // nobody could reach.
      unsupported = rpcError.code === -32601;
      error = asString(rpcError.message) ?? `${method} returned an error`;
      break;
    }

    const result = asRecord(call.document.result);
    if (!result) {
      error = `${method} returned no result`;
      break;
    }

    const listed = Array.isArray(result[resultKey]) ? result[resultKey] : [];
    for (const raw of listed as unknown[]) {
      const record = asRecord(raw);
      if (!record) continue;
      const entry = read(record);
      if (entry === undefined) continue;
      if (entries.length >= maxEntries) {
        entryCapHit = true;
        break;
      }
      entries.push(entry);
    }
    if (entryCapHit) break;

    const next = asString(result.nextCursor);
    if (!next) break;
    if (seenCursors.has(next)) {
      error = `${method} repeated cursor ${JSON.stringify(
        next,
      )}; the walk was stopped`;
      paginationCapHit = true;
      break;
    }
    seenCursors.add(next);
    cursor = next;
    if (page === maxPages - 1) paginationCapHit = true;
  }

  // "THE METHOD IS NOT IMPLEMENTED" is only an answer to the whole question
  // when it is the answer to the FIRST page. A server that served a page, gave
  // us a cursor, and then answered -32601 has not told us there is nothing
  // here; it has told us something is broken, over a listing we now hold half
  // of. Reading that as complete would let the half we have stand in for the
  // set — the one substitution this module exists to prevent.
  const unsupportedIsTheAnswer =
    unsupported && pagesWalked === 1 && entries.length === 0;

  return {
    entries,
    pagesWalked,
    paginationCapHit: paginationCapHit || undefined,
    entryCapHit: entryCapHit || undefined,
    unsupported: unsupportedIsTheAnswer || undefined,
    unreachable: unreachable || undefined,
    error,
    // Everything that set a flag left the listing partial, and a partial
    // listing is not a set anyone may grade.
    complete:
      !paginationCapHit &&
      !entryCapHit &&
      !unreachable &&
      (unsupportedIsTheAnswer || !error),
  };
}

/** Walk `tools/list`, recording whether the walk finished. */
export async function dialToolListing(
  options: DirectoryDialOptions,
  sessionId?: string,
): Promise<DirectoryListingEvidence<DirectoryToolEvidence>> {
  return walkListing<DirectoryToolEvidence>(
    options,
    "tools/list",
    "tools",
    100,
    sessionId,
    (record) => {
      const name = asString(record.name);
      if (!name) return undefined;
      return {
        name,
        title: asString(record.title),
        description: asString(record.description),
        annotations: asRecord(record.annotations),
        inputSchema: record.inputSchema,
        outputSchema: record.outputSchema,
        _meta: asRecord(record._meta),
        securitySchemes: record.securitySchemes ?? record.security,
      };
    },
  );
}

/** Walk `resources/list`, recording whether the walk finished. */
export async function dialResourceListing(
  options: DirectoryDialOptions,
  sessionId?: string,
): Promise<DirectoryListingEvidence<DirectoryResourceEvidence>> {
  return walkListing<DirectoryResourceEvidence>(
    options,
    "resources/list",
    "resources",
    300,
    sessionId,
    (record) => {
      const uri = asString(record.uri);
      if (!uri) return undefined;
      return {
        uri,
        name: asString(record.name),
        mimeType: asString(record.mimeType),
        _meta: asRecord(record._meta),
      };
    },
  );
}

/** A resource listing narrowed to the app/UI templates, with the tools that name them. */
export interface DirectoryAppResourceEvidence {
  listing: DirectoryListingEvidence<DirectoryResourceEvidence>;
  /** Resources whose MIME type marks them as a host-rendered template. */
  appResources: DirectoryResourceEvidence[];
  /** `uri` → tool names whose `_meta` points at it. */
  referencedByTools: Record<string, string[]>;
}

/**
 * The `_meta` keys a tool uses to point at its UI template.
 *
 * Four spellings because four conventions shipped: OpenAI's
 * `openai/outputTemplate`, this product's own `mcpjam/outputTemplate`, the
 * MCP-Apps extension's `mcp/ui`, and the older bare `outputTemplate`. Reading
 * whichever is present costs nothing and insisting on one would report a
 * working app as having no template at all.
 */
const TEMPLATE_META_KEYS = [
  "openai/outputTemplate",
  "mcpjam/outputTemplate",
  "mcp/ui",
  "outputTemplate",
] as const;

function templateUriFromMeta(
  meta: Record<string, unknown> | undefined,
): string | undefined {
  if (!meta) return undefined;
  for (const key of TEMPLATE_META_KEYS) {
    const value = meta[key];
    if (typeof value === "string" && value) return value;
    const record = asRecord(value);
    const uri = asString(record?.uri);
    if (uri) return uri;
  }
  return undefined;
}

/**
 * Collect the app/UI resources, and which tools reference them.
 *
 * `appHtmlMime` is an ARGUMENT because the profile string belongs to the
 * publisher: hard-coding either publisher's constant here would make this
 * module quietly Anthropic's or OpenAI's. Matching is on the MIME type's
 * media half so a `; charset=utf-8` suffix does not hide a conforming
 * template.
 */
export async function dialAppResources(
  options: DirectoryDialOptions,
  appHtmlMime: string,
  tools: readonly DirectoryToolEvidence[],
  sessionId?: string,
): Promise<DirectoryAppResourceEvidence> {
  const listing = await dialResourceListing(options, sessionId);
  const wanted = appHtmlMime.split(";")[0]!.trim().toLowerCase();
  const profile = appHtmlMime.toLowerCase();

  const appResources = listing.entries.filter((resource) => {
    const mime = (resource.mimeType ?? "").toLowerCase();
    if (!mime) return false;
    // The full profile string first — `text/html;profile=mcp-app` is what the
    // publishers require — then the bare media type, so a template that omits
    // the profile parameter is still COLLECTED and can be graded as
    // non-conforming rather than vanishing from the evidence entirely.
    return mime.startsWith(profile) || mime.split(";")[0]!.trim() === wanted;
  });

  const referencedByTools: Record<string, string[]> = {};
  for (const tool of tools) {
    const uri = templateUriFromMeta(tool._meta);
    if (!uri) continue;
    (referencedByTools[uri] ??= []).push(tool.name);
  }
  for (const names of Object.values(referencedByTools)) names.sort();

  return { listing, appResources, referencedByTools };
}

/** Everything one dial pass established about a server. */
export interface DirectoryDialEvidence {
  initialize: DirectoryInitializeEvidence;
  tools?: DirectoryListingEvidence<DirectoryToolEvidence>;
  appResources?: DirectoryAppResourceEvidence;
}

export interface DirectoryDialRequest extends DirectoryDialOptions {
  /** The publisher's app template MIME profile. Omit to skip resources. */
  appHtmlMime?: string;
  /**
   * A tool listing the caller already holds.
   *
   * Supplying it SKIPS `tools/list` — and the skip is the point, not an
   * optimisation. A caller that already has an attributable listing and wants
   * only the app resources would otherwise make the target answer `tools/list`
   * again for an answer it is about to discard, and two listings of one server
   * can disagree.
   *
   * The list is still used, for the `referencedByTools` map: which tools point
   * at which template is a fact about the pair, so it cannot be derived from
   * the resources alone.
   */
  tools?: readonly DirectoryToolEvidence[];
}

/**
 * Initialize, then list what the session allows.
 *
 * SEQUENTIAL, not parallel, and not an optimisation left on the table: a
 * server that issues a session id expects it on subsequent requests, and
 * firing the listings before `initialize` returned would either drop the
 * header or race it. The listings are skipped entirely when `initialize`
 * failed — every one of them would fail the same way, and three copies of one
 * transport error is noise that buries the cause.
 */
export async function dialMcpServer(
  request: DirectoryDialRequest,
): Promise<DirectoryDialEvidence> {
  const initialize = await dialInitialize(request);
  if (!initialize.ok) {
    // THE LISTING CARRIES THE REASON, even though no listing request was made.
    // A caller reading `tools` sees `undefined` either way — a server that
    // refused `initialize` and a caller that supplied nothing look identical —
    // and only one of them has an explanation a submitter can act on. Reported
    // as `unreachable` when nothing answered and as an error otherwise, which
    // is the same distinction `dialInitialize` already drew.
    const failed: DirectoryListingEvidence<DirectoryToolEvidence> = {
      entries: [],
      pagesWalked: 0,
      unreachable: initialize.unreachable,
      error: initialize.error,
      complete: false,
    };
    return { initialize, tools: failed };
  }

  const tools =
    request.tools === undefined
      ? await dialToolListing(request, initialize.sessionId)
      : undefined;
  const appResources = request.appHtmlMime
    ? await dialAppResources(
        request,
        request.appHtmlMime,
        request.tools ?? tools?.entries ?? [],
        initialize.sessionId,
      )
    : undefined;

  return { initialize, tools, appResources };
}
