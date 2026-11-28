import { describe, expect, it } from "vitest";
import {
  findHarnessToolNameCollisions,
  HarnessToolNameCollisionError,
  identifyHarnessTool,
  registerHostToolNames,
  runtimeToolNameSegment,
} from "../harness-tool-names";

const BITS = [
  "cad.tray",
  "cad.library",
  "settings.read",
  "settings.update",
  "ping",
];

describe("runtimeToolNameSegment", () => {
  it("replaces each character Claude Code rejects with an underscore", () => {
    expect(runtimeToolNameSegment("cad.tray")).toBe("cad_tray");
    expect(runtimeToolNameSegment("a b/c:d")).toBe("a_b_c_d");
    expect(runtimeToolNameSegment("keep-this_1")).toBe("keep-this_1");
  });
});

describe("findHarnessToolNameCollisions", () => {
  it("lets dotted names through when no two on a server merge", () => {
    expect(
      findHarnessToolNameCollisions("claude-code", new Map([["bits", BITS]])),
    ).toEqual([]);
  });

  it("reports tools on one server that Claude Code shows under one name", () => {
    const collisions = findHarnessToolNameCollisions(
      "claude-code",
      new Map([["shop", ["a_b", "a.b", "other"]]]),
    );
    expect(collisions).toEqual([
      { serverId: "shop", toolNames: ["a.b", "a_b"] },
    ]);
    expect(new HarnessToolNameCollisionError(collisions).message).toBe(
      "Claude Code can't run `a.b` and `a_b` in one turn because it gives them the same name. Rename one of them on its server, or run this client on MCPJam Harness.",
    );
  });

  it("names every group in one message", () => {
    expect(
      new HarnessToolNameCollisionError([
        { serverId: "shop", toolNames: ["a.b", "a:b", "a_b"] },
        { serverId: "docs", toolNames: ["x.y", "x_y"] },
      ]).message,
    ).toBe(
      "Claude Code can't run `a.b`, `a:b` and `a_b`, or `x.y` and `x_y` in one turn because it gives them the same name. Rename one of them on its server, or run this client on MCPJam Harness.",
    );
  });

  it("ignores the same names on different servers", () => {
    expect(
      findHarnessToolNameCollisions(
        "claude-code",
        new Map([
          ["one", ["a.b"]],
          ["two", ["a_b"]],
        ]),
      ),
    ).toEqual([]);
  });

  it("reports nothing for runtimes MCPJam names tools for", () => {
    const names = new Map([["shop", ["a_b", "a.b"]]]);
    expect(findHarnessToolNameCollisions("opencode", names)).toEqual([]);
    expect(findHarnessToolNameCollisions("codex", names)).toEqual([]);
  });
});

describe("registerHostToolNames", () => {
  it("registers valid names and maps each back to its server and tool", () => {
    const names = registerHostToolNames([
      {
        serverId: "bits",
        toolName: "cad.tray",
        baseName: "mcp__bits__cad.tray",
      },
      { serverId: "bits", toolName: "ping", baseName: "mcp__bits__ping" },
    ]);
    expect(names.wireName("bits", "cad.tray")).toBe("mcp__bits__cad_tray");
    expect(names.wireName("bits", "ping")).toBe("mcp__bits__ping");
    expect([...names.registry]).toEqual([
      ["mcp__bits__cad_tray", { serverId: "bits", toolName: "cad.tray" }],
      ["mcp__bits__ping", { serverId: "bits", toolName: "ping" }],
    ]);
  });

  it("keeps a colliding pair distinct with a suffix", () => {
    const names = registerHostToolNames([
      { serverId: "shop", toolName: "a.b", baseName: "mcp__shop__a.b" },
      { serverId: "shop", toolName: "a_b", baseName: "mcp__shop__a_b" },
    ]);
    const dotted = names.wireName("shop", "a.b");
    const underscored = names.wireName("shop", "a_b");
    expect(dotted).not.toBe(underscored);
    expect(names.registry.get(dotted)).toEqual({
      serverId: "shop",
      toolName: "a.b",
    });
    expect(names.registry.get(underscored)).toEqual({
      serverId: "shop",
      toolName: "a_b",
    });
  });

  it("truncates long names and still maps them back", () => {
    const toolName = `report.${"x".repeat(80)}`;
    const names = registerHostToolNames([
      { serverId: "bits", toolName, baseName: `mcp__bits__${toolName}` },
    ]);
    const wire = names.wireName("bits", toolName);
    expect(wire).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(names.registry.get(wire)).toEqual({ serverId: "bits", toolName });
  });

  it("throws for a tool it never registered", () => {
    const names = registerHostToolNames([]);
    expect(() => names.wireName("bits", "cad.tray")).toThrow(
      "No registered harness tool name for bits/cad.tray",
    );
  });
});

