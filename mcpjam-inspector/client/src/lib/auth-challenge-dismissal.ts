export function cardKey(serverName: string, origin: string): string {
  return `${serverName}\u0000${origin}`;
}

// ---------------------------------------------------------------------------
// "Not now", remembered for the session
// ---------------------------------------------------------------------------

export const DISMISSED_KEY = "mcp-auth-challenge-dismissed-v1";

export function readDismissed(): string[] {
  try {
    const raw = sessionStorage.getItem(DISMISSED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function isAuthChallengeDismissed(
  serverName: string,
  origin: string,
): boolean {
  return readDismissed().includes(cardKey(serverName, origin));
}

export function rememberDismissed(serverName: string, origin: string): void {
  try {
    const entries = new Set(readDismissed());
    entries.add(cardKey(serverName, origin));
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...entries]));
  } catch {
    // Best-effort: the card may show again, never a redirect without a click.
  }
}

/** Forget "Not now" for a server: the user signed in some other way. */
export function clearAuthChallengeDismissed(serverName: string): void {
  try {
    const prefix = `${serverName}\u0000`;
    const entries = readDismissed().filter(
      (entry) => !entry.startsWith(prefix),
    );
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(entries));
  } catch {
    // Best-effort.
  }
}
