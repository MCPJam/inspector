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
