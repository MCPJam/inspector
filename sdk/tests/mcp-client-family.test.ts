import { describe, expect, it } from "vitest";
import {
  MCP_CLIENT_FAMILIES,
  mcpClientFamily,
} from "../src/internal/telemetry.js";

describe("mcpClientFamily", () => {
  it.each([
    ["claude-code", "claude-code"],
    ["Claude Code", "claude-code"],
    ["claude-ai", "claude-ai"],
    ["cursor-vscode", "cursor"],
    ["Visual Studio Code", "vscode"],
    ["codex-mcp-client", "codex"],
    ["openai-mcp", "chatgpt"],
    ["gemini-cli-mcp-client", "gemini-cli"],
    ["mcpjam-inspector", "mcpjam"],
    ["my-company-bot", "other"],
  ])("%s → %s", (name, family) => {
    expect(mcpClientFamily(name)).toBe(family);
  });

  it("names nothing for a missing or blank name", () => {
    expect(mcpClientFamily(undefined)).toBeUndefined();
    expect(mcpClientFamily("   ")).toBeUndefined();
  });

  it("only ever returns a listed family", () => {
    for (const name of ["x", "claude", "ZED editor", "a".repeat(1000)]) {
      expect(MCP_CLIENT_FAMILIES).toContain(mcpClientFamily(name));
    }
  });
});
