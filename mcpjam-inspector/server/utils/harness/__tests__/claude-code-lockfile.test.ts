import { describe, expect, it } from "vitest";
import { patchClaudeCodeBootstrapLock } from "../claude-code-lockfile.js";

const vulnerable = `packages:
  proxy-addr@2.0.7:
    resolution: {integrity: sha512-llQsMLSUDUPT44jdrU/O37qlnifitDP+ZwrmmZcoSKyLKvtZxpyV0n2/bD/N4tBAAZ/gJEdZU7KMraoK1+XYAg==}
    engines: {node: '>= 0.10'}
snapshots:
  express@5.1.0:
    dependencies:
      proxy-addr: 2.0.7
  proxy-addr@2.0.7:
    dependencies:
      forwarded: 0.2.0
      ipaddr.js: 1.9.1
`;

describe("Claude's frozen bootstrap lock", () => {
  it("updates the package integrity and every dependency/snapshot reference together", () => {
    const patched = patchClaudeCodeBootstrapLock(vulnerable);
    expect(patched).not.toContain("2.0.7");
    expect(patched.match(/proxy-addr@2.0.8:/g)).toHaveLength(2);
    expect(patched).toContain("proxy-addr: 2.0.8\n");
    expect(patched).toContain("sha512-5nnx0yGyVUcY6t9RnWcARWtwT9F1D8O9rt08htPvnd49W1IgZtmLkhu9WfMzQj1cFxjHIO6connUNVW5k7AVyQ==");
    expect(patched).toContain("forwarded: 0.2.0\n      ipaddr.js: 1.9.1");
  });

  it("leaves a fixed or unrelated lockfile unchanged", () => {
    const patched = patchClaudeCodeBootstrapLock(vulnerable);
    expect(patchClaudeCodeBootstrapLock(patched)).toBe(patched);
    expect(patchClaudeCodeBootstrapLock("lockfileVersion: '9.0'\n")).toBe("lockfileVersion: '9.0'\n");
  });

  it("fails when upstream integrity or layout no longer matches the patch", () => {
    expect(() => patchClaudeCodeBootstrapLock(vulnerable.replace("sha512-llQs", "sha512-other"))).toThrow("lockfile changed");
    expect(() => patchClaudeCodeBootstrapLock(vulnerable.replace("      proxy-addr: 2.0.7\n", ""))).toThrow("lockfile changed");
  });
});
