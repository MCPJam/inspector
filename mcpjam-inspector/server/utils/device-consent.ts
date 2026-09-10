import { readFile, unlink } from "node:fs/promises";
import {
  capabilityFingerprint as hashToken,
  capabilityMatches,
  createCapabilityMutationLock,
  mintCapabilityToken,
  persistCapabilityState,
} from "./local-capability.js";

/** One device capability per scope. Storage policy stays with the caller. */
export function createDeviceConsent(consentFilePath: () => string) {
  interface PersistedConsent {
    /** SHA-256 (hex) of the capability token — plaintext is never stored. */
    tokenHash: string;
    grantedAt: string;
  }

  /**
   * Grant and revoke are read-modify-write on the consent file, and a scoped
   * revoke's verify-then-unlink spans multiple awaits — without exclusion, a
   * concurrent grant can rotate the capability between the verify and the
   * unlink and the stale revoke would delete the NEW capability. The file is
   * only ever mutated through this module in the single server process, so an
   * in-process chain is sufficient exclusion. `verify` stays lock-free: it is
   * a pure read, and the enforcement path must never queue behind mutations.
   */
  const withConsentMutationLock = createCapabilityMutationLock();

  async function readPersistedConsent(): Promise<PersistedConsent | null> {
    try {
      const raw = await readFile(consentFilePath(), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const record = parsed as Record<string, unknown>;
      if (
        typeof record.tokenHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(record.tokenHash)
      ) {
        return null;
      }
      return {
        tokenHash: record.tokenHash,
        grantedAt:
          typeof record.grantedAt === "string" ? record.grantedAt : "unknown",
      };
    } catch {
      return null;
    }
  }

  /**
   * Mint a fresh capability, replacing any prior one (one capability per
   * machine — re-granting from a second browser profile rotates it, and the
   * old profile re-prompts, which is the honest behavior).
   */
  function grant(): Promise<{
    token: string;
    grantedAt: string;
  }> {
    return withConsentMutationLock(async () => {
      const token = mintCapabilityToken();
      const grantedAt = new Date().toISOString();
      const body: PersistedConsent = { tokenHash: hashToken(token), grantedAt };
      await persistCapabilityState(consentFilePath(), body);

      return { token, grantedAt };
    });
  }

  /**
   * Constant-time verify of a presented capability against the stored hash.
   *
   * Delegates to `verifyAndFingerprint` so the length bounds and the
   * `timingSafeEqual` compare live in exactly ONE place and cannot drift apart.
   * Same single-read property, same lock-free behavior.
   */
  async function verify(token: string | null | undefined): Promise<boolean> {
    return (await verifyAndFingerprint(token)) !== null;
  }

  /**
   * Fingerprint of the CURRENTLY persisted capability (its stored SHA-256), or
   * null when no consent exists.
   *
   * Lets a holder of a derived credential — the stream handshake nonce —
   * verify that the capability it was minted against is still the live one,
   * WITHOUT holding the plaintext token. A revoke (no consent) or a re-grant from
   * another browser profile (rotated hash) both change the answer, so a nonce
   * minted before either becomes unredeemable.
   */
  async function fingerprint(): Promise<string | null> {
    return (await readPersistedConsent())?.tokenHash ?? null;
  }

  /**
   * Verify a presented capability AND return the fingerprint it matched, from a
   * SINGLE read of the consent file.
   *
   * Minting a stream nonce needs both facts, and taking them from two separate
   * reads is a real race: a re-grant landing between them would verify the OLD
   * token and then hand back the NEW capability's fingerprint, so the old browser
   * profile would get a nonce that survives the rotation it should have died to.
   * One read makes the pair internally consistent — the returned fingerprint is
   * always the very hash the token was checked against.
   *
   * Deliberately still lock-free, like `verify`: this is on
   * the enforcement path and must never queue behind a mutation. A rotation that
   * happens *after* this read is caught later, when the WebSocket re-checks the
   * fingerprint against the live capability.
   */
  async function verifyAndFingerprint(
    token: string | null | undefined,
  ): Promise<string | null> {
    if (typeof token !== "string" || token.length < 16 || token.length > 256) return null;
    const persisted = await readPersistedConsent();
    if (!persisted) return null;
    return capabilityMatches(token, persisted.tokenHash)
      ? persisted.tokenHash
      : null;
  }

  /**
   * Revoke the persisted capability. When `token` is supplied the revoke is
   * SCOPED: it unlinks only if that token still matches the stored hash, so a
   * slow revoke request that lost a race to a newer grant cannot sever the
   * rotated capability that grant just minted. Without a token (the client had
   * nothing stored but the user still asked to sever this device) it unlinks
   * unconditionally.
   */
  function revoke(token?: string | null): Promise<void> {
    // The verify and the unlink must be one atomic step (the mutation lock):
    // otherwise a grant landing between them rotates the capability and this
    // stale revoke would delete the newly granted one.
    return withConsentMutationLock(async () => {
      if (token != null && !(await verify(token))) {
        return;
      }
      await unlink(consentFilePath()).catch(() => {});
    });
  }

  return {
    grant: grant,
    verify: verify,
    fingerprint: fingerprint,
    verifyAndFingerprint: verifyAndFingerprint,
    revoke: revoke,
  };
}
