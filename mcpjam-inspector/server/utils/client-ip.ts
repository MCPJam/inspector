import type { Context } from "hono";

// Extract the originating client IP from forwarded-for headers. Order matters:
// - cf-connecting-ip is set by Cloudflare and not spoofable by the client.
// - x-real-ip is set by trusted reverse proxies (Railway, nginx).
// - x-forwarded-for is the legacy fallback; the first entry is the client when
//   the chain is fully trusted, but is mutable by the client when there's no
//   trusted proxy in front. Listed last so a real cf-connecting-ip / x-real-ip
//   wins on the hosted edge.
export function getClientIp(c: Context): string | null {
  const cfConnectingIp = c.req.header("cf-connecting-ip")?.trim();
  if (cfConnectingIp) return cfConnectingIp;

  const realIp = c.req.header("x-real-ip")?.trim();
  if (realIp) return realIp;

  const forwardedFor = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwardedFor) return forwardedFor;

  return null;
}
