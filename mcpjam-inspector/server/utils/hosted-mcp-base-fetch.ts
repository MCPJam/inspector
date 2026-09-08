/**
 * The one outbound transport every HOSTED MCP client manager dials through.
 *
 * WHY THIS EXISTS. `MCPClientManager` resolves its transport fetch as
 * `config.baseFetch ?? this.defaultBaseFetch` and falls back to the global when
 * both are absent, so a manager built without either dials `globalThis.fetch`:
 * no address classification, and redirects followed by the HTTP client with
 * nothing checking where they land. The conformance and readiness lanes have
 * passed a pinned fetch in since the seam existed; the hosted connection
 * factories never did, and every `/api/web/*` MCP operation went out that way.
 * That is pentest finding MJ-001 — a caller stores a server URL, asks us to
 * connect, and reads the answer back out of the response.
 *
 * The guard itself is not new and is not written here. `createStreamingPinnedFetch`
 * resolves once, refuses the disallowed answers, pins the surviving address into
 * the socket, and re-runs all of it on every redirect hop. This module exists so
 * there is ONE place that decides what a hosted MCP connection dials through,
 * rather than six construction sites each deciding it independently — which is
 * how five of them came to decide nothing at all.
 *
 * STREAMING, NOT BUFFERING. `createPinnedFetch` (the sibling) reads the whole
 * body before returning; an MCP session is `text/event-stream` and would break
 * outright. The timeouts below mirror `createConformanceFetch`, for the same
 * reason it gives: an MCP connection is long-lived and a conforming server may
 * legitimately say nothing for a long time, so the deadline that can apply is an
 * idle one, never a total one.
 *
 * A NO-OP OUTSIDE HOSTED MODE. `createStreamingPinnedFetch` returns bare `fetch`
 * when `!HOSTED_MODE`, and `routes/web/**` is mounted on the desktop app too —
 * reaching `http://localhost:3000/mcp` there is the entire product. The gating
 * lives inside the factory rather than at any call site so a local connection
 * cannot be broken by a caller that forgets to ask.
 */

import { isBlockedEgressHost } from "./hosted-egress-guard.js";
import { HOSTED_MODE } from "../config.js";
import { createStreamingPinnedFetch } from "./pinned-fetch.js";
import { resolvePlatformMcpUrl } from "./platform-mcp-url.js";

/**
 * DNS + connect + response headers, summed across one request's redirect chain.
 *
 * Matched to `createConformanceFetch`, which matched it to undici's
 * `headersTimeout` — the bound these connections already had from the global
 * `fetch`. Closing an SSRF hole is not a reason to start failing servers that
 * connected fine yesterday.
 */
const MCP_CHAIN_TIMEOUT_MS = 300_000;
/**
 * No bytes for this long on an OPEN stream ⇒ dead, not slow.
 *
 * MCP requires no SSE keepalives, so a conforming notification stream is
 * allowed to stay silent while a long tool call runs. A total deadline here
 * would disconnect healthy sessions; an idle one only reaps stalled ones.
 */
const MCP_BODY_IDLE_TIMEOUT_MS = 300_000;
/** Cumulative decompressed body cap for one request. */
const MCP_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Build the transport fetch for a hosted MCP client manager.
 *
 * Pass on `MCPClientManagerOptions.baseFetch` — the MANAGER DEFAULT, not a
 * per-server config field. Resolution happens when a transport is built rather
 * than when the manager is constructed, so the default also covers servers
 * attached later through `connectToServer`, and a per-server `baseFetch` still
 * wins where one is set deliberately (the conformance runners set their own).
 */
export function hostedMcpBaseFetch(): typeof fetch {
  return createStreamingPinnedFetch({
    targetLabel: "MCP server",
    chainTimeoutMs: MCP_CHAIN_TIMEOUT_MS,
    bodyIdleTimeoutMs: MCP_BODY_IDLE_TIMEOUT_MS,
    maxResponseBytes: MCP_MAX_RESPONSE_BYTES,
  });
}

