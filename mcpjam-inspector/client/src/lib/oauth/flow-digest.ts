/**
 * A one-way digest of an authorization request's `state`.
 *
 * A call saved for after a sign-in must be replayed only by the callback for
 * the flow that started it. It is bound to that flow by this digest, so the
 * `state` itself (a CSRF value the OAuth flow already keeps) is never written
 * to storage a second time. Comparing digests is as good as comparing the
 * values: only a callback carrying the same `state` produces the same digest.
 *
 * `undefined` when Web Crypto is unavailable; the saved call is then unbound
 * and completes on any callback for its server, as it did before binding.
 */
export async function authorizationFlowDigest(
  state: string | null | undefined,
): Promise<string | undefined> {
  if (!state) return undefined;
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return undefined;
    const digest = await subtle.digest(
      "SHA-256",
      new TextEncoder().encode(state),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    return undefined;
  }
}
