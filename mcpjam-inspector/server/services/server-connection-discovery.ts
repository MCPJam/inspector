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
  isLoopbackOAuthUrl,
  isPrivateHost,
  OAuthOutboundUrlBlockedError,
} from "@mcpjam/sdk/oauth/node";
import { probeMcpServer } from "@mcpjam/sdk";
import type { ProbeMcpServerResult } from "@mcpjam/sdk";
import {
  BlockedEgressTargetError,
  EgressResolutionError,
} from "../utils/hosted-egress-guard.js";
import { createPinnedFetch } from "../utils/pinned-fetch.js";
import { HOSTED_MODE } from "../config.js";

/**
 * Whether this preflight may reach a private destination.
 *
 * One helper rather than three copies of the `??`, so the pre-flight guard,
 * the plaintext rule, the transport, and the probe cannot disagree about a
 * single request — the shape of bug where discovery succeeds and the probe it
 * authorized is then refused.
 */
function allowsPrivateNetwork(input: RunDiscoveryPreflightInput): boolean {
  // `!HOSTED_MODE &&` rather than a default the caller can override: hosted is
  // OUR network, and an argument arriving from a route body must not be able to
  // open egress there. Locally the caller keeps both directions — the default
  // is on, and an explicit `false` (registry derive, benchmark probes) is
  // honoured.
  return !HOSTED_MODE && (input.allowPrivateNetwork ?? true);
}

/** The three values the backend's `reportDiscovery` accepts. */
export type DiscoveredAuthMethod = "none" | "oauth" | "unsupported";

/**
 * The transport a real preflight uses: DNS-pinned, redirect-revalidating, and
 * bounded by the same timeout the probe is given.
 *
 * Built per call rather than once at module scope so `allowLoopback` and the
 * timeout come from the request being served, not from whichever request
 * happened to construct it first.
 */
function createDefaultDiscoveryFetch(
  input: RunDiscoveryPreflightInput,
): typeof fetch {
  return createPinnedFetch({
    allowLoopback: input.allowLoopback === true,
    allowPrivateNetwork: allowsPrivateNetwork(input),
    timeoutMs: clampTimeout(input.timeoutMs),
  });
}

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

/** Per-request timeout handed to the prober. */
export const DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Ceiling on a caller-supplied per-request timeout.
 *
 * `timeoutMs` bounds ONE request, and a probe makes several (initialize, an
 * SSE fallback, resource metadata, authorization server metadata), each of
 * which may be retried. An uncapped value therefore multiplies into the wall
 * time a single preflight can occupy a worker.
 */
export const MAX_DISCOVERY_TIMEOUT_MS = 30_000;

/**
 * Absolute ceiling on one preflight, whatever the per-request timeout allows.
 *
 * This is the bound that actually makes the step "bounded": without it a
 * deliberately slow target holds a work lease for the sum of every request the
 * probe chooses to make, and the lease — not the timeout — becomes what limits
 * throughput.
 */
export const DISCOVERY_DEADLINE_MS = 60_000;

function clampTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return DISCOVERY_TIMEOUT_MS;
  }
  return Math.min(Math.max(timeoutMs, 1), MAX_DISCOVERY_TIMEOUT_MS);
}

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
 *
 * DO NOT ADD `registrationStrategies.length > 0` BACK AS AN ALTERNATIVE. An
 * earlier revision accepted it as a second sufficient condition, which
 * inverted the whole test: `server-probe.ts` returns
 * `registrationStrategies: ["preregistered"]` from the branch it takes when
 * metadata discovery THREW — so that list is non-empty in precisely the
 * manual-bearer and unknown-scheme cases this function exists to reject, and
 * `unsupported` became unreachable.
 */
function isActionableOAuthChallenge(probe: ProbeMcpServerResult): boolean {
  const { oauth } = probe;
  if (!oauth.required) {
    return false;
  }
  // The ONLY sufficient signal: somewhere to send the user. Without an
  // authorization server we cannot start a flow, and reporting `oauth` would
  // park the request in `awaiting_authorization` with no consent screen to
  // open.
  if (
    typeof oauth.authorizationServerMetadataUrl !== "string" ||
    oauth.authorizationServerMetadataUrl.length === 0
  ) {
    return false;
  }
  return challengeOffersBearer(oauth.wwwAuthenticate);
}

/**
 * Does the challenge offer a Bearer scheme?
 *
 * MCP OAuth challenges with `Bearer`. A server answering `Basic` has no
 * authorization-code flow to run even if something OAuth-shaped happens to sit
 * at its well-known URL, so the scheme is checked rather than inferred from the
 * metadata alone.
 *
 * A missing header is treated as permissive: some servers 401 with no
 * challenge at all while still publishing usable metadata, and the metadata
 * requirement above already carries the decision in that case.
 *
 * `WWW-Authenticate` may carry several challenges, comma-separated
 * (`Basic realm="x", Bearer resource_metadata="…"`), so a scheme is matched at
 * the start of the header or just after a comma rather than anywhere in the
 * string — otherwise a realm containing the word "bearer" would qualify. A
 * quoted parameter containing a comma could still fool this; it would need to
 * coincide with genuinely discovered authorization server metadata to change
 * any outcome, which is not a combination worth a full RFC 9110 parser here.
 */
