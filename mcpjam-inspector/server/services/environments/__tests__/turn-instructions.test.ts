import { describe, expect, it } from "vitest";
import {
  buildServerInstructions,
  type InstructionsSource,
} from "../turn-instructions";

/**
 * A manager whose connected keys sent these instructions. A key mapped to
 * `undefined` is connected but sent none; a key in `offline` is registered
 * with no live client, so the manager has no initialization info for it.
 */
function manager(
  sent: Record<string, string | undefined>,
  offline: readonly string[] = [],
): InstructionsSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    hasServer: (key) => key in sent || offline.includes(key),
    getInitializationInfo: (key) => {
      reads.push(key);
      return key in sent ? { instructions: sent[key] } : undefined;
    },
  };
}

const HEAD =
  "# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:";

describe("buildServerInstructions", () => {
  it("renders one subsection per server under Claude Code's heading", () => {
    expect(
      buildServerInstructions({
        manager: manager({ srv_docs: "Search before you answer." }),
        serverIds: ["srv_docs"],
        labels: { srv_docs: "Docs" },
      }),
    ).toBe(`${HEAD}\n\n## Docs\nSearch before you answer.`);
  });

  it("is empty when no selected server sent instructions", () => {
    const source = manager({ srv_a: undefined, srv_b: "   \n" });
    expect(
      buildServerInstructions({ manager: source, serverIds: ["srv_a", "srv_b"] }),
    ).toBe("");
    expect(buildServerInstructions({ manager: source, serverIds: [] })).toBe("");
  });

  it("reads only the selected servers", () => {
    const section = buildServerInstructions({
      manager: manager({ srv_a: "Use A.", srv_b: "Use B." }),
      serverIds: ["srv_a"],
    });
    expect(section).toContain("Use A.");
    expect(section).not.toContain("Use B.");
  });

  it("adds nothing for a server that is not connected or not registered", () => {
    const source = manager({ srv_live: "Live text." }, ["srv_offline"]);
    expect(
      buildServerInstructions({
        manager: source,
        serverIds: ["srv_offline", "srv_unknown"],
      }),
    ).toBe("");
    expect(source.reads).toEqual(["srv_offline"]);
  });

  it("leaves out a server the turn runs without, though it sent instructions", () => {
    const section = buildServerInstructions({
      manager: manager({ srv_ok: "Fine.", srv_failed: "Tools you lack." }),
      serverIds: ["srv_ok", "srv_failed"],
      unavailable: new Set(["srv_failed"]),
    });
    expect(section).toContain("Fine.");
    expect(section).not.toContain("Tools you lack.");
  });

  it("heads a server by its label, else its id, sorted by heading", () => {
    expect(
      buildServerInstructions({
        manager: manager({ srv_z: "Zed.", srv_a: "Ay.", k17abc: "Opaque." }),
        serverIds: ["srv_z", "srv_a", "k17abc"],
        labels: { srv_z: "  Alpha  ", srv_a: "Beta", k17abc: " " },
      }),
    ).toBe(`${HEAD}\n\n## Alpha\nZed.\n\n## Beta\nAy.\n\n## k17abc\nOpaque.`);
  });

  it("keeps the text verbatim apart from surrounding whitespace", () => {
    const text = "Line one.\n\n- a list item\n# a heading the server wrote";
    expect(
      buildServerInstructions({
        manager: manager({ srv: `\n  ${text}  \n` }),
        serverIds: ["srv"],
      }),
    ).toBe(`${HEAD}\n\n## srv\n${text}`);
  });

  it("lists two servers that sent the same text separately", () => {
    const section = buildServerInstructions({
      manager: manager({ srv_a: "Same words.", srv_b: "Same words." }),
      serverIds: ["srv_a", "srv_b"],
      labels: { srv_a: "A", srv_b: "B" },
    });
    expect(section.split("Same words.")).toHaveLength(3);
    expect(section).toContain("## A\nSame words.");
    expect(section).toContain("## B\nSame words.");
  });

  it("lists a server once when the selection names it twice", () => {
    const section = buildServerInstructions({
      manager: manager({ srv: "Once." }),
      serverIds: ["srv", "srv"],
    });
    expect(section.split("Once.")).toHaveLength(2);
  });

  describe("a server connected with several accounts", () => {
    const connection = (key: string, label: string) => ({
      serverId: "srv_mail",
      connectionId: key,
      key,
      label,
    });
    const groups = {
      srv_mail: [connection("mail::work", "work"), connection("mail::home", "home")],
    };

    it("appears once when its connections sent the same text", () => {
      const section = buildServerInstructions({
        manager: manager({ "mail::work": "Mail rules.", "mail::home": "Mail rules." }),
        serverIds: ["srv_mail"],
        groups,
        labels: { srv_mail: "Mail" },
      });
      expect(section).toBe(`${HEAD}\n\n## Mail\nMail rules.`);
    });

    it("appears once per connection when their texts differ", () => {
      const section = buildServerInstructions({
        manager: manager({ "mail::work": "Work rules.", "mail::home": "Home rules." }),
        serverIds: ["srv_mail"],
        groups,
        labels: { srv_mail: "Mail" },
      });
      expect(section).toBe(
        `${HEAD}\n\n## Mail (home)\nHome rules.\n\n## Mail (work)\nWork rules.`,
      );
    });

    it("appears once when only one connection sent any", () => {
      const section = buildServerInstructions({
        manager: manager({ "mail::work": "Work rules.", "mail::home": undefined }),
        serverIds: ["srv_mail"],
        groups,
        labels: { srv_mail: "Mail" },
      });
      expect(section).toBe(`${HEAD}\n\n## Mail\nWork rules.`);
    });
  });

  it("reads the text current at the call, so a replaced server shows only its replacement's", () => {
    const sent: Record<string, string | undefined> = { srv: "ORIGINAL-7Q2" };
    const source = manager(sent);
    const build = () =>
      buildServerInstructions({ manager: source, serverIds: ["srv"] });
    expect(build()).toContain("ORIGINAL-7Q2");
    sent.srv = "REPLACEMENT-4K9";
    expect(build()).toContain("REPLACEMENT-4K9");
    expect(build()).not.toContain("ORIGINAL-7Q2");
    sent.srv = "ORIGINAL-7Q2";
    expect(build()).not.toContain("REPLACEMENT-4K9");
  });
});
