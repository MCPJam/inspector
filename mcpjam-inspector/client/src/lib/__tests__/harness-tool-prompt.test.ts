import { describe, expect, it } from "vitest";
import { buildHarnessToolPrompt } from "../harness-tool-prompt";

describe("buildHarnessToolPrompt", () => {
  it("names the tool and embeds the exact args as JSON", () => {
    const prompt = buildHarnessToolPrompt("Bash", { command: "ls -la" });
    expect(prompt).toContain("Use the Bash tool");
    expect(prompt).toContain("exactly once");
    expect(prompt).toContain('"command": "ls -la"');
    // The JSON block must parse back to the args.
    const json = prompt.slice(prompt.indexOf("{"));
    expect(JSON.parse(json)).toEqual({ command: "ls -la" });
  });

  it("uses the no-argument variant when args are empty", () => {
    const prompt = buildHarnessToolPrompt("Glob", {});
    expect(prompt).toContain("Use the Glob tool");
    expect(prompt).toContain("no arguments");
    expect(prompt).not.toContain("{");
  });

  it("drops undefined values (unset optional fields)", () => {
    const prompt = buildHarnessToolPrompt("Read", {
      file_path: "/tmp/x",
      offset: undefined,
    });
    const json = JSON.parse(prompt.slice(prompt.indexOf("{")));
    expect(json).toEqual({ file_path: "/tmp/x" });
  });

  it("preserves non-string arg types", () => {
    const prompt = buildHarnessToolPrompt("Bash", {
      command: "sleep 1",
      timeoutSeconds: 5,
      run_in_background: true,
    });
    const json = JSON.parse(prompt.slice(prompt.indexOf("{")));
    expect(json).toEqual({
      command: "sleep 1",
      timeoutSeconds: 5,
      run_in_background: true,
    });
  });
});
