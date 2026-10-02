/**
 * The lazy-authentication probe: two unauthenticated tool calls, at most.
 *
 * WHAT IT DOES. Opens its OWN anonymous MCP session — `initialize` with no
 * credentials — lists tools in that session, calls one public read-only tool,
 * then one protected read-only tool, and records exactly how each was
 * answered. The refusal is parsed once, with the shared challenge parser: a
 * 401's `WWW-Authenticate` with `parseChallengeHeader`, a tool result's
 * `_meta["mcp/www_authenticate"]` with `parseToolResultAuthChallenge`.
 *
 * WHAT IT NEVER DOES:
 *
 *   - send a credential. The options it builds carry no `mcpHeaders`, so the
 *     dial's single reader of caller headers has nothing to read, whatever the
 *     surrounding run was given;
 *   - call a tool that is not annotated `readOnlyHint: true`;
 *   - make more than two `tools/call` requests;
 *   - follow up on a refusal. Discovery after a challenge is the gatherer's
 *     job, because which refusals a host follows is a publisher decision.
 *
 * THE ERA. The session is the dial's, pinned to
 * `DIRECTORY_DIAL_PROTOCOL_VERSION`, so the evidence says so: a probe at the
 * session-based revision is not a statement about a stateless one.
 *
 * `fetchFn` IS REQUIRED, with no default, exactly as in `discovery.ts`.
 *
 * Node entry only — exported from `sdk/src/index.ts`, never from `browser.ts`.
 */

import {
  parseChallengeHeader,
  parseToolResultAuthChallenge,
  type AuthChallengeSignal,
} from "../mcp-client-manager/auth-challenge.js";
import {
  DIRECTORY_DIAL_PROTOCOL_VERSION,
  dialInitialize,
  dialToolCall,
  dialToolListing,
  type DirectoryDialOptions,
  type DirectoryToolCallEvidence,
  type DirectoryToolEvidence,
} from "./mcp-dial.js";
import {
  lazyAuthEraNote,
  selectLazyAuthProbeTools,
  type DirectoryLazyAuthCallOutcome,
  type DirectoryLazyAuthProbeEvidence,
  type DirectoryLazyAuthProbeMode,
  type DirectoryLazyAuthToolCall,
  type LazyAuthToolSelection,
} from "./lazy-auth.js";

export interface ProbeLazyAuthenticationOptions {
  /** The endpoint exactly as entered. */
  enteredUrl: string;
  /** The transport. REQUIRED; in a hosted run, the DNS-pinned one. */
  fetchFn: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxListPages?: number;
  maxListEntries?: number;
  /** An ARMED mode, from `resolveLazyAuthProbeMode`. */
  mode: Extract<DirectoryLazyAuthProbeMode, { enabled: true }>;
  /**
   * The listing an earlier dial of this run already holds.
   *
   * Consulted only for a tool the anonymous listing does not show: a server
   * may hide protected tools from anonymous sessions, and the caller may
   * still name one. Its annotations decide read-only-ness exactly as the
   * anonymous listing's would.
   */
  knownTools?: readonly DirectoryToolEvidence[];
}

/** Classify one call and parse its refusal, once. */
function readToolCall(
  call: DirectoryToolCallEvidence,
): Pick<DirectoryLazyAuthToolCall, "outcome" | "status" | "challenge" | "error"> {
  const status = call.status;
  let outcome: DirectoryLazyAuthCallOutcome;
  let challenge: AuthChallengeSignal | undefined;

  if (status === 401) {
    outcome = "unauthorized";
    // A bare 401 is still a signal: the facets record that the header was
    // missing, so a host that needs one can decline to act on it.
    challenge = parseChallengeHeader(call.wwwAuthenticate, "http_401");
  } else if (status === 403) {
    outcome = "forbidden";
    if (call.wwwAuthenticate !== undefined) {
      challenge = parseChallengeHeader(
        call.wwwAuthenticate,
        "http_403_insufficient_scope",
      );
    }
  } else if (status !== undefined && (status < 200 || status >= 300)) {
    outcome = "http-error";
  } else if (call.unreachable) {
    outcome = "unreachable";
  } else if (call.rpcError) {
    outcome = "rpc-error";
  } else if (call.result?.isError) {
    outcome = "tool-error";
    challenge = parseToolResultAuthChallenge({
      isError: true,
      _meta: call.result._meta,
    });
  } else if (call.result) {
    outcome = "succeeded";
  } else {
    outcome = "unreachable";
  }

  return {
    outcome,
    ...(status !== undefined ? { status } : {}),
    ...(challenge ? { challenge } : {}),
    ...(call.error ? { error: call.error } : {}),
  };
}

