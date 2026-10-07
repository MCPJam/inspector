import { describe, expect, it } from "vitest";
import { describeHarnessToolStep } from "../harness-tool-steps";

describe("describeHarnessToolStep", () => {
  it.each([
    ["Read", { file_path: "/work/src/app.ts" }, "Read", "app.ts"],
    ["read", { path: "/work/README.md" }, "Read", "README.md"],
    ["Edit", { file_path: "C:\\work\\a.ts" }, "Edit", "a.ts"],
    [
      "Bash",
      { command: "npm test", description: "Run tests" },
      "Run",
      "Run tests",
    ],
    ["Bash", { command: "echo a\necho b" }, "Run", "echo a …"],
    ["Grep", { pattern: "TODO" }, "Search", "TODO"],
    ["Glob", { pattern: "**/*.md" }, "Find files", "**/*.md"],
    [
      "WebFetch",
      { url: "https://example.com" },
      "Fetch",
      "https://example.com",
    ],
    ["WebSearch", { query: "mcp spec" }, "Search the web", "mcp spec"],
    ["Agent", { description: "look closer" }, "Agent", "look closer"],
    ["mcp__linear__create_issue", { title: "x" }, "create_issue", "linear"],
    ["SomethingNew", { target: "thing", n: "" }, "SomethingNew", "thing"],
  ])("%s", (toolName, input, verb, detail) => {
    expect(describeHarnessToolStep(toolName, input)).toMatchObject({
      verb,
      detail,
    });
  });

  it("marks code apart from prose", () => {
    expect(describeHarnessToolStep("Read", { file_path: "/a.ts" }).code).toBe(
      true,
    );
    expect(describeHarnessToolStep("Bash", { command: "ls" }).code).toBe(true);
    expect(
      describeHarnessToolStep("Bash", { command: "ls", description: "List" })
        .code,
    ).toBeUndefined();
    expect(
      describeHarnessToolStep("WebSearch", { query: "mcp" }).code,
    ).toBeUndefined();
  });

  it("a step with nothing to show is its verb alone", () => {
    expect(describeHarnessToolStep("Read")).toEqual({ verb: "Read" });
    expect(describeHarnessToolStep("TodoWrite", { todos: "x" })).toEqual({
      verb: "Update todos",
    });
  });
});
