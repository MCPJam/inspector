/**
 * Device-scoped consent capability for the local computer engine.
 *
 * "The user allowed agents to run commands on this machine" is a fact the
 * SERVER must be able to verify — a request field alone is never proof (any
 * client could set it). Grant mints a random capability token; the server
 * persists only its SHA-256 hash (`~/.mcpjam/computer/consent.json`, 0600,
 * atomic replace); the client stores the plaintext and presents it in the
 * `X-MCPJam-Local-Consent` header, which the engine resolver verifies before
 * ever resolving `local`.
 *
 * This is a local UX/safety boundary, not an OS sandbox: a process already
 * running as this OS user can edit the file. What it defends against is a
 * remote or scripted client flipping the engine without the human ever
 * clicking Allow — the mint routes sit behind the inspector session AND a
 * verified sign-in (`/api/mcp` + requireVerifiedAuth), so neither a random
 * webpage nor a bare `Authorization: Bearer whatever` can mint one.
 *
 * The capability is deliberately device-scoped (not per-project): the thing
 * being consented to is THIS machine executing commands.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../logger.js";
import { getLocalComputerWorkspaceRoot } from "./local-machine.js";

export const LOCAL_CONSENT_HEADER = "x-mcpjam-local-consent";

interface PersistedConsent {
  /** SHA-256 (hex) of the capability token — plaintext is never stored. */
  tokenHash: string;
  grantedAt: string;
}

function consentFilePath(): string {
  return join(getLocalComputerWorkspaceRoot(), "consent.json");
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
let mutationChain: Promise<unknown> = Promise.resolve();
function withConsentMutationLock<T>(op: () => Promise<T>): Promise<T> {
  const run = mutationChain.then(op, op);
  mutationChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

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
export function grantLocalComputerConsent(): Promise<{
  token: string;
  grantedAt: string;
}> {
  return withConsentMutationLock(async () => {
    const token = randomBytes(32).toString("base64url");
    const grantedAt = new Date().toISOString();
    const dir = getLocalComputerWorkspaceRoot();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = consentFilePath();
    const tmp = `${file}.tmp`;
    const body: PersistedConsent = { tokenHash: hashToken(token), grantedAt };
    await writeFile(tmp, JSON.stringify(body), { mode: 0o600 });
    await rename(tmp, file);
    logger.info("[local-consent] capability granted");
    return { token, grantedAt };
  });
}

/**
 * Constant-time verify of a presented capability against the stored hash.
 *
 * Delegates to `verifyAndFingerprintLocalConsent` so the length bounds and the
 * `timingSafeEqual` compare live in exactly ONE place and cannot drift apart.
 * Same single-read property, same lock-free behavior.
 */
export async function verifyLocalComputerConsent(
  token: string | null | undefined
): Promise<boolean> {
  return (await verifyAndFingerprintLocalConsent(token)) !== null;
}

/**
 * Fingerprint of the CURRENTLY persisted capability (its stored SHA-256), or
 * null when no consent exists.
 *
 * Lets a holder of a derived credential — the local terminal's handshake nonce —
 * verify that the capability it was minted against is still the live one,
 * WITHOUT holding the plaintext token. A revoke (no consent) or a re-grant from
 * another browser profile (rotated hash) both change the answer, so a nonce
 * minted before either becomes unredeemable.
 */
export async function getLocalConsentFingerprint(): Promise<string | null> {
  return (await readPersistedConsent())?.tokenHash ?? null;
}

/**
 * Verify a presented capability AND return the fingerprint it matched, from a
 * SINGLE read of the consent file.
 *
 * Minting a terminal nonce needs both facts, and taking them from two separate
 * reads is a real race: a re-grant landing between them would verify the OLD
 * token and then hand back the NEW capability's fingerprint, so the old browser
 * profile would get a nonce that survives the rotation it should have died to.
 * One read makes the pair internally consistent — the returned fingerprint is
 * always the very hash the token was checked against.
 *
 * Deliberately still lock-free, like `verifyLocalComputerConsent`: this is on
 * the enforcement path and must never queue behind a mutation. A rotation that
 * happens *after* this read is caught later, when the WebSocket re-checks the
 * fingerprint against the live capability.
 */
export async function verifyAndFingerprintLocalConsent(
  token: string | null | undefined
): Promise<string | null> {
  if (!token || token.length < 16 || token.length > 256) return null;
  const persisted = await readPersistedConsent();
  if (!persisted) return null;
  const presented = Buffer.from(hashToken(token), "hex");
  const stored = Buffer.from(persisted.tokenHash, "hex");
  const matches =
    presented.length === stored.length && timingSafeEqual(presented, stored);
  return matches ? persisted.tokenHash : null;
}

/**
 * Revoke the persisted capability. When `token` is supplied the revoke is
 * SCOPED: it unlinks only if that token still matches the stored hash, so a
 * slow revoke request that lost a race to a newer grant cannot sever the
 * rotated capability that grant just minted. Without a token (the client had
 * nothing stored but the user still asked to sever this device) it unlinks
 * unconditionally.
 */
export function revokeLocalComputerConsent(
  token?: string | null
): Promise<void> {
  // The verify and the unlink must be one atomic step (the mutation lock):
  // otherwise a grant landing between them rotates the capability and this
  // stale revoke would delete the newly granted one.
  return withConsentMutationLock(async () => {
    if (token != null && !(await verifyLocalComputerConsent(token))) {
      return;
    }
    await unlink(consentFilePath()).catch(() => {});
    logger.info("[local-consent] capability revoked");
  });
}
