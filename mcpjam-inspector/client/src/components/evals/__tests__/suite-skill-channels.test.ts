/**
 * The Skills field's server-skill and "All shared Library skills" channels:
 * what the picker shows over a suite's environments, and the change one
 * click makes to each environment.
 */
import { describe, expect, it } from "vitest";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import { planSuiteClients } from "../suite-clients-settings";
import { suiteSkillState } from "../suite-skills";
import {
  editedServerSkillSelection,
  leftOutChange,
  libraryChange,
  scopeChange,
  scopedServerSkillCount,
  serverChange,
  serverSkillState,
  skillScopeState,
  suiteSkillsMixed,
} from "../suite-skill-channels";
import type { EvalSuite } from "../types";

const scope = "all-shared-library" as const;
const servers = (...serverSkillIds: string[]) => ({
  mode: "explicit" as const,
  serverSkillIds,
});
const library = (...skillIds: string[]) => ({
  mode: "explicit" as const,
  skillIds,
});
const many = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`);

describe("serverSkillState", () => {
  it("shows the server skills every environment selects, at the version they share", () => {
    const pinned = {
      ...servers("lookup", "refund"),
      versionPins: [{ serverSkillId: "refund", versionId: "refund-v2" }],
    };
    const state = serverSkillState([
      { serverSkillSelection: pinned },
      { serverSkillSelection: servers("lookup", "refund") },
    ]);
    expect(state.value).toEqual(servers("lookup"));
    expect([...state.across.partialIds]).toEqual(["refund"]);
  });

  it("counts Library and server skills against one cap", () => {
    const state = serverSkillState([
      {
        skillSelection: library(...many("lib", 19)),
        serverSkillSelection: servers("lookup"),
      },
      { serverSkillSelection: servers("lookup") },
    ]);
    expect(state.across.largestCount).toBe(20);
    expect(state.across.canAdd("refund")).toBe(false);
    expect(state.across.canAdd("lookup")).toBe(true);
    // On the scope, Library skills are capped when a run starts instead.
    const scoped = serverSkillState([
      { skillScope: scope, serverSkillSelection: servers("lookup") },
    ]);
    expect(scoped.across.canAdd("refund")).toBe(true);
  });
});

describe("editedServerSkillSelection", () => {
  const selection = {
    ...servers("lookup", "refund"),
    versionPins: [{ serverSkillId: "refund", versionId: "refund-v2" }],
  };

  it("adds at Latest, pins one capture, and keeps the other pins", () => {
    expect(
      editedServerSkillSelection(null, { kind: "add", skillId: "lookup" }),
    ).toEqual(servers("lookup"));
    expect(
      editedServerSkillSelection(selection, {
        kind: "pin",
        skillId: "lookup",
        versionId: "lookup-v1",
      }),
    ).toEqual({
      ...servers("lookup", "refund"),
      versionPins: [
        { serverSkillId: "refund", versionId: "refund-v2" },
        { serverSkillId: "lookup", versionId: "lookup-v1" },
      ],
    });
  });

  it("drops a removed skill's pin, clears with null, and skips no-ops", () => {
    expect(
      editedServerSkillSelection(selection, {
        kind: "remove",
        skillId: "refund",
      }),
    ).toEqual(servers("lookup"));
    expect(
      editedServerSkillSelection(servers("lookup"), {
        kind: "remove",
        skillId: "lookup",
      }),
    ).toBeNull();
    expect(
      editedServerSkillSelection(selection, { kind: "add", skillId: "lookup" }),
    ).toBeUndefined();
  });
});

describe("the All shared Library skills scope", () => {
  it("is on, off, or on for only some environments", () => {
    expect(
      skillScopeState([{ skillScope: scope }, { skillScope: scope }]),
    ).toBe(true);
    expect(skillScopeState([{}, { skillSelection: null }])).toBe(false);
    expect(skillScopeState([{ skillScope: scope }, {}])).toBe("partial");
    expect(suiteSkillsMixed([{ skillScope: scope }, {}])).toBe(true);
    expect(
      suiteSkillsMixed([{ skillScope: scope }, { skillScope: scope }]),
    ).toBe(false);
  });

  it("leaves scoped environments out of the Library list", () => {
    const state = suiteSkillState([
      { skillScope: scope },
      { skillSelection: library("triage") },
    ]);
    expect(state.value).toEqual(library("triage"));
    expect(state.across.partialIds.size).toBe(0);
    expect(
      scopedServerSkillCount([
        { skillScope: scope, serverSkillSelection: servers("a", "b") },
        { serverSkillSelection: servers("a", "b", "c") },
      ]),
    ).toBe(2);
  });

  it("turns on in place of the Library list and its pins, and off on its own", () => {
    expect(
      scopeChange(
        {
          skillSelection: {
            ...library("triage"),
            versionPins: [{ skillId: "triage", versionId: "v1" }],
          },
        },
        true,
      ),
    ).toEqual({ skillScope: scope, skillSelection: null });
    expect(scopeChange({ skillScope: scope }, false)).toEqual({
      skillScope: null,
    });
    expect(scopeChange({ skillScope: scope }, true)).toBeUndefined();
    expect(scopeChange({}, false)).toBeUndefined();
  });

  it("keeps the other members as a fixed list when one is unchecked", () => {
    expect(
      leftOutChange({ skillScope: scope }, "reply", ["triage", "escalate"]),
    ).toEqual({
      skillScope: null,
      skillSelection: library("triage", "escalate"),
    });
    expect(leftOutChange({ skillScope: scope }, "triage", [])).toEqual({
      skillScope: null,
      skillSelection: null,
    });
    // Where the scope is off, the skill is simply removed.
    expect(
      leftOutChange({ skillSelection: library("triage", "reply") }, "reply", [
        "triage",
      ]),
    ).toEqual({ skillSelection: library("triage") });
  });

  it("leaves a scoped environment alone on a Library pick, not on a server pick", () => {
    expect(
      libraryChange({ skillScope: scope }, { kind: "add", skillId: "triage" }),
    ).toBeUndefined();
    expect(
      serverChange({ skillScope: scope }, { kind: "add", skillId: "lookup" }),
    ).toEqual({ serverSkillSelection: servers("lookup") });
  });
});

describe("planSuiteClients with a scope or server-skill edit", () => {
  const suite = {
    _id: "suite",
    name: "Suite",
    environmentIds: ["chat-env"],
  } as EvalSuite;
  const environments = [
    {
      environmentId: "chat-env",
      hostId: "chat",
      modelId: "gpt",
      serverAttachmentId: "servers",
      skillSelection: library("triage"),
      revision: 3,
    },
  ] as ProjectEnvironmentView[];
  const selections = {
    chat: {
      includeClientDefaults: false,
      explicitTargets: [{ modelId: "gpt" }],
    },
  };
  const overrides = (skills: Parameters<typeof planSuiteClients>[3]) =>
    planSuiteClients(suite, environments, selections, {
      group: "servers",
      lossless: true,
      ...skills,
    })[0]?.derive?.overrides;

  it("sends the scope with the Library list cleared", () => {
    expect(overrides({ skills: (row) => scopeChange(row, true) })).toEqual({
      skillScope: scope,
      skillSelection: null,
    });
  });

  it("sends a server-skill pick on its own", () => {
    expect(
      overrides({
        skills: (row) => serverChange(row, { kind: "add", skillId: "lookup" }),
      }),
    ).toEqual({ serverSkillSelection: servers("lookup") });
  });
});
