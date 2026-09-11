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
    "node:fs/promises",
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
  getBrowserConsentFingerprint,
  grantLocalBrowserConsent,
  revokeLocalBrowserConsent,
  verifyAndFingerprintBrowserConsent,
  verifyLocalBrowserConsent,
} from "../browser-consent.js";

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("local computer consent capability", () => {
  it("grant → verify → revoke round-trips; only the hash is persisted", async () => {
    const { token, grantedAt } = await grantLocalBrowserConsent();
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/); // base64url, 32 bytes
    expect(Date.parse(grantedAt)).not.toBeNaN();

    const persisted = readFileSync(
      join(scratch, ".mcpjam", "browser", "consent.json"),
      "utf8",
    );
    // The plaintext capability must never touch disk.
    expect(persisted).not.toContain(token);
    expect(JSON.parse(persisted).tokenHash).toMatch(/^[0-9a-f]{64}$/);

    expect(await verifyLocalBrowserConsent(token)).toBe(true);
    await revokeLocalBrowserConsent();
    expect(await verifyLocalBrowserConsent(token)).toBe(false);
  });

  it("re-granting rotates: the old capability stops verifying", async () => {
    const first = await grantLocalBrowserConsent();
    const second = await grantLocalBrowserConsent();
    expect(await verifyLocalBrowserConsent(first.token)).toBe(false);
    expect(await verifyLocalBrowserConsent(second.token)).toBe(true);
    await revokeLocalBrowserConsent();
  });

  it("a token-scoped revoke no-ops when a newer grant rotated the capability", async () => {
    const stale = await grantLocalBrowserConsent();
    const current = await grantLocalBrowserConsent(); // rotates; `stale` is dead
    // The delayed revoke, scoped to the stale token, must NOT sever `current`.
    await revokeLocalBrowserConsent(stale.token);
    expect(await verifyLocalBrowserConsent(current.token)).toBe(true);
    // Scoped to the live token it does revoke.
    await revokeLocalBrowserConsent(current.token);
    expect(await verifyLocalBrowserConsent(current.token)).toBe(false);
  });

  it("a grant overlapping a scoped revoke's verify→unlink window survives it", async () => {
    // Deterministic interleave: the revoke verifies its (still-current) token,
    // then parks INSIDE the window before its unlink. Without the mutation
    // lock, the concurrent grant would write the new capability during that
    // window and the resumed unlink would delete it. With the lock, the grant
    // queues until the revoke finishes, so the fresh capability survives.
    const stale = await grantLocalBrowserConsent();
    unlinkGate.armed = true;
    const revoking = revokeLocalBrowserConsent(stale.token);
    const granting = grantLocalBrowserConsent();
    await vi.waitFor(() => {
      if (!unlinkGate.release) throw new Error("revoke not at unlink yet");
    });
    unlinkGate.release!();
    unlinkGate.release = null;
    await revoking;
    const fresh = await granting;
    expect(await verifyLocalBrowserConsent(fresh.token)).toBe(true);
  });

  it("an unscoped revoke (no token) unlinks unconditionally", async () => {
    const { token } = await grantLocalBrowserConsent();
    await revokeLocalBrowserConsent();
    expect(await verifyLocalBrowserConsent(token)).toBe(false);
  });

  it("rejects garbage without a persisted capability", async () => {
    expect(await verifyLocalBrowserConsent(undefined)).toBe(false);
    expect(await verifyLocalBrowserConsent("")).toBe(false);
    expect(await verifyLocalBrowserConsent("short")).toBe(false);
    expect(await verifyLocalBrowserConsent("A".repeat(300))).toBe(false);
    expect(
      await verifyLocalBrowserConsent("definitely-not-the-token-but-long"),
    ).toBe(false);
  });
});

describe("verifyAndFingerprintBrowserConsent", () => {
  it("returns the matched fingerprint for the live token", async () => {
    const { token } = await grantLocalBrowserConsent();
    const fingerprint = await verifyAndFingerprintBrowserConsent(token);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // It IS the stored hash, not some other derivation.
    expect(fingerprint).toBe(await getBrowserConsentFingerprint());
  });

  it("rejects a wrong, empty, or absent token", async () => {
    await grantLocalBrowserConsent();
    expect(await verifyAndFingerprintBrowserConsent("n".repeat(43))).toBeNull();
    expect(await verifyAndFingerprintBrowserConsent("")).toBeNull();
    expect(await verifyAndFingerprintBrowserConsent(null)).toBeNull();
    expect(await verifyAndFingerprintBrowserConsent(undefined)).toBeNull();
  });

  it("rejects once consent is revoked", async () => {
    const { token } = await grantLocalBrowserConsent();
    await revokeLocalBrowserConsent(token);
    expect(await verifyAndFingerprintBrowserConsent(token)).toBeNull();
  });

  it("rejects the OLD token after a re-grant rotates the capability", async () => {
    const first = await grantLocalBrowserConsent();
    const second = await grantLocalBrowserConsent();

    // The whole point of pairing verify+fingerprint in one read: the old token
    // must never come back with the NEW capability's fingerprint.
    expect(await verifyAndFingerprintBrowserConsent(first.token)).toBeNull();
    const live = await verifyAndFingerprintBrowserConsent(second.token);
    expect(live).toBe(await getBrowserConsentFingerprint());
  });

  it("returns the fingerprint the token was CHECKED against, never a newer one", async () => {
    const { token } = await grantLocalBrowserConsent();
    const fingerprint = await verifyAndFingerprintBrowserConsent(token);

    // After a rotation the old fingerprint is stale — which is exactly what the
    // WS handler's re-check detects.
    await grantLocalBrowserConsent();
    expect(await getBrowserConsentFingerprint()).not.toBe(fingerprint);
  });
});

import {
  grantLocalComputerConsent,
  verifyLocalComputerConsent,
} from "../local-consent.js";
it("Browser and shell grants cannot authorize each other", async () => {
  const shell = await grantLocalComputerConsent();
  const browser = await grantLocalBrowserConsent();
  expect(await verifyLocalBrowserConsent(shell.token)).toBe(false);
  expect(await verifyLocalComputerConsent(browser.token)).toBe(false);
  await revokeLocalBrowserConsent(browser.token);
  expect(await verifyLocalComputerConsent(shell.token)).toBe(true);
});
