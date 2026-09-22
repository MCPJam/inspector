import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "mcpjam-local-consent-"));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => scratch };
});

// Passthrough fs with a one-shot gate on unlink, so a test can hold a revoke
// open exactly inside its verify→unlink window and prove a concurrent grant
// cannot interleave there (the module's mutation lock).
const unlinkGate = vi.hoisted(() => ({
  armed: false,
  release: null as (() => void) | null,
}));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises"
  );
  return {
    ...actual,
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      if (unlinkGate.armed) {
        unlinkGate.armed = false;
        await new Promise<void>((resolve) => {
          unlinkGate.release = resolve;
        });
      }
      return actual.unlink(path);
    },
  };
});

import {
  getLocalConsentFingerprint,
  grantLocalComputerConsent,
  revokeLocalComputerConsent,
  verifyAndFingerprintLocalConsent,
  verifyLocalComputerConsent,
} from "../local-consent.js";

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("local computer consent capability", () => {
  it("grant → verify → revoke round-trips; only the hash is persisted", async () => {
    const { token, grantedAt } = await grantLocalComputerConsent();
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/); // base64url, 32 bytes
    expect(Date.parse(grantedAt)).not.toBeNaN();

    const persisted = readFileSync(
      join(scratch, ".mcpjam", "computer", "consent.json"),
      "utf8"
    );
    // The plaintext capability must never touch disk.
    expect(persisted).not.toContain(token);
    expect(JSON.parse(persisted).tokenHash).toMatch(/^[0-9a-f]{64}$/);

    expect(await verifyLocalComputerConsent(token)).toBe(true);
    await revokeLocalComputerConsent();
    expect(await verifyLocalComputerConsent(token)).toBe(false);
  });

  it("re-granting rotates: the old capability stops verifying", async () => {
    const first = await grantLocalComputerConsent();
    const second = await grantLocalComputerConsent();
    expect(await verifyLocalComputerConsent(first.token)).toBe(false);
    expect(await verifyLocalComputerConsent(second.token)).toBe(true);
    await revokeLocalComputerConsent();
  });

  it("a token-scoped revoke no-ops when a newer grant rotated the capability", async () => {
    const stale = await grantLocalComputerConsent();
    const current = await grantLocalComputerConsent(); // rotates; `stale` is dead
    // The delayed revoke, scoped to the stale token, must NOT sever `current`.
    await revokeLocalComputerConsent(stale.token);
    expect(await verifyLocalComputerConsent(current.token)).toBe(true);
    // Scoped to the live token it does revoke.
    await revokeLocalComputerConsent(current.token);
    expect(await verifyLocalComputerConsent(current.token)).toBe(false);
  });

  it("a grant overlapping a scoped revoke's verify→unlink window survives it", async () => {
    // Deterministic interleave: the revoke verifies its (still-current) token,
    // then parks INSIDE the window before its unlink. Without the mutation
    // lock, the concurrent grant would write the new capability during that
    // window and the resumed unlink would delete it. With the lock, the grant
    // queues until the revoke finishes, so the fresh capability survives.
    const stale = await grantLocalComputerConsent();
    unlinkGate.armed = true;
    const revoking = revokeLocalComputerConsent(stale.token);
    const granting = grantLocalComputerConsent();
    await vi.waitFor(() => {
      if (!unlinkGate.release) throw new Error("revoke not at unlink yet");
    });
    unlinkGate.release!();
    unlinkGate.release = null;
    await revoking;
    const fresh = await granting;
    expect(await verifyLocalComputerConsent(fresh.token)).toBe(true);
  });

  it("an unscoped revoke (no token) unlinks unconditionally", async () => {
    const { token } = await grantLocalComputerConsent();
    await revokeLocalComputerConsent();
    expect(await verifyLocalComputerConsent(token)).toBe(false);
  });

  it("rejects garbage without a persisted capability", async () => {
    expect(await verifyLocalComputerConsent(undefined)).toBe(false);
    expect(await verifyLocalComputerConsent("")).toBe(false);
    expect(await verifyLocalComputerConsent("short")).toBe(false);
    expect(
      await verifyLocalComputerConsent("A".repeat(300))
    ).toBe(false);
    expect(
      await verifyLocalComputerConsent("definitely-not-the-token-but-long")
    ).toBe(false);
  });
});


describe("verifyAndFingerprintLocalConsent", () => {
  it("returns the matched fingerprint for the live token", async () => {
    const { token } = await grantLocalComputerConsent();
    const fingerprint = await verifyAndFingerprintLocalConsent(token);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // It IS the stored hash, not some other derivation.
    expect(fingerprint).toBe(await getLocalConsentFingerprint());
  });

  it("rejects a wrong, empty, or absent token", async () => {
    await grantLocalComputerConsent();
    expect(await verifyAndFingerprintLocalConsent("n".repeat(43))).toBeNull();
    expect(await verifyAndFingerprintLocalConsent("")).toBeNull();
    expect(await verifyAndFingerprintLocalConsent(null)).toBeNull();
    expect(await verifyAndFingerprintLocalConsent(undefined)).toBeNull();
  });

  it("rejects once consent is revoked", async () => {
    const { token } = await grantLocalComputerConsent();
    await revokeLocalComputerConsent(token);
    expect(await verifyAndFingerprintLocalConsent(token)).toBeNull();
  });

  it("rejects the OLD token after a re-grant rotates the capability", async () => {
    const first = await grantLocalComputerConsent();
    const second = await grantLocalComputerConsent();

    // The whole point of pairing verify+fingerprint in one read: the old token
    // must never come back with the NEW capability's fingerprint.
    expect(await verifyAndFingerprintLocalConsent(first.token)).toBeNull();
    const live = await verifyAndFingerprintLocalConsent(second.token);
    expect(live).toBe(await getLocalConsentFingerprint());
  });

  it("returns the fingerprint the token was CHECKED against, never a newer one", async () => {
    const { token } = await grantLocalComputerConsent();
    const fingerprint = await verifyAndFingerprintLocalConsent(token);

    // After a rotation the old fingerprint is stale — which is exactly what the
    // WS handler's re-check detects.
    await grantLocalComputerConsent();
    expect(await getLocalConsentFingerprint()).not.toBe(fingerprint);
  });
});
