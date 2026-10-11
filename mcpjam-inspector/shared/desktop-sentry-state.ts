import type { SentryActor, SentryIdentity } from "./sentry-identity.js";

// Import-safe for the embedded server: no Electron, env reads, or SDK init.
let installation: SentryIdentity | null = null;
let current: SentryIdentity | null = null;

export function initializeDesktopSentryIdentity(id: string): SentryIdentity {
  installation = { id, kind: "installation" };
  current = installation;
  return { ...current };
}

export function setDesktopSentryActor(actor: SentryActor | null) {
  current = actor ? { ...actor } : installation;
  return getDesktopSentryIdentity();
}

export function getDesktopSentryIdentity(): SentryIdentity | null {
  return current ? { ...current } : null;
}
