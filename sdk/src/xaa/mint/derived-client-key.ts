import { createECDH, createPrivateKey, hkdfSync, type KeyObject } from "crypto";
import { XAA_CLIENT_KID, type XaaClientJwk } from "./client-keypair.js";

const DERIVATION_SALT = Buffer.from("mcpjam/xaa/confidential-cimd/v1", "utf8");
const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export interface DerivedOrgConfidentialCimdKey {
  privateKey: KeyObject;
  publicJwk: XaaClientJwk;
}

function requireMasterKey(masterKey: Uint8Array): Buffer {
  const key = Buffer.from(masterKey);
  if (key.length !== 32) {
    throw new Error(
      "XAA confidential CIMD master key must contain exactly 32 bytes"
    );
  }
  return key;
}

function derivationInfo(orgId: string, counter: number): Buffer {
  const orgBytes = Buffer.from(orgId, "utf8");
  // Node replaces unpaired UTF-16 surrogates with U+FFFD while encoding. That
  // would allow distinct malformed JavaScript strings to collapse to the same
  // HKDF input, so require the UTF-8 conversion to round-trip exactly.
  if (orgBytes.toString("utf8") !== orgId) {
    throw new Error("organization id must be losslessly encodable as UTF-8");
  }
  if (orgBytes.length === 0 || orgBytes.length > 0xffffffff) {
    throw new Error("organization id must be a non-empty UTF-8 string");
  }
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(orgBytes.length);
  const retry = Buffer.allocUnsafe(4);
  retry.writeUInt32BE(counter);
  return Buffer.concat([Buffer.from("org", "utf8"), length, orgBytes, retry]);
}

function derivePrivateScalar(masterKey: Buffer, orgId: string): Buffer {
  for (let counter = 0; counter <= 0xffffffff; counter += 1) {
    const candidate = Buffer.from(
      hkdfSync(
        "sha256",
        masterKey,
        DERIVATION_SALT,
        derivationInfo(orgId, counter),
        32
      )
    );
    const scalar = BigInt(`0x${candidate.toString("hex")}`);
    if (scalar > 0n && scalar < P256_ORDER) return candidate;
  }
  throw new Error("could not derive a valid P-256 confidential CIMD key");
}

/**
 * Deterministically derive an org-scoped P-256 client key from a 32-byte
 * deployment master key. The result is stateless: no key material is stored.
 */
export function deriveOrgConfidentialCimdKey(
  masterKey: Uint8Array,
  orgId: string
): DerivedOrgConfidentialCimdKey {
  const scalar = derivePrivateScalar(requireMasterKey(masterKey), orgId);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(scalar);
  const publicPoint = ecdh.getPublicKey(undefined, "uncompressed");
  if (publicPoint.length !== 65 || publicPoint[0] !== 0x04) {
    throw new Error("could not derive an uncompressed P-256 public point");
  }

  const x = publicPoint.subarray(1, 33).toString("base64url");
  const y = publicPoint.subarray(33, 65).toString("base64url");
  const privateKey = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x,
      y,
      d: scalar.toString("base64url"),
    },
    format: "jwk",
  });

  return {
    privateKey,
    publicJwk: {
      kty: "EC",
      crv: "P-256",
      x,
      y,
      kid: XAA_CLIENT_KID,
      alg: "ES256",
      use: "sig",
    },
  };
}
