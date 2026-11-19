import { describe, expect, it } from "vitest";
import {
  entrypointIssues,
  hiddenEntrypointDiagnostics,
  LIST_EVERY_ENTRYPOINT,
  quickActionsShown,
  unopenableEntrypointTitle,
  type EntrypointBehavior,
} from "../plugin-entry-checks.js";

const CLAUDE: EntrypointBehavior = {
  entrypointVisibility: "require-model",
  entrypointNames: "no-double-separators",
  entrypointQuickActions: "hide",
};

const tool = (name: string, visibility?: unknown) => ({
  name,
  _meta: {
    ui: {
      resourceUri: "ui://fixture",
      ...(visibility === undefined ? {} : { visibility }),
    },
  },
});

describe("entrypointIssues under Claude's rules", () => {
  it.each([
    ["no visibility", undefined, {}],
    ["model only", ["model"], {}],
    ["model and app", ["app", "model"], {}],
    ["app only", ["app"], { hidden: "visibility" }],
    ["an empty list", [], { hidden: "visibility" }],
    // Not a list: it declares nothing, as everywhere else MCPJam reads it.
    ["a string", "app", {}],
  ])("a tool with %s", (_label, visibility, issues) => {
    expect(entrypointIssues(tool("open", visibility), CLAUDE)).toEqual(issues);
  });

  it.each([
    ["open_now", undefined],
    ["v1.open", undefined],
    ["foo__bar", ["__"]],
    ["foo..bar", [".."]],
    ["foo._bar", ["._"]],
    ["foo_.bar", ["_."]],
    ["a__b..c._d", ["__", "..", "._"]],
    ["___", ["__"]],
  ])("%s is unopenable for %j", (name, pairs) => {
    expect(entrypointIssues(tool(name), CLAUDE).unopenable).toEqual(pairs);
  });

  it("reports both issues on one tool", () => {
    expect(entrypointIssues(tool("foo__bar", ["app"]), CLAUDE)).toEqual({
      hidden: "visibility",
      unopenable: ["__"],
    });
  });

  it("checks each rule on its own", () => {
    expect(
      entrypointIssues(tool("foo__bar", ["app"]), {
        ...CLAUDE,
        entrypointVisibility: "ignore",
      }),
    ).toEqual({ unopenable: ["__"] });
    expect(
      entrypointIssues(tool("foo__bar", ["app"]), {
        ...CLAUDE,
        entrypointNames: "any",
      }),
    ).toEqual({ hidden: "visibility" });
  });
});

describe("ChatGPT's rules", () => {
  it("list and open every entry point, with or without rules given", () => {
    for (const behavior of [LIST_EVERY_ENTRYPOINT, undefined])
      expect(entrypointIssues(tool("foo__bar", ["app"]), behavior)).toEqual({});
    expect(quickActionsShown(LIST_EVERY_ENTRYPOINT)).toBe(true);
    expect(quickActionsShown(undefined)).toBe(true);
    expect(quickActionsShown(CLAUDE)).toBe(false);
  });
});

describe("Logs entries", () => {
  it("names the hidden tools in one row, and nothing when none are", () => {
    expect(hiddenEntrypointDiagnostics([], "server")).toEqual([]);
    const [row, ...rest] = hiddenEntrypointDiagnostics(
      ["app-only", "settings-panel"],
      "server",
    );
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      level: "warning",
      code: "PLUGIN_ENTRYPOINT_HIDDEN",
      serverId: "server",
      details: { tools: ["app-only", "settings-panel"] },
    });
    expect(row.description).toContain("_meta.ui.visibility");
  });

  it("names the characters a refused open found", () => {
    expect(unopenableEntrypointTitle("foo__bar", ["__"])).toBe(
      'Entry point refused: foo__bar has "__" in its name',
    );
    expect(unopenableEntrypointTitle("a__b..c", ["__", ".."])).toBe(
      'Entry point refused: a__b..c has "__" and ".." in its name',
    );
  });
});
