export type ConnectionIntent =
  | { kind: "add" }
  | { kind: "replace"; credentialId: string };
export interface OAuthConnection {
  connectionId: string;
  label?: string;
  profile?: {
    id: string;
    name?: string;
    email?: string;
    nickname?: string;
    capturedAt?: number;
  };
  isDefault: boolean;
  needsReauth?: boolean;
  authorizedAt?: number;
  expiresAt?: number;
}
export interface AuthorizedOAuthConnection extends OAuthConnection {
  /** Canonical per-account timestamp, including the legacy createdAt fallback. */
  credentialAuthorizedAt?: number;
  accessToken?: string | null;
  unavailableReason?: string;
  /**
   * Built by the Inspector from the authorize result's default credential, not
   * listed by the backend (it lists accounts only when there are two or more).
   * The server's only login, so nothing on the wire names it.
   */
  implicit?: true;
}
export interface ConnectionLabelOptions {
  /**
   * For names other people read, such as eval runs a teammate opens: skip the
   * profile email, and any rename or profile name that is an address.
   */
  withoutEmail?: boolean;
}
export function connectionLabel(
  c: OAuthConnection,
  index = 0,
  options?: ConnectionLabelOptions,
): string {
  const usable = (value?: string) =>
    value && !(options?.withoutEmail && value.includes("@")) ? value : undefined;
  return (
    usable(c.label) ||
    (options?.withoutEmail ? undefined : c.profile?.email) ||
    usable(c.profile?.name) ||
    usable(c.profile?.nickname) ||
    `Account ${index + 1}`
  );
}

/**
 * Labels for a whole group, guaranteed distinct.
 *
 * `connectionLabel` alone is email-first, and the case multi-account exists
 * for — one person, two workspaces on one provider — is exactly the case where
 * every account carries the SAME email. Two identical strings in a tool
 * description leave the model nothing to choose on but an opaque id, so a
 * collision is qualified with whatever actually differs.
 */
export function connectionLabels(
  connections: readonly OAuthConnection[],
  options?: ConnectionLabelOptions,
): string[] {
  const base = connections.map((c, index) =>
    connectionLabel(c, index, options),
  );
  const seen = new Map<string, number>();
  for (const label of base) seen.set(label, (seen.get(label) ?? 0) + 1);

  const taken = new Set<string>();
  return connections.map((c, index) => {
    if ((seen.get(base[index]) ?? 0) < 2) {
      taken.add(base[index]);
      return base[index];
    }
    const qualifiers = [
      c.profile?.name,
      c.profile?.nickname,
      c.connectionId.slice(-6),
    ];
    for (const qualifier of qualifiers) {
      if (!qualifier || qualifier === base[index]) continue;
      if (options?.withoutEmail && qualifier.includes("@")) continue;
      const candidate = `${base[index]} (${qualifier})`;
      if (taken.has(candidate)) continue;
      taken.add(candidate);
      return candidate;
    }
    // Every qualifier collided too; the id is the last thing that cannot.
    const fallback = `${base[index]} (${c.connectionId})`;
    taken.add(fallback);
    return fallback;
  });
}
