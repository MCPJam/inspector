import type { Context } from "hono";
import { logger } from "./logger.js";
import {
  getLocalSessionNamespace,
  type LocalSessionNamespace,
} from "./local-session-namespace.js";
import {
  planScopedCookieHeaders,
  readScopedCookie,
  type ScopedCookieKind,
  type ScopedCookieWrite,
} from "./scoped-cookies.js";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Does this request use per-namespace session cookies?
 *
 * Yes for an Inspector reached on a loopback host, which is where several
 * instances share one cookie host (including `npm run dev:hosted`, which runs
 * hosted mode on `localhost`). A deployment reached on its own hostname keeps
 * its single `__Host-` cookies: it is one instance on one origin. This is the
 * same local/remote split the session cookies always made; the answer picks a
 * cookie MODE only — the namespace itself never comes from the request.
 */
export function usesScopedSessionCookies(c: Context): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(c.req.url).hostname);
  } catch {
    return false;
  }
}

/**
 * Scoped cookies are never `Secure`, not even on `https://localhost`.
 *
 * They exist on loopback hosts only, which browsers already treat as secure
 * contexts, so the attribute buys nothing there. It would cost something: a
 * cookie an https instance wrote WITH `Secure` cannot be touched by a
 * plain-http instance on the same host (browsers refuse to let an insecure
 * origin overwrite or delete a Secure cookie), so that instance's pruning
 * would be silently dropped and the namespace/byte budgets would stop holding
 * the moment two instances disagree on the scheme.
 */
const SCOPED_COOKIES_SECURE = false;

export function currentNamespace(): LocalSessionNamespace {
  return getLocalSessionNamespace();
}

/** This namespace's raw (still sealed) cookie of `kind`, if the browser sent one. */
export function readOwnScopedCookie(
  c: Context,
  kind: ScopedCookieKind,
): string | null {
  return readScopedCookie(c.req.header("cookie"), kind, currentNamespace().id);
}

/**
 * Append this namespace's cookie writes to the response, plus whatever
 * deletions keep the browser within the scoped-cookie budgets. Pruning is
 * logged by namespace id and count only — never a cookie value.
 */
export function applyScopedCookieWrites(
  c: Context,
  writes: ScopedCookieWrite[],
): void {
  const ns = currentNamespace();
  const plan = planScopedCookieHeaders({
    cookieHeader: c.req.header("cookie"),
    nsId: ns.id,
    writes,
    nowMs: Date.now(),
    secure: SCOPED_COOKIES_SECURE,
  });
  for (const header of plan.setCookies) {
    c.header("Set-Cookie", header, { append: true });
  }
  if (plan.prunedNamespaces.length > 0) {
    logger.info("Pruned local session cookies for other Inspector instances", {
      event: "auth.local_session_cookies_pruned",
      namespace: ns.id,
      prunedCount: plan.prunedNamespaces.length,
    });
  }
  if (plan.overBudget) {
    logger.warn("Local session cookies exceed their byte budget", {
      event: "auth.local_session_cookies_over_budget",
      namespace: ns.id,
    });
  }
}
