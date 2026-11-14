import { describe, expect, it } from "vitest";
import {
  pluginEntrypointPlan,
  pluginEntrypointKinds,
  pluginEntrypointTitle,
  pluginEntrypointDiagnostics,
  pluginFileEntrypoints,
  pluginQuickAction,
} from "../plugin-activation.js";

const tool = {
  name: "fixture-app",
  _meta: {
    ui: { visibility: ["model"] },
    "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] },
  },
};
describe("minimal shared entrypoint plan", () => {
  it("derives a quick action target and complete declared arguments without a caller override", () => {
    const action = {
      title: "Create table",
      icons: [{ src: "https://example.com/plus.svg" }],
      target: {
        type: "tool",
        name: "create",
        arguments: { nested: { values: [1, "a", null] }, enabled: false },
      },
    };
    const source = {
      name: "library",
      _meta: {
        "openai/ui": { entrypoints: [{ type: "global", quickAction: action }] },
      },
    };
    const selector = {
      kind: "quick-action" as const,
      requestId: crypto.randomUUID(),
    };
    const plan = pluginEntrypointPlan(source, selector);
    expect(plan).toEqual({
      selector,
      params: { name: "create", arguments: action.target.arguments },
      scope: { kind: "global" },
    });
    (plan.params.arguments as any).nested.values.push("modified");
    expect(pluginQuickAction(source)).toEqual(action);
    expect(pluginEntrypointKinds(source)).toEqual(["global"]);
    for (const extra of [
      { arguments: {} },
      { target: "foreign" },
      { requestId: "client-operation" },
    ])
      expect(() =>
        pluginEntrypointPlan(source, { ...selector, ...extra } as never),
      ).toThrow();
  });
  it("rejects absent, malformed, ambiguous and non-global quick action declarations", () => {
    const action = {
      title: "Create",
      icons: [{ src: "https://example.com/icon.svg" }],
      target: { type: "tool", name: "create" },
    };
    for (const entrypoints of [
      [{ type: "global" }],
      [{ type: "thread", quickAction: action }],
      [{ type: "global", quickAction: { ...action, icons: [] } }],
      [
        { type: "global", quickAction: action },
        { type: "global", quickAction: action },
      ],
    ]) {
      const source = {
        name: "library",
        _meta: { "openai/ui": { entrypoints } },
      };
      expect(pluginQuickAction(source)).toBeUndefined();
      expect(() =>
        pluginEntrypointPlan(source, {
          kind: "quick-action",
          requestId: crypto.randomUUID(),
        }),
      ).toThrow();
    }
    expect(
      pluginEntrypointPlan(
        {
          name: "library",
          _meta: {
            "openai/ui": {
              entrypoints: [{ type: "global", quickAction: action }],
            },
          },
        },
        { kind: "quick-action", requestId: crypto.randomUUID() },
      ).params,
    ).toEqual({ name: "create", arguments: {} });
  });
  it("deduplicates entrypoint affordances without inventing undeclared kinds", () => {
    expect(
      pluginEntrypointKinds({
        _meta: {
          "openai/ui": {
            entrypoints: [
              { type: "global" },
              { type: "global" },
              { type: "settings" },
              { type: "file", extensions: [".csv"] },
            ],
          },
        },
      }),
    ).toEqual(["global"]);
  });
  it("resolves catalog titles in order and falls back past blank labels", () => {
    expect(
      pluginEntrypointTitle({
        name: "call",
        title: "Display",
        annotations: { title: "Old display" },
      }),
    ).toBe("Display");
    expect(
      pluginEntrypointTitle({
        name: "call",
        title: " ",
        annotations: { title: "Old display" },
      }),
    ).toBe("Old display");
    expect(pluginEntrypointTitle({ name: "call" })).toBe("call");
  });
  it("ignores an unrecognized declaration without dropping the tool's other entrypoints", () => {
    const mixed = {
      name: "library",
      _meta: {
        "openai/ui": {
          entrypoints: [
            { type: "settings", searchTerms: ["Theme"] },
            { type: "global" },
            { type: "thread", extra: true },
            { type: "thread" },
          ],
        },
      },
    };
    expect(pluginEntrypointKinds(mixed)).toEqual(["global", "thread"]);
    expect(pluginEntrypointDiagnostics([tool, mixed], "server-1")).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "PLUGIN_ENTRYPOINT_UNRECOGNIZED",
        serverId: "server-1",
        details: { tools: ["library"] },
      }),
    ]);
    expect(pluginEntrypointDiagnostics([tool], "server-1")).toEqual([]);
    expect(pluginEntrypointKinds({ _meta: { "openai/ui": {} } })).toEqual([]);
  });
  it("refuses a settings selector because no tool declares a settings entrypoint", () => {
    expect(() =>
      pluginEntrypointPlan(
        {
          name: "configure",
          _meta: { "openai/ui": { entrypoints: [{ type: "settings" }] } },
        },
        { kind: "settings" },
      ),
    ).toThrow("PLUGIN_ENTRYPOINT_UNAVAILABLE");
  });
  it("collects file declarations without accepting a file path or execution grant", () => {
    const tools = [
      tool,
      {
        name: "view",
        annotations: { title: "File viewer" },
        _meta: {
          "openai/ui": {
            entrypoints: [
              { type: "file", extensions: [".csv", ".csv"] },
              { type: "file", extensions: [".tsv"] },
            ],
          },
        },
      },
    ];
    expect(pluginFileEntrypoints(tools)).toEqual([
      { toolName: "view", title: "File viewer", extensions: [".csv", ".tsv"] },
    ]);
    expect(() =>
      pluginEntrypointPlan(tools[1], { kind: "file" } as never),
    ).toThrow();
  });
  it("derives empty arguments and the declared global/current-thread scope", () => {
    expect(pluginEntrypointPlan(tool, { kind: "global" })).toEqual({
      selector: { kind: "global" },
      params: { name: "fixture-app", arguments: {} },
      scope: { kind: "global" },
    });
    expect(
      pluginEntrypointPlan(tool, { kind: "thread", threadId: "thread-a" })
        .scope,
    ).toEqual({ kind: "thread", threadId: "thread-a" });
  });
  it("refuses undeclared entrypoints, malformed metadata, unsupported kinds and extra arguments", () => {
    for (const _meta of [
      undefined,
      {},
      {
        "openai/ui": { entrypoints: [{ type: "file", extensions: [".stl"] }] },
      },
      { "openai/ui": { entrypoints: [{ type: "global", madeUp: true }] } },
    ])
      expect(() =>
        pluginEntrypointPlan({ name: "fixture", _meta }, { kind: "global" }),
      ).toThrow();
    for (const selection of [
      { kind: "file" },
      { kind: "thread", threadId: "" },
      { kind: "global", arguments: { forged: true } },
    ])
      expect(() => pluginEntrypointPlan(tool, selection as never)).toThrow();
  });
});

