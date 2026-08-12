/**
 * Unauthenticated discovery preflight for a connection request.
 *
 * A connection request arrives as a bare URL from a surface that has no server
 * row yet, and the first question is always the same: can we talk to this
 * thing, and if not, is the reason one we know how to fix by sending a person
 * to a consent screen? That is all discovery answers. It creates nothing,
 * stores nothing, and carries no credential.
 *
 * The probing itself is the SDK's `probeMcpServer` — the same prober the
 * server doctor runs — not a second one written here. Discovery classification
 * and the Inspector's own diagnostics must agree about what "this server needs
 * OAuth" means, and the only way to guarantee that is for both to ask the same
 * code.
 *
 * The prober rather than the whole doctor, for two reasons. Classification
 * reads `probe` and nothing else — the doctor's tool/resource/prompt
 * enumeration is work discovery never looks at. And the doctor's connect step
 * dials through MCPClientManager's own transport, which takes no `fetchFn`, so
 * it is the one outbound path the egress guard below cannot reach (the same
 * scope limit documented on `routes/shared/conformance.ts`). Dropping it
 * removes an unguarded socket rather than leaving one we would have to
 * apologise for.
 *
 * WHAT THIS MODULE IS NOT. It does not acquire a work lease and it does not
 * report anything to the backend, because at the time of writing there is no
 * wire path for either — see NOTES-item-2.md. It is the half of the discovery
 * step that is fully determined by the Inspector, split out so it is testable
 * on its own and so the endpoint that eventually wraps it has nothing left to
 * decide except the round trips.
 */
import {
  assertOutboundOAuthUrlAllowed,
  OAuthOutboundUrlBlockedError,
} from "@mcpjam/sdk/oauth/node";
import { probeMcpServer } from "@mcpjam/sdk";
import type { ProbeMcpServerResult } from "@mcpjam/sdk";
import {
  BlockedEgressTargetError,
  createGuardedFetch,
  EgressResolutionError,
} from "../utils/hosted-egress-guard.js";

/** The three values the backend's `reportDiscovery` accepts. */
export type DiscoveredAuthMethod = "none" | "oauth" | "unsupported";

/**
 * What one preflight concluded.
 *
 * The three arms are not three flavours of the same thing — they decide who
 * owns the request next:
 *
 *   `discovered` — the backend routes on the auth method. This is the only arm
 *                  that produces a `reportDiscovery` call.
 *   `retryable`  — nobody learned anything. The work lease is released and the
 *                  request stays where it was, so a server that was briefly
 *                  unreachable costs an attempt rather than the whole request.
 *   `terminal`   — the target answered and what it said was not MCP. Retrying
 *                  cannot change that, so it is reported as a failure.
 */
export type DiscoveryOutcome =
  | { kind: "discovered"; authMethod: DiscoveredAuthMethod; detail: string }
  | { kind: "retryable"; detail: string }
  | { kind: "terminal"; errorCode: string; detail: string };

export const DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Whether a 401 is an MCP OAuth challenge we can actually act on.
 *
 * "Can act on" is the operative test, and it is stricter than "mentions
 * OAuth". Sending a user to a consent screen requires knowing where the
 * authorization server is, so a challenge we could not follow is worth exactly
 * as much to us as no challenge at all — and calling it `oauth` would strand
 * the request in `awaiting_authorization` with nowhere to send anyone.
 *
 * That single test covers two of the three unsupported shapes:
 *
 *   Basic/Digest/any non-Bearer scheme — no authorization server is named
 *   because the scheme has no concept of one.
 *
 *   Manual bearer — the server wants a token a human pastes in. It challenges
 *   with `Bearer` and publishes no authorization server metadata, because
 *   there is no flow to run.
 *
 * XAA IS A KNOWN GAP. An XAA server also challenges with `Bearer` and also
 * publishes authorization server metadata, so this test classifies it as
 * `oauth`. Separating the two needs an XAA-specific marker in the discovered
 * metadata, and which marker that should be is not settled — see
 * NOTES-item-2.md. Deliberately left misclassified rather than guessed at: a
 * wrong detector would refuse servers that do work.
 */
function isActionableOAuthChallenge(probe: ProbeMcpServerResult): boolean {
  const { oauth } = probe;
  if (!oauth.required) {
    return false;
  }
  // Either half is enough. `authorizationServerMetadataUrl` is the direct
  // answer; a non-empty strategy list means the discovery already resolved far
  // enough to know how a client would be identified, which it cannot do
  // without having found the server.
  return (
    typeof oauth.authorizationServerMetadataUrl === "string" ||
    oauth.registrationStrategies.length > 0
  );
}

/**
 * Map a completed doctor run onto the discovery taxonomy.
 *
 * Pure, and exported, because the mapping is the part worth pinning: every
 * arm here is a decision about whether a user gets sent to a consent screen,
 * whether the request survives, or whether it dies.
 */
