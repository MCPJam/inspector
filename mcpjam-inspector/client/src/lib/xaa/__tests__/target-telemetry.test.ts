import { describe, expect, it } from "vitest";
import { hashXaaTargetId } from "../target-telemetry";

describe("hashXaaTargetId", () => {
  it("is deterministic for the same target key", () => {
    expect(hashXaaTargetId("bar_server:staging")).toBe(
      hashXaaTargetId("bar_server:staging"),
    );
  });

  it("produces distinct ids for distinct targets", () => {
    expect(hashXaaTargetId("bar_server:staging")).not.toBe(
      hashXaaTargetId("bar_server:prod"),
    );
    expect(hashXaaTargetId("bar_server:staging")).not.toBe(
      hashXaaTargetId("registration:app_1"),
    );
  });

  it("never embeds the raw target name and is a fixed-width hex bucket", () => {
    const id = hashXaaTargetId("bar_server:staging-mcp.acme.com");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(id).not.toContain("acme");
    expect(id).not.toContain("staging");
  });
});
