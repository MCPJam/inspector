/**
 * A web account's browser profile is encrypted on this server, under the data
 * key the backend issues for each save, before it is uploaded: the backend
 * holds only the ciphertext and the sealed key. AES-256-GCM, laid out as IV,
 * ciphertext, tag. A run's restore opens it with the key that
 * `profile-for-run` returns.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function sealWebProfile(profile: Uint8Array, dataKey: Uint8Array) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  const body = Buffer.concat([cipher.update(profile), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

/** Throws when the archive was altered or the key is not its own. */
export function openWebProfile(sealed: Uint8Array, dataKey: Uint8Array) {
  const tagStart = sealed.length - TAG_BYTES;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    dataKey,
    sealed.subarray(0, IV_BYTES),
  );
  decipher.setAuthTag(sealed.subarray(tagStart));
  return Buffer.concat([
    decipher.update(sealed.subarray(IV_BYTES, tagStart)),
    decipher.final(),
  ]);
}
