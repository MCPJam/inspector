import { describe, expect, it } from "vitest";
import {
  rehashPolicyFor,
  RUNTIME_REHASH_POLICIES,
} from "../runtime-rehash-policy.js";
import { SUPPORTED_LOCAL_HARNESS_IDS } from "../targets.js";

const matches = (harnessId: string, path: string) =>
  rehashPolicyFor(harnessId).strict.some((pattern) => pattern.test(path));

describe("which pack files are re-hashed before a spawn", () => {
  it("declares a policy for every supported harness", () => {
    expect(Object.keys(RUNTIME_REHASH_POLICIES).sort()).toEqual(
      [...SUPPORTED_LOCAL_HARNESS_IDS].sort(),
    );
  });

  it("covers what Claude Code executes", () => {
    expect(rehashPolicyFor("claude-code").always).toEqual(["launcher.mjs", "bridge.mjs"]);
    expect(matches("claude-code", "bin/node")).toBe(true);
    expect(
      matches("claude-code", "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"),
    ).toBe(true);
  });

  it("covers what Codex executes, in the layout @openai/codex@0.149.1 installs", () => {
    // Codex spawns the host-tool MCP entrypoint itself, so it is as much an
    // executable as the bridge.
    expect(rehashPolicyFor("codex").always).toContain("host-tools-mcp.mjs");
    for (const path of [
      "bin/node.exe",
      "node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
      "node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host",
      "node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap",
      "node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-path/rg",
      "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
    ]) {
      expect(matches("codex", path), path).toBe(true);
    }
    // Data files are covered by the stat snapshot, not re-read.
    expect(
      matches("codex", "node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-package.json"),
    ).toBe(false);
    // And one harness's binaries are not another's.
    expect(matches("claude-code", "node_modules/@openai/codex-linux-x64/vendor/x/bin/codex")).toBe(false);
  });

  it("gives an unknown harness only the bridge pair and Node, never a throw", () => {
    expect(rehashPolicyFor("toString").always).toEqual(["launcher.mjs", "bridge.mjs"]);
  });
});
