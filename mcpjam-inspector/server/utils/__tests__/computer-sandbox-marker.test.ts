import { describe, expect, it } from "vitest";
import { readComputerSandboxMode } from "../chatbox-runtime-config.js";

/**
 * The `computerSandbox` marker has THREE states, and the third one — absence —
 * is what makes this feature deployable without a flag day. These tests pin
 * that absence and malformation both mean "the backend told us nothing usable",
 * i.e. keep today's personal-computer behaviour.
 */
describe("readComputerSandboxMode", () => {
  it("reads the two stated modes", () => {
    expect(
      readComputerSandboxMode({ computerSandbox: { mode: "ephemeral" } })
    ).toBe("ephemeral");
    expect(
      readComputerSandboxMode({
        computerSandbox: { mode: "unavailable", reason: "no ready build" },
      })
    ).toBe("unavailable");
  });

  it("returns null for an OLD BACKEND — never 'unavailable'", () => {
    // Absent must not be read as "no image": that would silently strip bash
    // from every chatbox the moment a deploy skewed.
    expect(readComputerSandboxMode({ computer: { kind: "personal" } })).toBe(
      null
    );
    expect(readComputerSandboxMode(undefined)).toBe(null);
    expect(readComputerSandboxMode(null)).toBe(null);
  });

  it("returns null for a malformed marker — never 'ephemeral'", () => {
    // Reading garbage as `ephemeral` would provision a paid box against a
    // policy nobody stated.
    expect(readComputerSandboxMode({ computerSandbox: { mode: "yes" } })).toBe(
      null
    );
    expect(readComputerSandboxMode({ computerSandbox: "ephemeral" })).toBe(
      null
    );
    expect(readComputerSandboxMode({ computerSandbox: {} })).toBe(null);
  });
});
