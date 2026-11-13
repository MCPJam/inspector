/**
 * The Skills field's logic over a suite's environments: the state the picker
 * shows, how one click lands on each environment, how a click becomes the
 * derivation the backend saves, and the hint lines under the client table.
 */
import { describe, expect, it } from "vitest";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import type { PaneSkillsPreview } from "@/shared/pane-skills-preview";
import { planSuiteClients } from "../suite-clients-settings";
import { libraryChange } from "../suite-skill-channels";
import {
  editedSkillSelection,
  skillDeliveryLines,
  suiteSkillState,
} from "../suite-skills";
import type { EvalSuite } from "../types";

const pinned = (skillId: string, versionId: string) => ({ skillId, versionId });

describe("suiteSkillState", () => {
  it("shows what every environment selects, at the version they share", () => {
    const selection = {
      mode: "explicit" as const,
      skillIds: ["triage", "reply"],
      versionPins: [pinned("reply", "reply-v4")],
    };
    const state = suiteSkillState([
      { skillSelection: selection },
      { skillSelection: { ...selection } },
    ]);
    expect(state.value).toEqual(selection);
    expect(state.across.partialIds.size).toBe(0);
    expect(state.across.largestCount).toBe(2);
  });

  it("marks a skill partly on when only some environments select it", () => {
    const state = suiteSkillState([
      { skillSelection: { mode: "explicit", skillIds: ["triage", "reply"] } },
      { skillSelection: { mode: "explicit", skillIds: ["triage"] } },
    ]);
    expect(state.value).toEqual({ mode: "explicit", skillIds: ["triage"] });
    expect([...state.across.partialIds]).toEqual(["reply"]);
  });

  it("marks a skill partly on when the environments run different versions", () => {
    const state = suiteSkillState([
      {
        skillSelection: {
          mode: "explicit",
          skillIds: ["reply"],
          versionPins: [pinned("reply", "reply-v3")],
        },
      },
      { skillSelection: { mode: "explicit", skillIds: ["reply"] } },
    ]);
    expect(state.value).toBeNull();
    expect([...state.across.partialIds]).toEqual(["reply"]);
  });

  it("is empty when no environment selects a skill", () => {
    const state = suiteSkillState([{ skillSelection: null }, {}]);
    expect(state.value).toBeNull();
    expect(state.across.partialIds.size).toBe(0);
    expect(state.across.largestCount).toBe(0);
  });

  const skills = (prefix: string, count: number) => ({
    mode: "explicit" as const,
    skillIds: Array.from({ length: count }, (_, index) => `${prefix}${index}`),
  });

  it("checks the cap against each environment, not the suite's union", () => {
    // 20 different skills across the suite, but each client has room.
    const roomy = suiteSkillState([
      { skillSelection: skills("a", 10) },
      { skillSelection: skills("b", 10) },
    ]);
    expect(roomy.across.largestCount).toBe(10);
    expect(roomy.across.canAdd("new")).toBe(true);
  });

  it("blocks a skill that would take a full environment past the cap", () => {
    const full = skills("a", 20);
    const state = suiteSkillState([
      { skillSelection: full },
      { skillSelection: { mode: "explicit", skillIds: ["partly"] } },
    ]);
    expect(state.across.largestCount).toBe(20);
    // The full client lacks it, so adding it everywhere would make 21.
    expect(state.across.canAdd("partly")).toBe(false);
    expect(state.across.canAdd("new")).toBe(false);
    // The full client already has this one; the other has room.
    expect(state.across.canAdd("a0")).toBe(true);
  });
});

