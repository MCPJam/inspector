/**
 * Unauthenticated discovery preflight for a connection request.
 *
 * A connection request arrives as a bare URL from a surface that has no server
 * row yet, and the first question is always the same: can we talk to this
 * thing, and if not, is the reason one we know how to fix by sending a person
 * to a consent screen? That is all discovery answers. It creates nothing,
 * stores nothing, and carries no credential.
 *
 * The probing itself is the SDK's `runServerDoctor`, not a second prober
 * written here. Discovery classification and the Inspector's own diagnostics
 * must agree about what "this server needs OAuth" means, and the only way to
 * guarantee that is for both to ask the same code.
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
import { runServerDoctor } from "@mcpjam/sdk";
import type { ServerDoctorResult } from "@mcpjam/sdk";

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
function isActionableOAuthChallenge(
  probe: NonNullable<ServerDoctorResult["probe"]>,
): boolean {
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
  result: ServerDoctorResult,
): DiscoveryOutcome {
  const probe = result.probe;

  // No probe at all means the doctor threw before reaching the target.
  if (!probe) {
    return {
      kind: "retryable",
      detail: result.error?.message ?? "Discovery probe did not complete",
    };
  }

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
  runDoctor?: typeof runServerDoctor;
}

/**
 * Run one bounded, unauthenticated preflight and classify it.
 *
 * The SSRF guard runs FIRST, before any socket exists. The URL came from a
 * caller on an untrusted surface, and a hosted Inspector sits inside a network
 * where "http://169.254.169.254/" is a credential endpoint — so the cheapest
 * possible moment to refuse is before we have connected to anything. A refusal
 * is terminal rather than retryable: the address a URL names is not going to
 * become public on the next attempt.
 *
 * No credential is ever attached. Discovery asks what a stranger sees.
 */
export async function runDiscoveryPreflight(
  input: RunDiscoveryPreflightInput,
  dependencies: RunDiscoveryPreflightDependencies = {},
): Promise<DiscoveryOutcome> {
  const runDoctor = dependencies.runDoctor ?? runServerDoctor;

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

  const result = await runDoctor({
    config: { url: input.serverUrl },
    target: null,
    timeout: input.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
  });

  return classifyDiscoveryResult(result);
}
