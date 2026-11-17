import type {
  EvalRunAccount,
  EvalRunAccountIdentity,
} from "@/components/evals/types";

/** "Nov 17, 10:27 AM": still unambiguous on a run opened days later. */
export function formatAccountTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function issuerHost(issuer: string): string {
  try {
    return new URL(issuer).host || issuer;
  } catch {
    // Not a URL: an issuer may be any string, and is shown as it is.
    return issuer;
  }
}

/**
 * Whose the token was and where that came from. The server's profile tool and
 * the token's own claims are labelled apart: a token's claims are unverified,
 * though a run that succeeded shows the server accepted them.
 */
export function runAccountIdentityText(
  identity: EvalRunAccountIdentity | undefined,
): string | undefined {
  if (!identity) return undefined;
  const { name, subject, issuer } = identity;
  const who =
    name && subject && name !== subject ? `${name} (${subject})` : name || subject;
  const source =
    identity.source === "profile"
      ? "from the server's profile tool"
      : "from the token";
  if (who) return `Identity: ${who}, ${source}`;
  if (issuer) return `Issuer: ${issuerHost(issuer)}, ${source}`;
  return undefined;
}

/**
 * What a run recorded about one account's stored token, in reading order:
 * who stored it and when, when it expires, and whose it is. Empty for an
 * account recorded before these facts existed.
 */
export function runAccountCredentialFacts(
  account: EvalRunAccount,
  formatTime: (timestamp: number) => string = formatAccountTime,
): string[] {
  const facts: string[] = [];
  const stored = [
    account.tokenUploaded ? "Uploaded" : "Signed in",
    account.tokenStoredAt !== undefined
      ? formatTime(account.tokenStoredAt)
      : undefined,
    account.tokenStoredBy ? `by ${account.tokenStoredBy}` : undefined,
  ];
  if (stored[1] || stored[2]) facts.push(stored.filter(Boolean).join(" "));
  if (account.tokenExpiresAt !== undefined)
    facts.push(`Expires ${formatTime(account.tokenExpiresAt)}`);
  const identity = runAccountIdentityText(account.identity);
  if (identity) facts.push(identity);
  return facts;
}
