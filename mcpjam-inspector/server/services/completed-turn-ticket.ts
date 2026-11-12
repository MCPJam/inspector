import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import {
  COMPLETED_TURN_RETRY_TTL_MS,
  HOSTED_PERSIST_RETRY_PREFIX,
  MAX_PERSIST_RETRY_HANDLE_CHARS,
} from "../../shared/persist-receipt.js";
import {
  HISTORY_PROVENANCE_SECRET_ENV,
  resolveSigningKeyRing,
} from "../utils/signing-keys.js";

const LABEL = "mcpjam:completed-turn-retry:v1";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 512 * 1024;

const claimSchema = z
  .object({
    subject: z.string().min(1),
    projectId: z.string().min(1),
    chatSessionId: z.string().min(1),
    turnId: z.string().min(1),
    expiresAt: z.number().finite(),
    body: z.string(),
  })
  .strict();
type Owner = Omit<z.infer<typeof claimSchema>, "expiresAt" | "body">;
const keys = () =>
  resolveSigningKeyRing({
    secretEnv: HISTORY_PROVENANCE_SECRET_ENV,
    label: LABEL,
  });

/** Encrypted, short-lived ingest bytes can be retried on any hosted replica.
 * Only scrubbed bodies enter here. The ticket grants no database authority:
 * retry still authenticates the current principal and project membership.
 */
export function createCompletedTurnTicket(
  owner: Owner,
  body: string,
): string | undefined {
  const ring = keys();
  if (!ring || Buffer.byteLength(body) > MAX_BODY_BYTES) return;
  const claim = claimSchema.safeParse({
    ...owner,
    body,
    expiresAt: Date.now() + COMPLETED_TURN_RETRY_TTL_MS,
  });
  if (!claim.success) return;
  const compressed = deflateRawSync(JSON.stringify(claim.data));
  if (compressed.length > MAX_COMPRESSED_BYTES) return;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ring.signing, iv);
  cipher.setAAD(Buffer.from(LABEL));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return [
    "mjpr1",
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

export function readCompletedTurnTicket(
  ticket: string,
  owner: Owner,
): string | undefined {
  if (
    !ticket.startsWith(HOSTED_PERSIST_RETRY_PREFIX) ||
    ticket.length > MAX_PERSIST_RETRY_HANDLE_CHARS
  )
    return;
  const parts = ticket.split(".");
  if (
    parts.length !== 4 ||
    parts
      .slice(1)
      .some(
        (part) =>
          !/^[A-Za-z0-9_-]+$/.test(part) ||
          Buffer.from(part, "base64url").toString("base64url") !== part,
      )
  )
    return;
  const iv = Buffer.from(parts[1]!, "base64url"),
    ciphertext = Buffer.from(parts[2]!, "base64url"),
    tag = Buffer.from(parts[3]!, "base64url");
  if (
    iv.length !== 12 ||
    tag.length !== 16 ||
    ciphertext.length > MAX_COMPRESSED_BYTES
  )
    return;
  for (const key of keys()?.accepted ?? []) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(LABEL));
      decipher.setAuthTag(tag);
      const compressed = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      const claim = claimSchema.parse(
        JSON.parse(
          inflateRawSync(compressed, {
            maxOutputLength: MAX_BODY_BYTES + 16 * 1024,
          }).toString("utf8"),
        ),
      );
      if (
        claim.expiresAt <= Date.now() ||
        claim.expiresAt > Date.now() + COMPLETED_TURN_RETRY_TTL_MS ||
        Buffer.byteLength(claim.body) > MAX_BODY_BYTES ||
        claim.subject !== owner.subject ||
        claim.projectId !== owner.projectId ||
        claim.chatSessionId !== owner.chatSessionId ||
        claim.turnId !== owner.turnId
      )
        return;
      return claim.body;
    } catch {
      // A tampered ticket or a different rotation key is an expected refusal.
    }
  }
}
