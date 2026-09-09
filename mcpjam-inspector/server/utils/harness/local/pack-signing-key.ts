/**
 * The public half of the release key that signs runtime pack manifests.
 *
 * ── Why a signature at all, when the digest is already checked ────────────
 * The tree digest proves the pack on disk is the pack the manifest describes.
 * It says nothing about whether MCPJam published that manifest. Without a
 * signature, anything that can answer the download URL — a proxy, a poisoned
 * cache, a compromised release asset — can serve a pack plus a manifest that
 * matches it perfectly, and every digest check would pass.
 *
 * So the chain is: this key signs the manifest; the manifest carries the
 * archive's sha256 and the extracted tree's digest; the installer verifies the
 * signature first, then the archive against the manifest, then the extracted
 * tree against the manifest. One signature transitively covers all of it.
 *
 * ── Key handling ─────────────────────────────────────────────────────────
 * Ed25519. The private half lives only in the CI secret
 * `LOCAL_HARNESS_PACK_SIGNING_KEY` and is never in this repository, in a
 * developer's environment, or in a built artifact. Rotation is additive: a new
 * key is appended here and packs signed by either verify, until the old key's
 * packs are no longer installable and its entry is removed in a later release.
 */
import { createPublicKey, verify as edVerify } from "node:crypto";

export interface PackSigningKey {
  /** Short identifier, for logs and for saying which key rejected a pack. */
  keyId: string;
  /** SPKI, PEM-encoded. */
  publicKeyPem: string;
}

/**
 * Keys a pack manifest signature is accepted from.
 *
 * An EMPTY list is not a bypass but a refusal: `verifyPackManifestSignature`
 * turns away everything while there is no key to vouch for a pack, which is
 * what this repository shipped before the release key existed. Development
 * never reaches here — `MCPJAM_LOCAL_HARNESS_PACK_SOURCE` names a local file
 * instead of fetching one.
 *
 * Rotation is additive: append the new key, ship a release that trusts both,
 * and only then start signing with it. An entry outlives the signing rather
 * than the other way round, because removing one makes every pack it signed
 * uninstallable.
 */
export const PACK_SIGNING_KEYS: readonly PackSigningKey[] = [
  {
    // Generated 2026-09-02. The private half went straight into the CI secret
    // `LOCAL_HARNESS_PACK_SIGNING_KEY` and exists nowhere else — there is no
    // copy to lose, and recovery is rotation, not restore.
    keyId: "pack-2026-09",
    publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAjaZXzr+4k5pJEuzIy5JUU858ksLJgjZv9b9jxmNhV6A=
-----END PUBLIC KEY-----
`,
  },
];

export type PackSignatureResult =
  | { ok: true; keyId: string }
  | { ok: false; reason: "no-keys" | "bad-signature" | "malformed"; message: string };

/**
 * Verify a detached Ed25519 signature over the manifest bytes.
 *
 * The manifest is verified as RAW BYTES, not as re-serialized JSON: a parse
 * and re-stringify would make the signature cover a normalization of the
 * document rather than the document, and two JSON serializers that disagree
 * about key order or number formatting would then disagree about validity.
 */
export function verifyPackManifestSignature(
  manifestBytes: Buffer,
  signatureBase64: string,
  keys: readonly PackSigningKey[] = PACK_SIGNING_KEYS,
): PackSignatureResult {
  if (keys.length === 0) {
    return {
      ok: false,
      reason: "no-keys",
      message:
        "this Inspector build carries no runtime pack signing key, so it " +
        "cannot verify that a downloaded pack came from MCPJam. Packs are " +
        "installable from a local path for development only.",
    };
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureBase64.trim(), "base64");
    if (signature.length === 0) throw new Error("empty");
  } catch {
    return {
      ok: false,
      reason: "malformed",
      message: "the pack manifest signature is not valid base64",
    };
  }
  for (const key of keys) {
    try {
      const publicKey = createPublicKey(key.publicKeyPem);
      if (edVerify(null, manifestBytes, publicKey, signature)) {
        return { ok: true, keyId: key.keyId };
      }
    } catch {
      // A malformed key in the list must not stop a good key from matching.
      continue;
    }
  }
  return {
    ok: false,
    reason: "bad-signature",
    message:
      "the runtime pack manifest is not signed by any key this Inspector " +
      "trusts, so the pack is refused",
  };
}
