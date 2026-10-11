import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, Next } from "hono";
import { getDesktopSentryIdentity } from "../../shared/desktop-sentry-state.js";
import {
  isSentryId,
  type SentryIdentity,
} from "../../shared/sentry-identity.js";

type IdentitySource = () => SentryIdentity | null;
const identities = new AsyncLocalStorage<IdentitySource>();

export function runWithSentryIdentity<T>(
  source: IdentitySource,
  work: () => T,
): T {
  return identities.run(source, work);
}

export function bindSentryIdentity<T extends (...args: never[]) => unknown>(
  work: T,
): T {
  const source = identities.getStore();
  return ((...args: Parameters<T>) =>
    source ? identities.run(source, () => work(...args)) : work(...args)) as T;
}

export function sentryIdentityMetadata() {
  const source = identities.getStore();
  if (!source) return {};
  const identity = source();
  // Mark unknown requests explicitly; the central logger clears ambient scope data.
  return {
    user: identity ? { id: identity.id } : {},
    tags: { actor_kind: identity?.kind },
  };
}

export function sentryRequestIdentityMiddleware(c: Context, next: Next) {
  const desktop = getDesktopSentryIdentity();
  return runWithSentryIdentity(() => {
    const context = c.var.requestLogContext;
    const userId = c.get("workosUserId") ?? context?.userExternalId;
    if (isSentryId(userId)) return { id: userId, kind: "signedIn" };
    const guestId = c.get("guestId") ?? context?.guestExternalId;
    if (isSentryId(guestId)) return { id: guestId, kind: "guest" };
    return c.get("bridgeCaller") === "local" ? desktop : null;
  }, next);
}