/**
 * The first-party MCP URLs this process would dial for its own agent surfaces,
 * and the only ones that can vary: the platform worker (an environment table,
 * whose `local`/`dev`/`test` rows are `http://localhost:8787/mcp`) plus three
 * operator overrides. The docs and spec defaults are public https literals, so
 * they cannot be the private value — a unit test pins them.
 */
function varyingFirstPartyMcpUrls(): Array<{ label: string; url: string }> {
  const entries: Array<{ label: string; url: string }> = [
    { label: "platform MCP worker", url: resolvePlatformMcpUrl() },
  ];
  for (const [label, value] of [
    ["MCPJAM_DOCS_MCP_URL", process.env.MCPJAM_DOCS_MCP_URL],
    ["MCPJAM_SPEC_MCP_URL", process.env.MCPJAM_SPEC_MCP_URL],
  ] as const) {
    // ANY DEFINED VALUE IS CHECKED, verbatim and untrimmed. The consumers read
    // these as `process.env.X ?? DEFAULT`, so a whitespace-only override is
    // truthy there and gets dialled as-is — skipping it here because it trims
    // to empty would validate the default while the manager used the invalid
    // value, which is the exact split this assertion exists to prevent.
    if (value !== undefined) entries.push({ label, url: value });
  }
  return entries;
}

/**
 * Schemes the pinned transport will dial for a PUBLIC target.
 *
 * Checked at boot for the same reason the addresses are: the guard refuses
 * plaintext to a non-private host, so an `http://` first-party override is a
 * connection that fails on every agent request. Catching only the hostname
 * would let the deployment start and then refuse its own servers — the
 * "loud at startup" promise, quietly half-kept.
 */
const ALLOWED_FIRST_PARTY_PROTOCOL = "https:";

/**
 * Refuse to start a HOSTED process whose own first-party MCP servers resolve to
 * an address {@link hostedMcpBaseFetch} will not dial.
 *
 * WHY AT BOOT. Guarding the agent managers means these URLs go through the same
 * classification as a caller-supplied one. That is the point — no permanent
 * `allowLoopback` hole in the four managers this change exists to close — but it
 * makes a misconfiguration that used to produce a quietly broken agent panel
 * into a connection that is refused mid-turn. Failing at startup instead names
 * the variable, once, before any traffic arrives.
 *
 * It is also true independently of MJ-001: a hosted deployment pointing its own
 * platform worker at loopback is misconfigured whatever the egress policy says.
 *
 * LITERAL CLASSIFICATION ONLY, no DNS — boot must not depend on a resolver, and
 * every value this can catch is an address or a hostname we chose. The runtime
 * guard still does the resolving pass.
 */
export function assertHostedFirstPartyMcpUrls(): void {
  if (!HOSTED_MODE) return;
  for (const { label, url } of varyingFirstPartyMcpUrls()) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(
        `Refusing to start: the ${label} URL is not a valid URL. Hosted deployments must point first-party MCP servers at a publicly routable https host.`
      );
    }
    // ADDRESS BEFORE SCHEME, because a private address is the likelier
    // misconfiguration and its message names the variable to fix. A loopback
    // platform URL is also plaintext, so checking the scheme first would
    // answer a wrong-`ENVIRONMENT` deployment with a lecture about https.
    const hostname = parsed.hostname;
    if (isBlockedEgressHost(hostname, true)) {
      throw new Error(
        `Refusing to start: the ${label} URL points at "${hostname}", which hosted egress will not dial. Set ENVIRONMENT to the deployment's real environment, or point this override at a publicly routable host.`
      );
    }
    if (parsed.protocol !== ALLOWED_FIRST_PARTY_PROTOCOL) {
      throw new Error(
        `Refusing to start: the ${label} URL uses "${parsed.protocol}", which hosted egress will not dial to a public host. Use https.`
      );
    }
  }
}
