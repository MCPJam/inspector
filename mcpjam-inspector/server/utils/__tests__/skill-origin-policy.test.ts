/**
 * WHICH ORIGINS EACH SURFACE ADMITS.
 *
 * This matrix is the thing that regressed into the mess this convergence
 * undid: every surface grew its own answer to "where do skills come from",
 * nobody wrote the answers down together, and the differences were only
 * discoverable by reading four call sites. Converging them created the
 * opposite risk — a surface quietly gaining an origin it must not have — so
 * the matrix is asserted rather than described.
 *
 * These cases pin `prepareChatV2`'s side of the contract: given a source of
 * each shape, what does the turn advertise? The per-route half (which shape
 * each route builds) is pinned in the route suites.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../skill-tools.js", () => ({
  getSkillToolsAndPrompt: vi.fn(),
  listLocalRuntimeSkills: vi.fn(async () => []),
}));

import { prepareChatV2 } from "../chat-v2-orchestration.js";
import type { EffectiveCapabilitySet } from "../../services/environments/effective-capabilities.js";

function mockManager(tools: Record<string, unknown> = {}) {
  return {
    getToolsForAiSdk: vi.fn(async () => tools),
    listTools: vi.fn(async () => ({ tools: [] })),
    getSkillsSupport: vi.fn(() => ({
      declared: false,
      advertised: false,
      directoryRead: false,
      active: false,
    })),
  } as never;
}

/** A manager whose one connection has the skills extension mutually active. */
function liveSkillsManager() {
  return {
    getToolsForAiSdk: vi.fn(async () => ({})),
    listTools: vi.fn(async () => ({ tools: [] })),
    hasServer: vi.fn(() => true),
    getSkillsSupport: vi.fn(() => ({
      declared: true,
      advertised: true,
      directoryRead: false,
      active: true,
    })),
  } as never;
}

function capabilities(
  overrides: Partial<EffectiveCapabilitySet> = {}
): EffectiveCapabilitySet {
  return {
    explicitServerIds: [],
    pluginServerIds: [],
    effectiveServerIds: [],
    servers: [],
    pluginSkills: [],
    standaloneSkills: [],
    serverSkills: [],
    localSkills: [],
    pluginVersions: [],
    problems: [],
    ...overrides,
  };
}

const PROJECT_SKILL = {
  skillId: "sk_project",
  ref: "code-review",
  name: "code-review",
  description: "Review code.",
  content: "# Project",
  aggregateHash: "h1",
  channels: [] as never[],
  files: [],
};

const LOCAL_SKILL = {
  skillId: "local:/home/u/.claude/skills/code-review",
  ref: "local/code-review",
  name: "code-review",
  description: "Review code, locally.",
  content: "# Local",
  aggregateHash: "h2",
  directory: "~/.claude/skills/code-review",
  files: [],
};

const base = {
  selectedServers: [] as string[],
  modelDefinition: { id: "gpt-4.1", provider: "openai" } as never,
  systemPrompt: "Base prompt.",
};

async function prompt(
  skillsSource: unknown,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const result = await prepareChatV2({
    ...base,
    mcpClientManager: mockManager(),
    skillsSource,
    ...extra,
  } as never);
  return result.enhancedSystemPrompt;
}