/**
 * Drive the probe. Never throws for a server's behavior: every refusal, gap
 * and transport failure is recorded on the evidence.
 */
export async function probeLazyAuthentication(
  options: ProbeLazyAuthenticationOptions,
): Promise<DirectoryLazyAuthProbeEvidence> {
  const protocolVersion = DIRECTORY_DIAL_PROTOCOL_VERSION;
  const evidence: DirectoryLazyAuthProbeEvidence = {
    attempted: true,
    protocolVersion,
    eraNote: lazyAuthEraNote(protocolVersion),
  };

  // BUILT FIELD BY FIELD, never spread from the run's options: a spread would
  // carry `mcpHeaders` (or its deprecated alias) along, and the one property
  // this probe has is that it holds no credential.
  const anonymous: DirectoryDialOptions = {
    enteredUrl: options.enteredUrl,
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    maxListPages: options.maxListPages,
    maxListEntries: options.maxListEntries,
  };

  const initialize = await dialInitialize(anonymous);
  evidence.initialize = {
    ok: initialize.ok,
    ...(initialize.status ? { status: initialize.status } : {}),
    ...(initialize.unreachable ? { unreachable: true } : {}),
    ...(initialize.error ? { error: initialize.error } : {}),
    ...(initialize.status === 401
      ? { challenge: parseChallengeHeader(initialize.wwwAuthenticate, "http_401") }
      : initialize.status === 403 && initialize.wwwAuthenticate !== undefined
        ? {
            challenge: parseChallengeHeader(
              initialize.wwwAuthenticate,
              "http_403_insufficient_scope",
            ),
          }
        : {}),
  };
  if (!initialize.ok) {
    const why = initialize.unreachable
      ? "the anonymous initialize could not be reached, so no call was made"
      : initialize.status === 401 || initialize.status === 403
        ? `the server refused an anonymous initialize with HTTP ${initialize.status}, so it signs users in before any call (it is not lazy)`
        : `the anonymous initialize failed (${initialize.error ?? "no result"}), so no call was made`;
    evidence.reason = why;
    evidence.publicCallSkipped = why;
    evidence.protectedCallSkipped = why;
    return evidence;
  }

  const listing = await dialToolListing(anonymous, initialize.sessionId);
  evidence.anonymousToolListing = {
    complete: listing.complete,
    toolCount: listing.entries.length,
    ...(listing.error ? { error: listing.error } : {}),
  };

  // The anonymous listing is authoritative for what an anonymous session can
  // see; the earlier listing only fills in a tool it did not show.
  const listedNames = new Set(listing.entries.map((tool) => tool.name));
  const candidates = [
    ...listing.entries,
    ...(options.knownTools ?? []).filter((tool) => !listedNames.has(tool.name)),
  ];
  const selection: LazyAuthToolSelection<DirectoryToolEvidence> =
    selectLazyAuthProbeTools(options.mode, candidates);

  // At most two calls, in this order: the public one first, so a server that
  // breaks the anonymous session on the protected refusal has already been
  // seen serving a public call.
  let id = 900;
  if (selection.publicTool) {
    const { tool, selectedBy, schemes } = selection.publicTool;
    const call = await dialToolCall(anonymous, tool.name, initialize.sessionId, id++);
    evidence.publicCall = {
      toolName: tool.name,
      selectedBy,
      schemes,
      ...readToolCall(call),
    };
  } else {
    evidence.publicCallSkipped = selection.publicSkipped;
  }

  if (selection.protectedTool) {
    const { tool, selectedBy, schemes } = selection.protectedTool;
    const call = await dialToolCall(anonymous, tool.name, initialize.sessionId, id++);
    evidence.protectedCall = {
      toolName: tool.name,
      selectedBy,
      schemes,
      ...readToolCall(call),
    };
  } else {
    evidence.protectedCallSkipped = selection.protectedSkipped;
  }

  return evidence;
}
