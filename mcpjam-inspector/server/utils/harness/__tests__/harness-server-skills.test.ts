/**
 * A harness turn's MCP-server skills through MCPJam's skill tools: what the
 * turn serves from each source, that the tools never ask, and the transcript
 * the held entry and the command gate read.
 */
import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { renderUserContextText } from "../../../../shared/user-context-message";
import { buildServerSkillToolOutput } from "../../../../shared/server-skill-banner";
import { resolveEffectiveCapabilities } from "../../../services/environments/effective-capabilities";
import {
  authoredPin,
  evalEnvironment,
  pluginPin,
  preparedRunSkills,
  serverPin,
} from "../../../test/support/skill-delivery";
import {
  FILE_TEXT,
  FILE_URI,
  MARKDOWN,
  SKILL_URI,
  makeServerSkillWire,
  sha256,
} from "../../../test/support/server-skill-wire";
import {
  harnessServerSkills,
  servesServerSkills,
  withServedSkills,
  withServerSkillTools,
} from "../harness-server-skills";
import { getHarnessAdapter } from "../registry";

type ToolCall = (input: unknown, options: unknown) => Promise<unknown>;
type TurnArgs = Parameters<typeof harnessServerSkills>[1];

/** A hosted Codex turn's server skills. */
async function serve(args: Omit<TurnArgs, "localUnattended">) {
  const turn = await harnessServerSkills(getHarnessAdapter("codex"), {
    localUnattended: false,
    ...args,
  });
  if (!turn) throw new Error("Codex serves server skills through the tools.");
  return turn;
}

function toolOf(tools: Record<string, unknown>, name: string) {
  return tools[name] as { execute: ToolCall; needsApproval?: unknown };
}

const NO_SERVERS = { getSkillsSupport: () => ({ active: false }) } as never;

describe("which turns serve server skills through the tools", () => {
  it("is a runtime whose descriptor says so, where the gate can hold commands", () => {
    expect(
      servesServerSkills(getHarnessAdapter("claude-code"), {
        localUnattended: false,
      }),
    ).toBe(true);
    expect(
      servesServerSkills(getHarnessAdapter("codex"), {
        localUnattended: false,
      }),
    ).toBe(true);
  });

  it("is not a local eval or swarm, which asks before no command", () => {
    expect(
      servesServerSkills(getHarnessAdapter("codex"), { localUnattended: true }),
    ).toBe(false);
  });

  it("is not a runtime that takes no skills yet", () => {
    for (const id of ["cursor", "opencode", "copilot-cli"]) {
      expect(
        servesServerSkills(getHarnessAdapter(id), { localUnattended: false }),
      ).toBe(false);
    }
  });

  it("builds nothing for a turn that serves none", async () => {
    const run = await preparedRunSkills();
    const turn = {
      mode: "pinned" as const,
      pinnedHarnessSkills: run.pinnedHarnessSkills,
      manager: NO_SERVERS,
      serverIds: [],
      messages: [],
    };
    expect(
      await harnessServerSkills(getHarnessAdapter("codex"), {
        ...turn,
        localUnattended: true,
      }),
    ).toBeUndefined();
    expect(
      await harnessServerSkills(getHarnessAdapter("cursor"), {
        ...turn,
        localUnattended: false,
      }),
    ).toBeUndefined();
  });
});

