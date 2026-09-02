import { generateKeyPairSync, sign as edSign } from "node:crypto";
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
    // The repo state before the release key is generated. Empty is not a
    // bypass — it is a refusal — so no pack can be installed from a network
    // source before there is a key to vouch for one.
    expect(PACK_SIGNING_KEYS).toEqual([]);
    const { sign } = testKey("anything");
    expect(verifyPackManifestSignature(MANIFEST, sign(MANIFEST))).toMatchObject(
      { ok: false, reason: "no-keys" },
    );
  });

  it("refuses a signature that is not base64 at all", () => {
    const { key } = testKey("trusted");
    expect(
      verifyPackManifestSignature(MANIFEST, "", [key]),
    ).toMatchObject({ ok: false, reason: "malformed" });
  });
});
