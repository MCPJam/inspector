import { describe, expect, it } from "vitest";
import {
  chooseTemplate,
  compositionKey,
  environmentComposition,
  lacksServerSource,
  sharedServerGroup,
  unpreservableReason,
} from "../environment-template";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";

const env = (
  overrides: Partial<ProjectEnvironmentView> & { environmentId: string },
): ProjectEnvironmentView =>
  ({
    projectId: "p",
    hostId: "h",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }) as ProjectEnvironmentView;

describe("environmentComposition", () => {
  it("treats null, undefined and empty selections alike", () => {
    expect(
      environmentComposition({
        serverAttachmentId: null,
        skillSelection: { mode: "explicit", skillIds: [] },
        pluginVersionIds: [],
        computerEnvironmentId: null,
      }),
    ).toEqual({});
    expect(compositionKey({ serverAttachmentId: null })).toBe(
      compositionKey({}),
    );
  });

  it("keeps version pins and order in the identity", () => {
    const a = compositionKey({
      skillSelection: {
        mode: "explicit",
        skillIds: ["a", "b"],
        versionPins: [{ skillId: "a", versionId: "v1" }],
      },
    });
    const b = compositionKey({
      skillSelection: {
        mode: "explicit",
        skillIds: ["a", "b"],
        versionPins: [{ skillId: "a", versionId: "v2" }],
      },
    });
    const c = compositionKey({
      skillSelection: { mode: "explicit", skillIds: ["b", "a"] },
    });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("chooseTemplate", () => {
  it("returns the one setup every candidate shares", () => {
    const choice = chooseTemplate([
      env({ environmentId: "1", serverAttachmentId: "g", modelId: "x" }),
      env({ environmentId: "2", serverAttachmentId: "g", modelId: "y" }),
    ]);
    expect(choice).toMatchObject({
      kind: "template",
      composition: { serverAttachmentId: "g" },
    });
  });

  it("is ambiguous when candidates disagree, unless only the group differs and is being replaced", () => {
    const candidates = [
      env({ environmentId: "1", serverAttachmentId: "g1" }),
      env({ environmentId: "2", serverAttachmentId: "g2" }),
    ];
    expect(chooseTemplate(candidates).kind).toBe("ambiguous");
    expect(chooseTemplate(candidates, { ignoreServerGroup: true }).kind).toBe(
      "template",
    );
  });

  it("reports no template when there are no candidates", () => {
    expect(chooseTemplate([])).toEqual({ kind: "none" });
  });
});

describe("unpreservableReason", () => {
  it("names what the browser cannot copy", () => {
    expect(unpreservableReason({ pluginVersionIds: ["p"] })).toMatch(/plugin/);
    expect(
      unpreservableReason({
        serverSkillSelection: { mode: "explicit", serverSkillIds: ["s"] },
      }),
    ).toMatch(/server skills/);
    expect(
      unpreservableReason({
        secretSelection: { mode: "explicit", secretIds: ["s"] },
      }),
    ).toMatch(/secrets/);
    expect(
      unpreservableReason({
        serverAttachmentId: "g",
        skillSelection: { mode: "explicit", skillIds: ["s"] },
        computerEnvironmentId: "img",
      }),
    ).toBeNull();
  });
});

describe("sharedServerGroup / lacksServerSource", () => {
  it("classifies a suite's groups", () => {
    expect(sharedServerGroup([])).toEqual({ kind: "empty" });
    expect(
      sharedServerGroup([
        { serverAttachmentId: "g" },
        { serverAttachmentId: "g" },
      ]),
    ).toEqual({ kind: "group", serverAttachmentId: "g" });
    expect(sharedServerGroup([{}, { serverAttachmentId: null }])).toEqual({
      kind: "none",
    });
    expect(sharedServerGroup([{ serverAttachmentId: "g" }, {}])).toEqual({
      kind: "mixed",
    });
  });

  it("counts a plugin pin as a server source", () => {
    expect(lacksServerSource({})).toBe(true);
    expect(lacksServerSource({ pluginVersionIds: ["p"] })).toBe(false);
    expect(lacksServerSource({ serverAttachmentId: "g" })).toBe(false);
  });
});
