export const SANDBOX_VIEW_DENY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'";

export function sandboxViewHeaders(policy: string): Record<string, string> {
  return {
    "Content-Security-Policy": policy,
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
    "Origin-Agent-Cluster": "?1",
    "X-Content-Type-Options": "nosniff",
  };
}