function challengeOffersBearer(wwwAuthenticate: string | undefined): boolean {
  if (wwwAuthenticate === undefined || wwwAuthenticate.trim() === "") {
    return true;
  }
  return /(?:^|,)\s*bearer(?:\s|,|$)/i.test(wwwAuthenticate);
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
  /**
   * Permit private destinations (loopback, RFC 1918, CGNAT, unique-local).
   * Defaults to `!HOSTED_MODE`: locally, probing a server on the developer's
   * own network is the product. Callers for whom a private target is never
   * evidence — registry derive, benchmark scorecards — pass `false`.
   */
  allowPrivateNetwork?: boolean;
  timeoutMs?: number;
}

export interface RunDiscoveryPreflightDependencies {
  probeServer?: typeof probeMcpServer;
  /** Overridable so tests can drive the guard's verdicts without DNS. */
  fetchFn?: typeof fetch;
  /**
   * Test seam only. The deadline is a product decision, not a caller knob —
   * it lives here rather than on the input so no route can quietly extend the
   * bound this step exists to enforce. Tests override it to exercise the
   * deadline path without waiting a real minute.
   */
  deadlineMs?: number;
}

/**
 * Run one bounded, unauthenticated preflight and classify it.
 *
 * The dialing — and every SSRF decision in it — belongs to
 * `probeThroughEgressGuard` below. All that is left here is the mapping from
 * "what the target did" to "who owns the request next", which
 * `classifyDiscoveryResult` owns in turn. A `refused` guard verdict is
 * TERMINAL rather than retryable, because the address a URL names does not
 * become public on the next attempt.
 */
export async function runDiscoveryPreflight(
  input: RunDiscoveryPreflightInput,
  dependencies: RunDiscoveryPreflightDependencies = {},
): Promise<DiscoveryOutcome> {
  const guarded = await probeThroughEgressGuard(input, dependencies);
  switch (guarded.kind) {
    case "refused":
      return {
        kind: "terminal",
        errorCode: guarded.errorCode,
        detail: guarded.detail,
      };
    case "unreachable":
      return { kind: "retryable", detail: guarded.detail };
    case "probed":
      return classifyDiscoveryResult(guarded.probe);
  }
}

/**
 * What one guarded probe attempt produced, BEFORE anyone decides what it
 * means.
 *
 * Split out from `runDiscoveryPreflight` because a second caller needs the
 * probe itself, not the discovery verdict: the org-registry derive route reads
 * the server's name, version and registration strategies off it. The
 * alternative — a second module that dials a user-supplied URL — is the one
 * thing this file's header rules out, because the SSRF ordering below is
 * subtle enough that two copies would drift and only one of them would be
 * fixed.
 *
 * The three arms carry the security decision, and only the naming is new:
 *
 *   `refused`     — the egress guard said no. TERMINAL everywhere: the address
 *                   a URL names does not become public on the next attempt.
 *   `unreachable` — nobody learned anything (DNS blip, stall, deadline).
 *   `probed`      — the target answered; what it said is the caller's to read.
 */
export type GuardedProbeResult =
  | { kind: "probed"; probe: ProbeMcpServerResult }
  | { kind: "refused"; errorCode: string; detail: string }
  | { kind: "unreachable"; detail: string };

/**
 * Run one bounded, unauthenticated probe through the egress guard.
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
 * So the probe dials through the SDK's PINNED transport (`utils/pinned-fetch`,
 * over `@mcpjam/sdk/oauth/node`), which resolves the hostname once, refuses
 * private answers, pins the surviving addresses into the socket, and re-checks
 * EVERY redirect hop against the same rules. The redirect half is not optional:
 * a caller does not have to name the address they want reached — they can name
 * a host they control and have it answer `302 Location:
 * http://169.254.169.254/`, and a guard that inspects only the first URL is a
 * guard against typos.
 *
 * PINNING IS WHY THIS DOES NOT USE `createGuardedFetch` like the rest of the
 * server. That guard validates the DNS answer and then lets the HTTP client
 * resolve a second time — its own docblock says so — leaving a check-vs-connect
 * (TOCTOU) window. That punt is defensible for egress to hosts we chose; it is
 * not defensible here, where the hostname is supplied by whoever is asking us
 * to connect a server. The SDK entry that closes the window shipped one day
 * before this module and was always the intended transport.
 *
 * A blocked target is TERMINAL, not retryable — the address a URL names will
 * not become public on the next attempt. A resolver OUTAGE is retryable: DNS
 * blipping is not a verdict about the user's server, and treating it as one
 * would permanently fail a request over our own infrastructure trouble.
 *
 * No credential is ever attached. Discovery asks what a stranger sees.
 */