describe("identifyHarnessTool", () => {
  const serverToolNames = (serverId: string) =>
    serverId === "bits" ? BITS : [];
  const noRegistry = new Map();

  it("uses the registered identity before any parsed attribution", () => {
    const hostToolRegistry = new Map([
      ["mcp__bits__cad_tray", { serverId: "bits", toolName: "cad.tray" }],
    ]);
    expect(
      identifyHarnessTool({
        rawToolName: "mcp__bits__cad_tray",
        attributed: { serverId: "wrong", toolName: "cad_tray" },
        hostToolRegistry,
        serverToolNames,
      }),
    ).toEqual({ serverId: "bits", toolName: "cad.tray" });
  });

  it("uses the registered name Cursor wraps in the call's input", () => {
    const hostToolRegistry = new Map([
      ["mcp__shop__a_b", { serverId: "shop", toolName: "a_b" }],
      ["mcp__shop__a_b_2", { serverId: "shop", toolName: "a.b" }],
    ]);
    expect(
      identifyHarnessTool({
        rawToolName: "acp_tool_call",
        input: {
          providerIdentifier: "ai-sdk-harness-tools",
          toolName: "mcp__shop__a_b_2",
          args: {},
        },
        attributed: { serverId: "shop", toolName: "a_b_2" },
        hostToolRegistry,
        serverToolNames: () => ["a.b", "a_b"],
      }),
    ).toEqual({ serverId: "shop", toolName: "a.b" });
  });

  it("ignores a wrapped name from any other channel", () => {
    const hostToolRegistry = new Map([
      ["mcp__shop__a_b_2", { serverId: "shop", toolName: "a.b" }],
    ]);
    expect(
      identifyHarnessTool({
        rawToolName: "acp_tool_call",
        input: { providerIdentifier: "forged", toolName: "mcp__shop__a_b_2" },
        attributed: { toolName: "mcp__shop__a_b_2" },
        hostToolRegistry,
        serverToolNames: () => [],
      }),
    ).toEqual({ toolName: "mcp__shop__a_b_2" });
  });

  it("maps Claude Code's renamed tool back to the server's tool", () => {
    expect(
      identifyHarnessTool({
        rawToolName: "mcp__bits__cad_tray",
        attributed: { serverId: "bits", toolName: "cad_tray" },
        hostToolRegistry: noRegistry,
        serverToolNames,
      }),
    ).toEqual({ serverId: "bits", toolName: "cad.tray" });
  });

  it("keeps an exact match", () => {
    expect(
      identifyHarnessTool({
        rawToolName: "mcp__bits__ping",
        attributed: { serverId: "bits", toolName: "ping" },
        hostToolRegistry: noRegistry,
        serverToolNames,
      }),
    ).toEqual({ serverId: "bits", toolName: "ping" });
  });

  it("returns the attribution unchanged for an unknown or unattributed name", () => {
    for (const attributed of [
      { serverId: "bits", toolName: "nope" },
      { toolName: "Bash" },
    ]) {
      expect(
        identifyHarnessTool({
          rawToolName: "x",
          attributed,
          hostToolRegistry: noRegistry,
          serverToolNames,
        }),
      ).toEqual(attributed);
    }
  });

  it("returns the attribution unchanged when two tools rename to it", () => {
    expect(
      identifyHarnessTool({
        rawToolName: "mcp__shop__a_c",
        attributed: { serverId: "shop", toolName: "a_c" },
        hostToolRegistry: noRegistry,
        serverToolNames: () => ["a.c", "a:c"],
      }),
    ).toEqual({ serverId: "shop", toolName: "a_c" });
  });
});