describe("the plan under a client's entry-point rules", () => {
  const CLAUDE = {
    entrypointVisibility: "require-model",
    entrypointNames: "no-double-separators",
    entrypointQuickActions: "hide",
  } as const;
  const action = {
    title: "Create",
    icons: [{ src: "https://example.com/icon.svg" }],
    target: { type: "tool", name: "create" },
  };
  const source = (name: string, visibility?: string[]) => ({
    name,
    _meta: {
      ui: {
        resourceUri: "ui://fixture",
        ...(visibility ? { visibility } : {}),
      },
      "openai/ui": { entrypoints: [{ type: "global", quickAction: action }] },
    },
  });
  const quickAction = () =>
    ({ kind: "quick-action", requestId: crypto.randomUUID() }) as const;

  it("refuses a quick action while quick actions are hidden", () => {
    expect(() =>
      pluginEntrypointPlan(source("library"), quickAction(), CLAUDE),
    ).toThrow("PLUGIN_QUICK_ACTION_UNAVAILABLE");
    expect(
      pluginEntrypointPlan(source("library"), quickAction(), {
        ...CLAUDE,
        entrypointQuickActions: "show",
      }).params.name,
    ).toBe("create");
  });

  it("refuses a quick action on a tool hidden from the model", () => {
    expect(() =>
      pluginEntrypointPlan(source("library", ["app"]), quickAction(), {
        ...CLAUDE,
        entrypointQuickActions: "show",
      }),
    ).toThrow("PLUGIN_QUICK_ACTION_UNAVAILABLE");
  });

  it("refuses to open a name with double separators", () => {
    expect(() =>
      pluginEntrypointPlan(source("foo__bar"), { kind: "global" }, CLAUDE),
    ).toThrow("PLUGIN_ENTRYPOINT_UNOPENABLE");
    expect(
      pluginEntrypointPlan(source("foo_bar"), { kind: "global" }, CLAUDE)
        .params,
    ).toEqual({ name: "foo_bar", arguments: {} });
  });

  it("keeps ChatGPT's plan, and an open App's re-resolution, as before", () => {
    for (const behavior of [
      undefined,
      {
        entrypointVisibility: "ignore",
        entrypointNames: "any",
        entrypointQuickActions: "show",
      } as const,
    ]) {
      expect(
        pluginEntrypointPlan(
          source("foo__bar", ["app"]),
          quickAction(),
          behavior,
        ).params.name,
      ).toBe("create");
      expect(
        pluginEntrypointPlan(source("foo__bar"), { kind: "global" }, behavior)
          .params.name,
      ).toBe("foo__bar");
    }
  });
});
