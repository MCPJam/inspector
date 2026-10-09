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
  accessToken?: string | null;
  unavailableReason?: string;
}
export function connectionLabel(c: OAuthConnection, index = 0): string {
  return (
    c.label ||
    c.profile?.email ||
    c.profile?.name ||
    c.profile?.nickname ||
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
): string[] {
  const base = connections.map((c, index) => connectionLabel(c, index));
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