describe("whether the gate holds the turn", () => {
  it("does when the turn offers server skills", async () => {
    const turn = await serve({
      mode: "pinned",
      pinnedHarnessSkills: (await preparedRunSkills()).pinnedHarnessSkills,
      manager: NO_SERVERS,
      serverIds: [],
      messages: [],
    });
    expect(turn.gated).toBe(true);
  });

  it("does when the conversation already holds one, with no tools to offer", async () => {
    const picked = renderUserContextText({
      kind: "skill",
      subject: "docs/search",
      body: buildServerSkillToolOutput({
        ref: "docs/search",
        serverLabel: "Docs",
        skillUri: "skill://docs/search",
        content: "# Search",
      }),
    });
    const turn = await serve({
      mode: "live",
      manager: NO_SERVERS,
      serverIds: [],
      messages: [{ role: "user", content: [{ type: "text", text: picked }] }],
    });
    expect(turn.tools).toEqual({});
    expect(turn.gated).toBe(true);
  });

  it("does not otherwise, and the runtime keeps its own mode", async () => {
    const turn = await serve({
      mode: "live",
      manager: NO_SERVERS,
      serverIds: [],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(turn.gated).toBe(false);
  });
});

describe("the turn's box report", () => {
  const written = { delivered: [], notDelivered: [], failed: [] };

  it("names the captured skills the tools served", async () => {
    const turn = await serve({
      mode: "pinned",
      pinnedHarnessSkills: (await preparedRunSkills()).pinnedHarnessSkills,
      manager: NO_SERVERS,
      serverIds: [],
      messages: [],
    });
    expect(withServedSkills(written, turn)).toEqual({
      ...written,
      servedByTools: [{ skillId: "ss_docs_search", name: "search" }],
    });
  });

  it("is the box writer's own when the tools served none", async () => {
    const turn = await serve({
      mode: "live",
      manager: NO_SERVERS,
      serverIds: [],
      messages: [],
    });
    expect(withServedSkills(written, turn)).toBe(written);
    expect(withServedSkills(written, undefined)).toBe(written);
  });
});

describe("a pinned run's server skills", () => {
  /** The eval fixture, its server skill captured with its body's digest. */
  async function pinnedTurn(messages: ModelMessage[] = []) {
    const run = await preparedRunSkills([
      authoredPin(),
      pluginPin(),
      serverPin({ contentHash: await sha256("# Search") }),
    ]);
    return serve({
      mode: "pinned",
      pinnedHarnessSkills: run.pinnedHarnessSkills,
      manager: NO_SERVERS,
      serverIds: [],
      messages,
    });
  }

  it("serves the captured skill, named by its server, and nothing else", async () => {
    const turn = await pinnedTurn();
    expect(Object.keys(turn.tools).sort()).toEqual([
      "listSkillFiles",
      "loadSkill",
      "readSkillFile",
    ]);
    expect(turn.promptSection).toContain(
      "- **docs/search** (MCP server Docs@v2): Search the docs server.",
    );
    expect(turn.promptSection).not.toContain("release-notes");
    expect(turn.promptSection).toContain("not in your skills folder");
    expect(turn.served).toEqual([
      { skillId: "ss_docs_search", name: "search" },
    ]);
  });

  it("loads it as MCPJam's agent does in the same run: the capture, behind its origin banner", async () => {
    const turn = await pinnedTurn();
    const loaded = await toolOf(turn.tools, "loadSkill").execute(
      { name: "docs/search" },
      { toolCallId: "call-1", messages: [] },
    );
    expect(loaded).toContain(
      '> Origin: MCP server "Docs" (skill://docs/search), captured v2 on 2023-11-14',
    );
    expect(loaded).toContain("# Search");
  });

  it("never asks before a load or a read", async () => {
    const turn = await pinnedTurn();
    for (const tool of Object.values(turn.tools)) {
      expect(tool).not.toHaveProperty("needsApproval");
    }
  });

  it("marks the skill in use once the runtime loads it, before the result goes back", async () => {
    const turn = await pinnedTurn();
    expect(turn.transcript.inUse()).toBe(false);
    await toolOf(turn.tools, "loadSkill").execute(
      { name: "docs/search" },
      { toolCallId: "call-1", messages: [] },
    );
    expect(turn.transcript.inUse()).toBe(true);
    expect(turn.transcript.messages()).toHaveLength(2);
  });

  it("is in use from the start when the conversation already holds a picked server skill", async () => {
    const picked = renderUserContextText({
      kind: "skill",
      subject: "docs/search",
      body: buildServerSkillToolOutput({
        ref: "docs/search",
        serverLabel: "Docs",
        skillUri: "skill://docs/search",
        content: "# Search",
      }),
    });
    const turn = await pinnedTurn([
      { role: "user", content: [{ type: "text", text: picked }] },
    ]);
    expect(turn.transcript.inUse()).toBe(true);
  });
});

describe("an environment turn's captured server skills", () => {
  it("serves them from the environment's set", async () => {
    const { spec, attribution } = evalEnvironment();
    const turn = await serve({
      mode: "environment",
      effectiveCapabilities: resolveEffectiveCapabilities(spec, attribution),
      manager: NO_SERVERS,
      serverIds: [],
      messages: [],
    });
    expect(turn.promptSection).toContain("**docs/search**");
    expect(turn.served).toEqual([
      { skillId: "ss_docs_search", name: "search" },
    ]);
  });
});

describe("a live turn's connected servers' skills", () => {
  it("serves what the servers list, addressed by server id", async () => {
    const wire = await makeServerSkillWire();
    const turn = await serve({
      mode: "live",
      manager: wire,
      serverIds: ["srv1"],
      messages: [],
    });
    expect(turn.promptSection).toContain("**srv1/refunds**");
    // Not captured with a plan, so not counted against one.
    expect(turn.served).toEqual([]);
    const loaded = await toolOf(turn.tools, "loadSkill").execute(
      { name: "srv1/refunds" },
      { toolCallId: "call-1", messages: [] },
    );
    expect(loaded).toContain('> Origin: MCP server "srv1"');
  });

  it("serves nothing, and offers no tools, when no server serves skills", async () => {
    const turn = await serve({
      mode: "live",
      manager: await makeServerSkillWire({ active: false }),
      serverIds: ["srv1"],
      messages: [],
    });
    expect(turn.tools).toEqual({});
    expect(turn.promptSection).toBe("");
  });

  it("refuses a file read on a later turn once the server changed the skill", async () => {
    const first = await serve({
      mode: "live",
      manager: await makeServerSkillWire(),
      serverIds: ["srv1"],
      messages: [],
    });
    await toolOf(first.tools, "loadSkill").execute(
      { name: "srv1/refunds" },
      { toolCallId: "call-1", messages: [] },
    );
    // The next turn receives the conversation, the load included, and its
    // server now lists a changed manifest.
    const changed = await makeServerSkillWire();
    changed.listServerSkills.mockImplementation(async () => ({
      skills: [
        {
          uri: SKILL_URI,
          frontmatter: { name: "refunds", description: "Handle refunds." },
          resources: [
            { uri: SKILL_URI, digest: `sha256:${await sha256(MARKDOWN)}` },
            { uri: FILE_URI, digest: `sha256:${await sha256(FILE_TEXT)}` },
            {
              uri: "skill://acme/refunds/scripts/new.py",
              digest: `sha256:${"0".repeat(64)}`,
            },
          ],
        },
      ],
    }));
    const next = await serve({
      mode: "live",
      manager: changed,
      serverIds: ["srv1"],
      messages: first.transcript.messages(),
    });
    expect(next.transcript.inUse()).toBe(true);
    // The runtime's own call carries no conversation; the transcript does.
    expect(
      await toolOf(next.tools, "readSkillFile").execute(
        { name: "srv1/refunds", path: FILE_URI },
        { toolCallId: "call-2", messages: [] },
      ),
    ).toContain("manifest_changed");
    expect(changed.calls).not.toContain(`resources/read:${FILE_URI}`);
  });
});

describe("joining the turn's host tools", () => {
  it("refuses a name another host tool holds", async () => {
    const run = await preparedRunSkills();
    const turn = await serve({
      mode: "pinned",
      pinnedHarnessSkills: run.pinnedHarnessSkills,
      manager: NO_SERVERS,
      serverIds: [],
      messages: [],
    });
    expect(() => withServerSkillTools({ loadSkill: {} }, turn)).toThrow(
      "collides with MCPJam's skill tool",
    );
    expect(
      Object.keys(withServerSkillTools({ web_search: {} }, turn)).sort(),
    ).toEqual(["listSkillFiles", "loadSkill", "readSkillFile", "web_search"]);
  });
});
