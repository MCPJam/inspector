/** Telemetry identifiers only; these never grant access to a resource. */
export type SentryActor = { id: string; kind: "signedIn" | "guest" };
export type SentryIdentity = SentryActor | { id: string; kind: "installation" };

export const SENTRY_ACTOR_CHANNEL = "sentry:set-actor";
export const SENTRY_INSTALLATION_ARGUMENT = "--mcpjam-sentry-installation=";

export function isSentryId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,256}$/.test(value);
}

export function parseSentryActor(
  value: unknown,
): SentryActor | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const actor = value as Record<string, unknown>;
  if (
    !isSentryId(actor.id) ||
    (actor.kind !== "signedIn" && actor.kind !== "guest")
  ) {
    return undefined;
  }
  return { id: actor.id, kind: actor.kind };
}

/** Preserve an opaque ID, never ambient email, name, IP, or arbitrary data. */
export function sentryUserId(user: { id?: unknown } | null | undefined) {
  return isSentryId(user?.id) ? { id: user.id } : undefined;
}
