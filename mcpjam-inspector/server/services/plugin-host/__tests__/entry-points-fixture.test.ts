import { describe, expect, it } from "vitest";
import { createEntryPointsFixture } from "../testing/entry-points.js";
import {
  pluginEntrypointKinds,
  pluginQuickAction,
} from "../../../../shared/plugin-activation.js";
import {
  entrypointIssues,
  quickActionsShown,
  type EntrypointBehavior,
} from "../../../../shared/plugin-entry-checks.js";

const CLAUDE: EntrypointBehavior = {
  entrypointVisibility: "require-model",
  entrypointNames: "no-double-separators",
  entrypointQuickActions: "hide",
};
const CHATGPT: EntrypointBehavior = {
  entrypointVisibility: "ignore",
  entrypointNames: "any",
  entrypointQuickActions: "show",
};

type Tool = { name: string; _meta?: Record<string, unknown> };

function caller(url: string) {
  return async (method: string, params = {}) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    expect(response.status).toBe(200);
    return (await response.json()).result;
  };
}

async function withFixture(
  run: (
    call: ReturnType<typeof caller>,
    fixture: Awaited<ReturnType<typeof createEntryPointsFixture>>,
  ) => Promise<void>,
) {
  const fixture = await createEntryPointsFixture();
  try {
    await run(caller(fixture.url), fixture);
  } finally {
    await fixture.close();
  }
}

describe("entry-points fixture", () => {
  it("declares one global entry point per rule, each with an App", async () => {
    await withFixture(async (call, fixture) => {
      const { tools } = await call("tools/list");
      expect(tools.map((tool: Tool) => tool.name)).toEqual([
        "open_board",
        "app_only_panel",
        "foo__bar",
        "inline_note",
        "sketch",
      ]);
      for (const tool of tools as Tool[])
        expect(pluginEntrypointKinds(tool)).toEqual(["global"]);
      const { resources } = await call("resources/list");
      expect(resources).toHaveLength(5);
      const read = async (name: string) =>
        (await call("resources/read", { uri: `ui://entry/${name}` }))
          .contents[0];
      expect((await read("inline_note")).text).toContain(
        'availableDisplayModes: ["inline"]',
      );
      expect((await read("open_board")).text).toContain(
        'availableDisplayModes: ["inline", "fullscreen"]',
      );
      expect(fixture.activations.size).toBe(0);
      expect(
        await call("tools/call", { name: "inline_note", arguments: {} }),
      ).toEqual({ content: [{ type: "text", text: '{"activations":1}' }] });
      expect(fixture.activations.get("inline_note")).toBe(1);
    });
  });

  it("lists, refuses and hides what each client's rules say", async () => {
    await withFixture(async (call) => {
      const tools: Tool[] = (await call("tools/list")).tools;
      const listed = (behavior: EntrypointBehavior) =>
        tools
          .filter((tool) => !entrypointIssues(tool, behavior).hidden)
          .map((tool) => tool.name);
      const refused = (behavior: EntrypointBehavior) =>
        tools.flatMap((tool) =>
          entrypointIssues(tool, behavior).unopenable ? [tool.name] : [],
        );
      const sketch = tools.find((tool) => tool.name === "sketch")!;
      expect(pluginQuickAction(sketch)?.title).toBe("New sketch");

      expect(listed(CLAUDE)).toEqual([
        "open_board",
        "foo__bar",
        "inline_note",
        "sketch",
      ]);
      expect(refused(CLAUDE)).toEqual(["foo__bar"]);
      expect(quickActionsShown(CLAUDE)).toBe(false);

      expect(listed(CHATGPT)).toEqual(tools.map((tool) => tool.name));
      expect(refused(CHATGPT)).toEqual([]);
      expect(quickActionsShown(CHATGPT)).toBe(true);
    });
  });
});
