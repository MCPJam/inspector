import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

// Extract the originating client IP. Order matters:
// - cf-connecting-ip is set by Cloudflare and not spoofable by the client.
// - x-real-ip is set by trusted reverse proxies (Railway, nginx).
// - x-forwarded-for is the legacy fallback; the first entry is the client when
//   the chain is fully trusted, but is mutable by the client when there's no
//   trusted proxy in front. Listed last so a real cf-connecting-ip / x-real-ip
//   wins on the hosted edge.
// - As a last resort (no headers at all), read the TCP connection's peer
//   address. This covers direct-hit runtimes like `npx @mcpjam/inspector`
//   where no upstream proxy injects forwarded-for headers and the request
//   comes straight from the local browser. Hosted deployments behind a real
//   reverse proxy never reach this fallback — one of the header checks above
//   always returns first.
export function getClientIp(c: Context): string | null {
  const cfConnectingIp = c.req.header("cf-connecting-ip")?.trim();
  if (cfConnectingIp) return cfConnectingIp;

  const realIp = c.req.header("x-real-ip")?.trim();
  if (realIp) return realIp;

  const forwardedFor = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwardedFor) return forwardedFor;

  // Node-adapter socket fallback. Wrapped in try/catch because hand-rolled
  // test mocks don't expose the `c.env.incoming.socket` shape `getConnInfo`
  // reads from — falling through to `null` preserves the existing contract
  // for those callers.
  try {
    const address = getConnInfo(c).remote.address?.trim();
    if (address) return address;
  } catch {
    // Not running under @hono/node-server (e.g., unit-test mock context).
  }

  return null;
}

// The header an operator's ingress OVERWRITES on the way in. Not a header it
// merely sets or appends to: `x-forwarded-for` is conventionally appended, so
// naming it only attests the address if this deployment's proxy rewrites the
// whole value.
const TRUSTED_CLIENT_IP_HEADER_ENV = "MCPJAM_TRUSTED_CLIENT_IP_HEADER";

// The address this deployment can VOUCH for, as opposed to the one the request
// claims. `getClientIp` answers "who does this say it is", which is the right
// question for a hint the backend re-validates against its own trust rules. It
// is the wrong question for minting a per-caller rate-limit bucket: a header
// the caller writes is a key the caller rotates, and a limiter keyed on one is
// a memory-exhaustion primitive — enough rotations fill the table and every
// caller who arrives afterwards is refused.
//
// Attested here means "an ingress we trust wrote it, and a client's own copy
// could not have survived":
// - cf-connecting-ip, which Cloudflare rewrites on every hop (the hosted edge;
//   see routes/web/guest-token.ts for the same reliance).
// - Whatever header an operator names in MCPJAM_TRUSTED_CLIENT_IP_HEADER, for
//   a deployment that terminates somewhere other than Cloudflare.
// - The TCP peer, but ONLY with no forwarding header in sight. Behind a proxy
//   the peer IS the proxy, so trusting it there would put every caller in one
//   bucket while claiming to have placed them individually.
//
// Returns null when nothing can be vouched for. A caller must then pool those
// requests into ONE shared bucket rather than keying on the claim — see
// routes/web/bench.ts.
export function getAttestedClientIp(c: Context): string | null {
  const cfConnectingIp = c.req.header("cf-connecting-ip")?.trim();
  if (cfConnectingIp) return cfConnectingIp;

  const trustedHeader =
    process.env[TRUSTED_CLIENT_IP_HEADER_ENV]?.trim().toLowerCase();
  if (trustedHeader) {
    const attested = c.req.header(trustedHeader)?.split(",")[0]?.trim();
    if (attested) return attested;
  }

  if (c.req.header("x-real-ip") || c.req.header("x-forwarded-for")) return null;

  try {
    const address = getConnInfo(c).remote.address?.trim();
    if (address) return address;
  } catch {
    // Not running under @hono/node-server (e.g., unit-test mock context).
  }

  return null;
}