describe("the origin matrix", () => {
  it("desktop signed out: local only", async () => {
    const text = await prompt({
      kind: "resolved",
      capabilities: capabilities({ localSkills: [LOCAL_SKILL] }),
      composeLiveServerSkills: true,
    });
    expect(text).toContain("**local/code-review**");
    expect(text).not.toContain("**code-review**:");
  });

  it("desktop signed in with a project: local AND project, both addressable", async () => {
    // The case that was impossible before this convergence: authoring a
    // project skill on desktop and using it in the very next desktop turn.
    const text = await prompt({
      kind: "resolved",
      capabilities: capabilities({
        localSkills: [LOCAL_SKILL],
        standaloneSkills: [PROJECT_SKILL],
      }),
      composeLiveServerSkills: true,
    });
    expect(text).toContain("**local/code-review**");
    expect(text).toContain("**code-review**");
  });

  it("hosted playground: project skills, never a local file", async () => {
    // Hosted has no filesystem to read. The set simply carries no local family,
    // so this is structural rather than a check the route has to remember.
    const text = await prompt({
      kind: "resolved",
      capabilities: capabilities({ standaloneSkills: [PROJECT_SKILL] }),
      composeLiveServerSkills: true,
    });
    expect(text).toContain("**code-review**");
    expect(text).not.toContain("local/");
  });

  it("an environment turn: its captured set, and NO live server composition", async () => {
    // An environment is a DECISION about what runs. Its server skills were
    // captured with the rest of the spec, so reaching back to the live
    // connection for more would falsify the claim that the set describes the
    // turn — the exact thing `composeLiveServerSkills` is opt-in to prevent.
    // Asserted here because the flag's absence is invisible: a set that quietly
    // gained live skills would still look like a working environment turn.
    const result = await prepareChatV2({
      ...base,
      selectedServers: ["srv"],
      mcpClientManager: liveSkillsManager(),
      skillsSource: {
        kind: "resolved",
        capabilities: capabilities({ standaloneSkills: [PROJECT_SKILL] }),
      },
    } as never);

    expect(result.enhancedSystemPrompt).toContain("**code-review**");
    expect(Object.keys(result.allTools)).not.toContain("listSkills");
  });

  it("a live turn against the same server DOES compose it", async () => {
    // The control for the case above: same manager, same selection, and the
    // only difference is the flag. Without this pair, the assertion above
    // would also pass if `withServerSkills` had simply stopped working.
    const result = await prepareChatV2({
      ...base,
      selectedServers: ["srv"],
      mcpClientManager: liveSkillsManager(),
      skillsSource: {
        kind: "resolved",
        capabilities: capabilities({ standaloneSkills: [PROJECT_SKILL] }),
        composeLiveServerSkills: true,
      },
    } as never);

    expect(Object.keys(result.allTools)).toContain("listSkills");
  });

  it("an eval run: pinned content only, and never under approval", async () => {
    // Pinned is the ONLY kind that bypasses approval, because an eval run
    // auto-denies and a paused approval would fail every iteration.
    const result = await prepareChatV2({
      ...base,
      mcpClientManager: mockManager(),
      requireToolApproval: true,
      skillsSource: {
        kind: "pinned",
        skills: [
          {
            name: "frozen",
            description: "Frozen for this run.",
            content: "# Frozen",
            contentHash: "h",
          },
        ],
      },
    } as never);
    expect(result.enhancedSystemPrompt).toContain("frozen");
    expect(
      (result.allTools as Record<string, { needsApproval?: unknown }>).loadSkill
        ?.needsApproval
    ).not.toBe(true);
  });

  it("a harness turn: refuses an in-memory source outright", async () => {
    // Skills reach a harness as SKILL.md on the box. Handing it in-memory tools
    // too would deliver the same skill twice by two mechanisms — so the turn
    // refuses to start rather than doing it quietly. Callers guard this
    // themselves; a forgotten guard would otherwise be silent.
    await expect(
      prepareChatV2({
        ...base,
        mcpClientManager: mockManager(),
        harness: "claude-code" as never,
        skillsSource: {
          kind: "resolved",
          capabilities: capabilities({
            localSkills: [LOCAL_SKILL],
            standaloneSkills: [PROJECT_SKILL],
          }),
          composeLiveServerSkills: true,
        },
      } as never)
    ).rejects.toThrow(/deliberately disjoint/);
  });

  it("a harness turn saying none: accepted, with no stanza", async () => {
    const result = await prepareChatV2({
      ...base,
      mcpClientManager: mockManager(),
      harness: "claude-code" as never,
      skillsSource: { kind: "none" },
    } as never);
    expect(Object.keys(result.allTools)).not.toContain("loadSkill");
    expect(result.enhancedSystemPrompt).toBe("Base prompt.");
  });

  it("a surface that says none: none, with no stanza to explain it", async () => {
    const text = await prompt({ kind: "none" });
    expect(text).toBe("Base prompt.");
  });

  it("keeps both origins of one name addressable, exact ref first", async () => {
    // The merged catalog's defining behaviour. Both skills are real and both
    // are reachable; the only wrong answer is silently picking one.
    //
    // The bare name is NOT ambiguous here: `code-review` is the project
    // skill's own ref, so it is an exact hit. That ordering is deliberate —
    // resolving names before refs would make a project skill unaddressable the
    // moment a user happened to have a local file of the same name, which is
    // the shadowing the namespacing exists to prevent.
    const result = await prepareChatV2({
      ...base,
      mcpClientManager: mockManager(),
      skillsSource: {
        kind: "resolved",
        capabilities: capabilities({
          localSkills: [LOCAL_SKILL],
          standaloneSkills: [PROJECT_SKILL],
        }),
      },
    } as never);
    const loadSkill = (
      result.allTools as unknown as Record<
        string,
        { execute: (input: unknown) => Promise<string> }
      >
    ).loadSkill;
    await expect(loadSkill.execute({ name: "code-review" })).resolves.toContain(
      "# Project"
    );
    await expect(
      loadSkill.execute({ name: "local/code-review" })
    ).resolves.toContain("# Local");
  });

  it("refuses a bare name only when NOTHING answers to it exactly", async () => {
    // Two namespaced origins, no project skill: now the bare name is a guess,
    // and the tool names the alternatives instead of making it.
    const result = await prepareChatV2({
      ...base,
      mcpClientManager: mockManager(),
      skillsSource: {
        kind: "resolved",
        capabilities: capabilities({
          localSkills: [LOCAL_SKILL],
          pluginSkills: [
            {
              skillId: "sk_plugin",
              ref: "docs-tools/code-review",
              name: "code-review",
              description: "Review code, the plugin's way.",
              content: "# Plugin",
              aggregateHash: "h3",
              pluginName: "docs-tools",
              channels: [] as never[],
              files: [],
            } as never,
          ],
        }),
      },
    } as never);
    const loadSkill = (
      result.allTools as unknown as Record<
        string,
        { execute: (input: unknown) => Promise<string> }
      >
    ).loadSkill;
    const refusal = await loadSkill.execute({ name: "code-review" });
    expect(refusal).toContain("ambiguous");
    expect(refusal).toContain('"docs-tools/code-review"');
    expect(refusal).toContain('"local/code-review"');
    // And each is still reachable by its own ref.
    await expect(
      loadSkill.execute({ name: "docs-tools/code-review" })
    ).resolves.toContain("# Plugin");
    await expect(
      loadSkill.execute({ name: "local/code-review" })
    ).resolves.toContain("# Local");
  });
});