export async function probeThroughEgressGuard(
  input: RunDiscoveryPreflightInput,
  dependencies: RunDiscoveryPreflightDependencies = {},
): Promise<GuardedProbeResult> {
  const probeServer = dependencies.probeServer ?? probeMcpServer;

  try {
    const url = assertOutboundOAuthUrlAllowed(input.serverUrl, {
      allowLoopback: input.allowLoopback === true,
      allowPrivateNetwork: allowsPrivateNetwork(input),
    });
    // The classifier accepts http AND https — it judges addresses, not
    // transport. Hosted targets are HTTPS-only, so that has to be enforced
    // here rather than assumed: a plaintext probe to a public host puts the
    // request on the wire for anyone on the path, and the 401 challenge we
    // classify on is exactly the thing worth tampering with.
    //
    // Loopback keeps its plaintext exception, and only when the caller opted
    // in: `http://127.0.0.1:3000/mcp` IS the local-development product.
    if (
      url.protocol !== "https:" &&
      !isLoopbackOAuthUrl(input.serverUrl) &&
      // Same exception one range wider in local mode: a LAN MCP server is
      // plaintext as routinely as a loopback one.
      //
      // LIMITED TO ADDRESS LITERALS, because this check runs before any
      // resolution and `isPrivateHost` only judges the string: `http://10.0.0.5/mcp`
      // is probed, `http://raspberrypi.local:3000/mcp` is still refused here.
      // The transport behind this decides the same question on the resolved
      // address, so it is stricter than the transport rather than looser —
      // a refusal, never a hole. Widening it needs a resolution step this
      // pre-flight does not have; see the plaintext rule in `pinned-dns.ts`.
      !(allowsPrivateNetwork(input) && isPrivateHost(url.hostname))
    ) {
      return {
        kind: "refused",
        errorCode: "URL_NOT_ALLOWED",
        detail: `Refusing a plaintext discovery probe to public host "${url.hostname}"; MCP servers must be reachable over HTTPS.`,
      };
    }
  } catch (error) {
    if (error instanceof OAuthOutboundUrlBlockedError) {
      return {
        kind: "refused",
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
  const guarded = dependencies.fetchFn ?? createDefaultDiscoveryFetch(input);
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

  /**
   * A recorded refusal OUTRANKS every retryable outcome, so this runs before
   * each of them rather than only on the happy path.
   *
   * The ordering is the whole security property. The prober swallows the
   * guard's throw and carries on to another endpoint; if that one then stalls
   * or fails, the natural answer is `retryable` — and returning it would put a
   * target we already refused back on a retry schedule, which is exactly what
   * the bookkeeping exists to prevent. An earlier revision checked this only
   * after the race, so the deadline and the generic catch could both mask a
   * refusal.
   */
  const refusalOutcome = (): GuardedProbeResult | null =>
    refusal.blocked === null
      ? null
      : {
          kind: "refused",
          errorCode: "URL_NOT_ALLOWED",
          detail: refusal.blocked.message,
        };

  // `timeoutMs` bounds ONE request and the probe makes several, so the clamp
  // alone does not bound the step — the deadline below does. A target that
  // stalls every request would otherwise hold a work lease for the sum of them.
  const deadlineMs = dependencies.deadlineMs ?? DISCOVERY_DEADLINE_MS;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    deadlineTimer = setTimeout(() => resolve("deadline"), deadlineMs);
  });

  let probe: ProbeMcpServerResult;
  try {
    const raced = await Promise.race([
      probeServer({
        url: input.serverUrl,
        timeoutMs: clampTimeout(input.timeoutMs),
        fetchFn,
        allowPrivateNetwork: allowsPrivateNetwork(input),
      }),
      deadline,
    ]);

    if (raced === "deadline") {
      // The probe keeps running to completion — the SDK's config takes no
      // abort signal, so there is nothing to cancel from here. It holds a
      // socket and its own per-request timeout, and its result is dropped;
      // propagating a real deadline would need `ProbeMcpServerConfig` to accept
      // one, which is an SDK change and not this PR's to make.
      //
      // A refusal recorded BEFORE the stall still decides the outcome. One
      // arriving after this point is lost, and that is a cost rather than a
      // hole: the guard refused the hop either way, so nothing was reached —
      // the only consequence is that we may retry work that will be refused
      // again.
      return (
        refusalOutcome() ?? {
          kind: "unreachable",
          detail: `Discovery did not finish within ${deadlineMs}ms`,
        }
      );
    }
    probe = raced;
  } catch (error) {
    if (error instanceof BlockedEgressTargetError) {
      return {
        kind: "refused",
        errorCode: "URL_NOT_ALLOWED",
        detail: error.message,
      };
    }
    if (error instanceof EgressResolutionError) {
      return refusalOutcome() ?? { kind: "unreachable", detail: error.message };
    }
    // An unexpected throw means we learned nothing about the target, which is
    // the definition of retryable here — never a discovery result. A refusal
    // already on record still outranks it.
    return (
      refusalOutcome() ?? {
        kind: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      }
    );
  } finally {
    // Otherwise the pending timer keeps the event loop alive for the full
    // deadline after an answer has already been returned.
    clearTimeout(deadlineTimer);
  }

  const recorded = refusalOutcome();
  if (recorded !== null) {
    return recorded;
  }

  return { kind: "probed", probe };
}
