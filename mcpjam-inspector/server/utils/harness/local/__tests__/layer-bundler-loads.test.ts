/**
 * The layer bundler loads server modules to build each bridge, in the pack
 * workflow, where nothing has built the SDK. A module on that path that
 * reaches the SDK's build (`shared/harness-descriptors` does) can't be
 * loaded there, no pack gets built, and nothing else says so until a pack is
 * published. The SDK's entry is made unavailable here, as it is in that
 * workflow.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@mcpjam/sdk/host-config/internal", () => {
  throw new Error("the SDK build is not available where packs are built");
});

describe("the modules the layer bundler loads", () => {
  it("load without the SDK's build", async () => {
    for (const module of [
      "../../claude-code-bootstrap.js",
      "../../cursor-local-bridge.js",
      "../../opencode-local-bridge.js",
    ]) {
      await expect(import(module), module).resolves.toBeDefined();
    }
  });
});
