/** Non-secret correlation only; also works on plain-HTTP local installs. */
export function authCorrelationId(): string {
  try {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* Some browsers restrict the Crypto API. */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
