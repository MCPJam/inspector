import { describe, expect, it } from "vitest";
import { pluginRuntimeProfile } from "../plugin-runtime-profile";

describe("plugin runtime profile", () => {
  it("preserves the MCP client profile when a vendor owns the loop", () => {
    for (const harness of [undefined, "cursor", "claude-code", "opencode"]) {
      expect(pluginRuntimeProfile({ harness })).toBe("chatgpt");
    }
    expect(pluginRuntimeProfile({ harness: "codex" })).toBe("codex");
  });
});