export function classifyDiscoveryResult(
  probe: ProbeMcpServerResult,
): DiscoveryOutcome {
  switch (probe.status) {
    // `initialize` succeeded without credentials: the server is open.
    case "ready":
      return {
        kind: "discovered",
        authMethod: "none",
        detail: "Server completed MCP initialize without authentication",
      };

    case "oauth_required":
      return isActionableOAuthChallenge(probe)
        ? {
            kind: "discovered",
            authMethod: "oauth",
            detail: "Server presented an MCP OAuth challenge",
          }
        : {
            kind: "discovered",
            authMethod: "unsupported",
            detail:
              "Server requires authentication MCPJam cannot negotiate " +
              "(no authorization server metadata was discoverable)",
          };

    // The host answered and the answer was not a usable MCP initialize
    // result. That is a property of the server, not of the moment, so
    // retrying would only spend the request's attempt budget on the same
    // answer.
    case "reachable":
      return {
        kind: "terminal",
        errorCode: "NOT_AN_MCP_SERVER",
        detail:
          probe.error ??
          "Server responded but did not complete an MCP initialize handshake",
      };

    // The probe exhausted its own retry policy without a usable response —
    // DNS, TLS, connection, timeout, or a 5xx that kept repeating. Retryable
    // at the request level, and emphatically not a discovery result: reporting
    // `unsupported` here would permanently mislabel a server that was merely
    // down for a minute.
    case "error":
      return {
        kind: "retryable",
        detail: probe.error ?? "Discovery probe could not reach the server",
      };
  }
}

export interface RunDiscoveryPreflightInput {
  serverUrl: string;
  /**
   * Local-dev opt-in, carved out for loopback ONLY. Hosted deployments pass
   * false (the default) and stay HTTPS-only against public addresses; it never
   * relaxes the guard for LAN, link-local, CGNAT, multicast, documentation,
   * NAT64-private, or IPv4-mapped-private targets.
   */
  allowLoopback?: boolean;
  timeoutMs?: number;
}

export interface RunDiscoveryPreflightDependencies {
  probeServer?: typeof probeMcpServer;
  /** Overridable so tests can drive the guard's verdicts without DNS. */
  fetchFn?: typeof fetch;
}

/**
 * Run one bounded, unauthenticated preflight and classify it.
 *
 * SSRF DEFENCE IS TWO LAYERS, AND ONE ALONE IS NOT ENOUGH.
 *
 * `assertOutboundOAuthUrlAllowed` is a pure RFC 6890 classifier over the URL's
 * hostname. It refuses a literal private, loopback, link-local, CGNAT,
 * multicast, documentation, NAT64-private or IPv4-mapped-private target, and a
 * non-http(s) scheme, before any socket exists. What it CANNOT do — as
 * `@mcpjam/sdk/oauth/node` says of it in as many words — is judge a bare public
 * hostname: `evil.example` passes the classifier and can still resolve to
 * 169.254.169.254. Classification alone leaves the rebinding window open.
 *
 * So the probe dials through `createGuardedFetch`, which resolves the hostname,
 * refuses private answers, and re-checks EVERY redirect hop against the same
 * rules. The redirect half is not optional: a caller does not have to name the
 * address they want reached — they can name a host they control and have it
 * answer `302 Location: http://169.254.169.254/`, and a guard that inspects
 * only the first URL is a guard against typos.
 *
 * Known residual gap, accepted repo-wide rather than invented here: the guard
 * validates the DNS answer and the HTTP client then resolves again, so a
 * check-vs-connect (TOCTOU) window remains. `hosted-egress-guard.ts` documents
 * that punt for every egress path in this server; closing it needs connection
 * pinning at the infra layer, not a second private copy here.
 *
 * A blocked target is TERMINAL, not retryable — the address a URL names will
 * not become public on the next attempt. A resolver OUTAGE is retryable: DNS
 * blipping is not a verdict about the user's server, and treating it as one
 * would permanently fail a request over our own infrastructure trouble.
 *
 * No credential is ever attached. Discovery asks what a stranger sees.
 */
export async function runDiscoveryPreflight(
  input: RunDiscoveryPreflightInput,
  dependencies: RunDiscoveryPreflightDependencies = {},
): Promise<DiscoveryOutcome> {
  const probeServer = dependencies.probeServer ?? probeMcpServer;

  try {
    assertOutboundOAuthUrlAllowed(input.serverUrl, {
      allowLoopback: input.allowLoopback === true,
    });
  } catch (error) {
    if (error instanceof OAuthOutboundUrlBlockedError) {
      return {
        kind: "terminal",
        errorCode: "URL_NOT_ALLOWED",
        // The guard's own message names the reason (invalid-url,
        // invalid-scheme, private-host) without echoing anything the caller
        // could use to probe the internal network further.
        detail: error.message,
      };
    }
    throw error;
  }

  // The prober CATCHES whatever `fetchFn` throws and reports it as
  // `status: "error"`, which classifies as retryable. That is right for a
  // timeout and wrong for an egress refusal — it would put an SSRF attempt on
  // a retry schedule. So the guard's verdict is recorded on the way past and
  // consulted before the probe's own account of what happened.
  const refusal: { blocked: BlockedEgressTargetError | null } = {
    blocked: null,
  };
  const guarded = dependencies.fetchFn ?? createGuardedFetch();
  const fetchFn: typeof fetch = async (target, init) => {
    try {
      return await guarded(target, init);
    } catch (error) {
      if (error instanceof BlockedEgressTargetError) {
        refusal.blocked = error;
      }
      throw error;
    }
  };

  let probe: ProbeMcpServerResult;
  try {
    probe = await probeServer({
      url: input.serverUrl,
      timeoutMs: input.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
      fetchFn,
    });
  } catch (error) {
    if (error instanceof BlockedEgressTargetError) {
      return {
        kind: "terminal",
        errorCode: "URL_NOT_ALLOWED",
        detail: error.message,
      };
    }
    if (error instanceof EgressResolutionError) {
      return { kind: "retryable", detail: error.message };
    }
    // An unexpected throw means we learned nothing about the target, which is
    // the definition of retryable here — never a discovery result.
    return {
      kind: "retryable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (refusal.blocked !== null) {
    return {
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
      detail: refusal.blocked.message,
    };
  }

  return classifyDiscoveryResult(probe);
}
