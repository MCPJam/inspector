/**
 * Preview router: serves PR previews at https://pr-<n>.mcpjam.dev (inspector
 * PRs) and https://pr-be-<n>.mcpjam.dev (backend PRs) by forwarding to the
 * preview's Railway service, https://mcp-inspector-pr-<n>.up.railway.app.
 *
 * Why previews get a hostname of our own: WorkOS only accepts one wildcard
 * redirect URI (`https://*.mcpjam.dev/callback`) on a domain we control.
 * `up.railway.app` is a public suffix, so every preview used to register its
 * own Railway URL, and each one had to be deregistered when the preview was
 * deleted. A missed deregistration left a login redirect pointing at a
 * Railway name anyone could claim.
 *
 * Why the router checks identity before every forward: a deleted preview's
 * Railway name can be claimed by anyone, and the sign-in callback carries an
 * authorization code. So the router never trusts the name alone. It sends a
 * random nonce to /__mcpjam/preview-identity and forwards only if the answer
 * is HMAC-SHA256(PREVIEW_EDGE_SECRET, `${nonce}:${upstream host}`). Only our
 * previews hold the secret, and the answer is bound to the preview's own
 * Railway domain, so one live preview can't vouch for another name. If a name
 * has been claimed by someone else, the check fails and the router returns
 * 404. Nothing depends on cleanup running. See
 * mcpjam-inspector/server/routes/preview-identity.ts for the other half.
 */

export interface Env {
  PREVIEW_EDGE_SECRET: string;
  /** Zone the router answers for, e.g. "mcpjam.dev". */
  PREVIEW_ZONE: string;
  /** Railway domain = UPSTREAM_PREFIX + label + UPSTREAM_SUFFIX. */
  UPSTREAM_PREFIX: string;
  UPSTREAM_SUFFIX: string;
}

const LABEL = /^pr-(?:be-)?[0-9]{1,7}$/;
const IDENTITY_PATH = "/__mcpjam/preview-identity";
const NONCE_HEADER = "x-mcpjam-preview-nonce";
// A verified upstream is trusted this long per isolate. It bounds how long a
// just-deleted preview's name could stay trusted if someone claimed it
// immediately.
const VERIFIED_TTL_MS = 30_000;

const verifiedUntil = new Map<string, number>();
const encoder = new TextEncoder();

/** The Railway host for a preview hostname, or null if it isn't one. */
export function upstreamFor(hostname: string, env: Env): string | null {
  const host = hostname.toLowerCase();
  const suffix = `.${env.PREVIEW_ZONE}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (!LABEL.test(label)) return null;
  return `${env.UPSTREAM_PREFIX}${label}${env.UPSTREAM_SUFFIX}`;
}

export async function identityProof(
  secret: string,
  nonce: string,
  domain: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${nonce}:${domain}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameString(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

async function isOurPreview(upstream: string, env: Env): Promise<boolean> {
  const until = verifiedUntil.get(upstream);
  if (until !== undefined && until > Date.now()) return true;

  const nonce = crypto.randomUUID();
  let response: Response;
  try {
    response = await fetch(`https://${upstream}${IDENTITY_PATH}`, {
      headers: { [NONCE_HEADER]: nonce },
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    return false;
  }
  if (response.status !== 200) return false;
  const answer = (await response.text()).trim();
  const expected = await identityProof(env.PREVIEW_EDGE_SECRET, nonce, upstream);
  if (!sameString(answer, expected)) return false;

  verifiedUntil.set(upstream, Date.now() + VERIFIED_TTL_MS);
  return true;
}

function notFound(): Response {
  return new Response("This preview doesn't exist or has been deleted.\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const upstream = upstreamFor(url.hostname, env);
    // The identity endpoint is for the router, not for browsers.
    if (!upstream || url.pathname === IDENTITY_PATH) return notFound();
    if (!env.PREVIEW_EDGE_SECRET || !(await isOurPreview(upstream, env))) return notFound();

    const target = new URL(`${url.pathname}${url.search}`, `https://${upstream}`);
    const headers = new Headers(request.headers);
    // Railway routes by Host, so it must be the upstream's own name; fetch()
    // derives it from the URL. The server builds preview-facing URLs from the
    // Origin header and X-Forwarded-Host.
    headers.delete("host");
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", "https");

    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
      // Never cache through the router: hosted HTML carries per-session
      // bootstrap state.
      cache: "no-store",
    });

    // WebSocket upgrades (terminal, browser stream) pass straight through.
    if (response.status === 101) return response;

    // A redirect to the upstream's own name should keep the browser on the
    // preview hostname.
    const location = response.headers.get("location");
    if (location) {
      let resolved: URL | null = null;
      try {
        resolved = new URL(location, target);
      } catch {
        resolved = null;
      }
      if (resolved && resolved.hostname === upstream) {
        resolved.protocol = "https:";
        resolved.host = url.host;
        const rewritten = new Headers(response.headers);
        rewritten.set("location", resolved.toString());
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: rewritten,
        });
      }
    }
    return response;
  },
};
