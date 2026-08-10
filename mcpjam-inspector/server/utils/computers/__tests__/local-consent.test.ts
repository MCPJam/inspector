import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "mcpjam-local-consent-"));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => scratch };
});

import {
  grantLocalComputerConsent,
  revokeLocalComputerConsent,
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
