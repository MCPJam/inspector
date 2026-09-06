import {
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PACK_SIGNING_KEYS,
  verifyPackManifestSignature,
  type PackSigningKey,
} from "../pack-signing-key.js";

function testKey(keyId: string): {
  key: PackSigningKey;
  sign: (bytes: Buffer) => string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    key: {
      keyId,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
    sign: (bytes) => edSign(null, bytes, privateKey).toString("base64"),
  };
}

const MANIFEST = Buffer.from('{"packVersion":"1","treeDigest":"sha256:aa"}\n');

describe("pack manifest signatures", () => {
  it("accepts a manifest signed by a trusted key", () => {
    const { key, sign } = testKey("release-2026-09");
    expect(
      verifyPackManifestSignature(MANIFEST, sign(MANIFEST), [key]),
    ).toEqual({ ok: true, keyId: "release-2026-09" });
  });

  it("refuses a manifest signed by anything else", () => {
    const trusted = testKey("trusted");
    const attacker = testKey("attacker");
    expect(
      verifyPackManifestSignature(MANIFEST, attacker.sign(MANIFEST), [
        trusted.key,
      ]),
    ).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("refuses a signature over different bytes", () => {
    // The manifest carries the archive hash and the tree digest, so a
    // signature that does not cover the exact bytes covers nothing.
    const { key, sign } = testKey("trusted");
    const signature = sign(Buffer.from('{"packVersion":"2"}\n'));
    expect(
      verifyPackManifestSignature(MANIFEST, signature, [key]),
    ).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("lets one key in a rotating set match without the others stopping it", () => {
    // Rotation is additive: a new key is appended and packs signed by either
    // verify until the old key's packs are gone.
    const retiring = testKey("old");
    const current = testKey("new");
    expect(
      verifyPackManifestSignature(MANIFEST, current.sign(MANIFEST), [
        retiring.key,
        current.key,
      ]),
    ).toEqual({ ok: true, keyId: "new" });
  });

  it("is not stopped by a malformed key sitting ahead of a good one", () => {
    const { key, sign } = testKey("good");
    expect(
      verifyPackManifestSignature(MANIFEST, sign(MANIFEST), [
        { keyId: "broken", publicKeyPem: "not a pem" },
        key,
      ]),
    ).toEqual({ ok: true, keyId: "good" });
  });

  it("refuses everything while no key is configured", () => {
    // Empty is not a bypass — it is a refusal — so no pack can be installed
    // from a network source before there is a key to vouch for one. Asserted
    // against an explicit empty list rather than against PACK_SIGNING_KEYS,
    // which now carries the release key: the property belongs to the function,
    // not to whatever the repository happens to trust today.
    const { sign } = testKey("anything");
    expect(
      verifyPackManifestSignature(MANIFEST, sign(MANIFEST), []),
    ).toMatchObject({ ok: false, reason: "no-keys" });
  });

  it("carries release keys that node can actually verify with", () => {
    // A committed key is a string until something parses it. A typo in the
    // PEM would not fail a build, a typecheck or any other test here — it
    // would fail at the one moment that matters, when a user's install
    // verifies a downloaded pack, and present as "not signed by any key this
    // Inspector trusts". `verifyPackManifestSignature` swallows a malformed
    // key on purpose so one bad entry cannot shadow a good one, which is
    // exactly why the parse has to be asserted somewhere.
    expect(PACK_SIGNING_KEYS.length).toBeGreaterThan(0);
    for (const key of PACK_SIGNING_KEYS) {
      expect(key.keyId).toMatch(/^[a-z0-9-]+$/);
      const publicKey = createPublicKey(key.publicKeyPem);
      expect(publicKey.asymmetricKeyType).toBe("ed25519");
    }
  });

  it("does not trust two keys under one id", () => {
    // Rotation appends, and the id is how a refusal names the key that turned
    // a pack away. Two entries sharing one id make that message ambiguous at
    // the only moment anybody reads it.
    const ids = PACK_SIGNING_KEYS.map((key) => key.keyId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("refuses a signature that is not base64 at all", () => {
    const { key } = testKey("trusted");
    expect(
      verifyPackManifestSignature(MANIFEST, "", [key]),
    ).toMatchObject({ ok: false, reason: "malformed" });
  });
});