describe("editedSkillSelection", () => {
  const selection = {
    mode: "explicit" as const,
    skillIds: ["triage", "reply"],
    versionPins: [pinned("reply", "reply-v3")],
  };

  it("adds a skill at Latest after the environment's own skills", () => {
    expect(
      editedSkillSelection(selection, { kind: "add", skillId: "escalate" }),
    ).toEqual({ ...selection, skillIds: ["triage", "reply", "escalate"] });
    expect(
      editedSkillSelection(undefined, { kind: "add", skillId: "escalate" }),
    ).toEqual({ mode: "explicit", skillIds: ["escalate"] });
  });

  it("moves a pinned skill to Latest when a click sets it everywhere", () => {
    expect(
      editedSkillSelection(selection, { kind: "add", skillId: "reply" }),
    ).toEqual({ mode: "explicit", skillIds: ["triage", "reply"] });
  });

  it("leaves an environment alone when the click changes nothing there", () => {
    expect(
      editedSkillSelection(selection, { kind: "add", skillId: "triage" }),
    ).toBeUndefined();
    expect(
      editedSkillSelection(selection, { kind: "remove", skillId: "escalate" }),
    ).toBeUndefined();
    expect(
      editedSkillSelection(selection, {
        kind: "pin",
        skillId: "reply",
        versionId: "reply-v3",
      }),
    ).toBeUndefined();
  });

  it("clears with null when the last skill is removed", () => {
    expect(
      editedSkillSelection(
        { mode: "explicit", skillIds: ["triage"] },
        { kind: "remove", skillId: "triage" },
      ),
    ).toBeNull();
  });

  it("drops a removed skill's pin with it", () => {
    expect(
      editedSkillSelection(selection, { kind: "remove", skillId: "reply" }),
    ).toEqual({ mode: "explicit", skillIds: ["triage"] });
  });

  it("pins, repins and unpins one skill and keeps the others' pins", () => {
    expect(
      editedSkillSelection(selection, {
        kind: "pin",
        skillId: "triage",
        versionId: "triage-v1",
      })?.versionPins,
    ).toEqual([pinned("reply", "reply-v3"), pinned("triage", "triage-v1")]);
    expect(
      editedSkillSelection(selection, {
        kind: "pin",
        skillId: "reply",
        versionId: "reply-v1",
      })?.versionPins,
    ).toEqual([pinned("reply", "reply-v1")]);
    expect(
      editedSkillSelection(selection, {
        kind: "pin",
        skillId: "reply",
        versionId: null,
      }),
    ).toEqual({ mode: "explicit", skillIds: ["triage", "reply"] });
  });
});

describe("planSuiteClients with a Skills edit", () => {
  const suite = {
    _id: "suite",
    name: "Suite",
    environmentIds: ["chat-env", "codex-env"],
  } as EvalSuite;
  const environments = [
    {
      environmentId: "chat-env",
      hostId: "chat",
      modelId: "gpt",
      serverAttachmentId: "servers",
      skillSelection: { mode: "explicit", skillIds: ["triage"] },
      revision: 3,
    },
    {
      environmentId: "codex-env",
      hostId: "codex",
      modelId: "gpt",
      serverAttachmentId: "servers",
      revision: 5,
    },
  ] as ProjectEnvironmentView[];
  const selections = {
    chat: {
      includeClientDefaults: false,
      explicitTargets: [{ modelId: "gpt" }],
    },
    codex: {
      includeClientDefaults: false,
      explicitTargets: [{ modelId: "gpt" }],
    },
  };

  it("derives each changed environment with its own skill override", () => {
    const plan = planSuiteClients(suite, environments, selections, {
      group: "servers",
      lossless: true,
      skills: (row) =>
        libraryChange(row, { kind: "add", skillId: "reply" }),
    });
    expect(plan).toEqual([
      {
        derive: {
          sourceEnvironmentId: "chat-env",
          expectedRevision: 3,
          overrides: {
            skillSelection: { mode: "explicit", skillIds: ["triage", "reply"] },
          },
          replaces: "chat-env",
        },
      },
      {
        derive: {
          sourceEnvironmentId: "codex-env",
          expectedRevision: 5,
          overrides: {
            skillSelection: { mode: "explicit", skillIds: ["reply"] },
          },
          replaces: "codex-env",
        },
      },
    ]);
  });

  it("keeps an environment the edit leaves alone, and clears with null", () => {
    const plan = planSuiteClients(suite, environments, selections, {
      group: "servers",
      lossless: true,
      skills: (row) =>
        libraryChange(row, { kind: "remove", skillId: "triage" }),
    });
    expect(plan).toEqual([
      {
        derive: {
          sourceEnvironmentId: "chat-env",
          expectedRevision: 3,
          overrides: { skillSelection: null },
          replaces: "chat-env",
        },
      },
      { environmentId: "codex-env" },
    ]);
  });

  it("refuses a skills edit the backend can't derive", () => {
    expect(() =>
      planSuiteClients(suite, environments, selections, {
        group: "servers",
        skills: () => ({ skillSelection: null }),
      }),
    ).toThrow(/Environments page/);
  });
});

