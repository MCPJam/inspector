import { describe, expect, it } from "vitest";
import {
  describeHarnessToolStep,
  harnessToolTarget,
  isHarnessActivityToolName,
} from "../harness-tool-steps";

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

describe("Codex steps", () => {
  it("a command Codex parsed reads as what it does", () => {
    const action = (a: Record<string, unknown>) => ({
      command: "x",
      commandActions: [a],
    });
    expect(
      describeHarnessToolStep(
        "bash",
        action({ type: "read", name: "app.ts", path: "/w/src/app.ts" }),
      ),
    ).toMatchObject({ verb: "Read", detail: "app.ts", title: "/w/src/app.ts" });
    expect(
      describeHarnessToolStep(
        "bash",
        action({ type: "listFiles", path: "src" }),
      ),
    ).toMatchObject({ verb: "List files", detail: "src" });
    expect(
      describeHarnessToolStep(
        "bash",
        action({ type: "search", query: "TODO", command: "rg TODO" }),
      ),
    ).toMatchObject({ verb: "Search", detail: "TODO" });
    // Unknown, or more than one action: the shell line.
    expect(
      describeHarnessToolStep("bash", {
        command: "make",
        commandActions: [{ type: "unknown", command: "make" }],
      }),
    ).toMatchObject({ verb: "Run", detail: "make" });
  });

  it("a file change names its file, or how many", () => {
    expect(
      describeHarnessToolStep("fileChange", {
        changes: [{ path: "/w/a.ts", kind: "update" }],
      }),
    ).toMatchObject({ verb: "Edit", detail: "a.ts" });
    expect(
      describeHarnessToolStep("fileChange", {
        changes: [{ path: "/w/a.ts" }, { path: "/w/b.ts" }],
      }),
    ).toMatchObject({ verb: "Edit", detail: "2 files" });
  });
});

describe("activity", () => {
  it("built-ins get a step label; MCP tools, the Agent card and questions do not", () => {
    for (const name of [
      "bash",
      "Read",
      "edit",
      "fileChange",
      "webSearch",
      "Grep",
      "TodoWrite",
    ]) {
      expect(isHarnessActivityToolName(name)).toBe(true);
    }
    for (const name of [
      "Agent",
      "AskUserQuestion",
      "ExitPlanMode",
      "create_issue",
      "mcp__x__y",
    ]) {
      expect(isHarnessActivityToolName(name)).toBe(false);
    }
  });
});

describe("harnessToolTarget", () => {
  it("is what literally runs or changes, never the model's description", () => {
    expect(
      harnessToolTarget("bash", {
        command: "rm -rf build",
        description: "Clean up",
        commandActions: [{ type: "unknown", command: "rm -rf build" }],
      }),
    ).toBe("rm -rf build");
    expect(harnessToolTarget("Edit", { file_path: "/w/a.ts" })).toBe("/w/a.ts");
    expect(
      harnessToolTarget("fileChange", {
        changes: [{ path: "/w/a.ts" }, { path: "/w/b.ts" }],
      }),
    ).toBe("/w/a.ts, /w/b.ts");
    expect(harnessToolTarget("WebFetch", { url: "https://x.dev" })).toBe(
      "https://x.dev",
    );
    expect(harnessToolTarget("TodoWrite", { todos: "x" })).toBeUndefined();
  });
});
