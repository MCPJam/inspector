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
export async function grantLocalComputerConsent(): Promise<{
  token: string;
  grantedAt: string;
}> {
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
}

/** Constant-time verify of a presented capability against the stored hash. */
export async function verifyLocalComputerConsent(
  token: string | null | undefined
): Promise<boolean> {
  if (!token || token.length < 16 || token.length > 256) return false;
  const persisted = await readPersistedConsent();
  if (!persisted) return false;
  const presented = Buffer.from(hashToken(token), "hex");
  const stored = Buffer.from(persisted.tokenHash, "hex");
  return (
    presented.length === stored.length && timingSafeEqual(presented, stored)
  );
}

export async function revokeLocalComputerConsent(): Promise<void> {
  await unlink(consentFilePath()).catch(() => {});
  logger.info("[local-consent] capability revoked");
}
