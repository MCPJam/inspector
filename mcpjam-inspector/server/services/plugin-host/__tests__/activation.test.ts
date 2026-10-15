import { describe, expect, it, vi } from "vitest";
import {
  pluginActivationFromCatalog,
  resolveOpenPluginActivation,
  resolvePluginActivation,
} from "../activation";
const source = {
  name: "library",
  inputSchema: { type: "object", properties: {} },
  _meta: {
    ui: { resourceUri: "ui://library" },
    "openai/ui": {
      entrypoints: [
        {
          type: "global",
          quickAction: {
            title: "Reference",
            icons: [{ src: "data:image/png;base64,aA==" }],
            target: {
              type: "tool",
              name: "reference",
              arguments: { value: 2 },
            },
          },
        },
      ],
    },
  },
};
const target = {
  name: "reference",
  inputSchema: {
    type: "object",
    properties: { value: { type: "number" } },
    required: ["value"],
  },
  _meta: { ui: { visibility: ["app"] } },
};
const selector = {
  kind: "quick-action" as const,
  requestId: "5fb21e6c-efc8-43bf-9fa5-264c70e31b58",
};
const snapshot = (tools = [source, target]) => ({
  tools,
  hostRevision: "host",
  bindingId: "binding",
  serverIdentity: { kind: "standalone", serverId: "server" },
});
const signal = () => AbortSignal.timeout(1000);
describe("declared quick action resolution", () => {
  it("derives the target and arguments from one freshly authorized catalog", async () => {
    const read = vi.fn(),
      catalog = vi.fn().mockResolvedValue(snapshot());
    const result = await resolvePluginActivation(
      { catalog } as never,
      source.name,
      selector,
      signal(),
      read,
    );
    expect(catalog).toHaveBeenCalledWith(expect.any(AbortSignal), read);
    expect(result.plan.params).toEqual({
      name: "reference",
      arguments: { value: 2 },
    });
    expect(result.presentation).toBe("result");
    expect(result.resourceUri).toBe("ui://library");
  });
  it("binds both source and target changes in the revision", async () => {
    const catalog = vi.fn().mockResolvedValue(snapshot());
    const first = await resolvePluginActivation(
      { catalog } as never,
      source.name,
      selector,
      signal(),
    );
    catalog.mockResolvedValue(
      snapshot([source, { ...target, title: "changed" } as typeof target]),
    );
    const second = await resolvePluginActivation(
      { catalog } as never,
      source.name,
      selector,
      signal(),
    );
    expect(second.revision).not.toBe(first.revision);
  });
  it("refuses missing targets and no-longer-declared actions", async () => {
    const catalog = vi.fn().mockResolvedValue(snapshot([source]));
    await expect(
      resolvePluginActivation(
        { catalog } as never,
        source.name,
        selector,
        signal(),
      ),
    ).rejects.toThrow();
    catalog.mockResolvedValue(
      snapshot([
        {
          ...source,
          _meta: { ui: { resourceUri: "ui://library" } },
        } as typeof source,
        target,
      ]),
    );
    await expect(
      resolvePluginActivation(
        { catalog } as never,
        source.name,
        selector,
        signal(),
      ),
    ).rejects.toThrow();
  });
});

describe("an open App's activation, re-resolved", () => {
  it("compares a quick action with the revision it opened with", async () => {
    // What activation/open stores for a quick action.
    const opened = pluginActivationFromCatalog(
      snapshot() as never,
      source.name,
      selector,
    );
    const catalog = vi.fn().mockResolvedValue(snapshot());
    const resolve = vi.fn();
    const current = await resolveOpenPluginActivation(
      { catalog, resolve } as never,
      {
        selector,
        toolName: opened.plan.params.name,
        sourceToolName: source.name,
      },
      signal(),
    );
    expect(current.revision).toBe(opened.revision);
    expect(resolve).not.toHaveBeenCalled();
    // A transfer re-resolves the target alone, which has its own revision.
    expect(
      "toolRevision" in current ? current.toolRevision : undefined,
    ).not.toBe(opened.revision);
  });
  it("resolves any other kind by its own tool", async () => {
    const catalog = vi.fn();
    const resolve = vi.fn().mockResolvedValue({ revision: "r" });
    await expect(
      resolveOpenPluginActivation(
        { catalog, resolve } as never,
        { selector: { kind: "thread" }, toolName: "library" },
        signal(),
      ),
    ).resolves.toEqual({ revision: "r" });
    expect(resolve).toHaveBeenCalledWith("library", expect.any(AbortSignal));
    expect(catalog).not.toHaveBeenCalled();
  });
});