describe("skillDeliveryLines", () => {
  const row = (
    name: string,
    reason: PaneSkillsPreview["skills"][number]["reason"] = null,
    channels: PaneSkillsPreview["skills"][number]["channels"] = ["environment"],
  ) => ({ skillId: name, name, description: "", channels, reason });
  const preview = (
    ...skills: PaneSkillsPreview["skills"]
  ): PaneSkillsPreview => ({
    deliveredCount: skills.filter((skill) => !skill.reason).length,
    skills,
  });

  it("says when every client loads every skill", () => {
    expect(
      skillDeliveryLines([
        {
          client: "MCPJam agent",
          preview: preview(row("triage"), row("reply")),
        },
        {
          client: "Claude Code",
          preview: preview(row("reply"), row("triage")),
        },
      ]),
    ).toEqual(["Every client loads both skills."]);
  });

  it("names the clients that leave skills out, and why", () => {
    expect(
      skillDeliveryLines([
        {
          client: "MCPJam agent",
          preview: preview(row("triage"), row("Reply")),
        },
        {
          client: "Codex",
          preview: preview(row("triage"), row("Reply", "invalid-skill-name")),
        },
        {
          client: "Cursor",
          preview: preview(
            row("triage", "unsupported-harness"),
            row("Reply", "unsupported-harness"),
          ),
        },
      ]),
    ).toEqual([
      "MCPJam agent loads triage and Reply.",
      "Codex loads triage.",
      "Codex can’t use the name Reply, so its runs leave it out.",
      "Cursor doesn’t support skills, so its runs get none.",
    ]);
  });

  it("counts skills only where the clients load the same ones", () => {
    // Two clients with two skills each, but not the same two.
    expect(
      skillDeliveryLines([
        { client: "MCPJam agent", preview: preview(row("alpha"), row("beta")) },
        { client: "Claude Code", preview: preview(row("gamma"), row("delta")) },
      ]),
    ).toEqual([
      "MCPJam agent loads alpha and beta.",
      "Claude Code loads gamma and delta.",
    ]);
    // The same two, with a client that can't load skills beside them.
    expect(
      skillDeliveryLines([
        { client: "MCPJam agent", preview: preview(row("alpha"), row("beta")) },
        { client: "Claude Code", preview: preview(row("beta"), row("alpha")) },
        {
          client: "Cursor",
          preview: preview(
            row("alpha", "unsupported-harness"),
            row("beta", "unsupported-harness"),
          ),
        },
      ]),
    ).toEqual([
      "MCPJam agent and Claude Code load both skills.",
      "Cursor doesn’t support skills, so its runs get none.",
    ]);
  });

  it("leaves skills from MCP servers out of every line", () => {
    const serverSkill = row("acme/lookup", "server-skill-unsupported", [
      "mcp-server",
    ]);
    expect(
      skillDeliveryLines([
        {
          client: "MCPJam agent",
          preview: preview(
            row("triage"),
            row("acme/lookup", null, ["mcp-server"]),
          ),
        },
        { client: "Claude Code", preview: preview(row("triage"), serverSkill) },
      ]),
    ).toEqual(["Every client loads triage."]);
    expect(
      skillDeliveryLines([
        { client: "Claude Code", preview: preview(serverSkill) },
      ]),
    ).toEqual([]);
  });

  it("names a client that runs without skills beside one that has them", () => {
    expect(
      skillDeliveryLines([
        {
          client: "MCPJam agent",
          preview: preview(row("triage"), row("reply"), row("escalate")),
        },
        { client: "Claude Code", preview: preview() },
      ]),
    ).toEqual([
      "MCPJam agent loads all 3 skills.",
      "Claude Code runs without skills.",
    ]);
  });
});
