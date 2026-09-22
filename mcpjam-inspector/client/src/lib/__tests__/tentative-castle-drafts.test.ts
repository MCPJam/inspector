import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTentativeCastle,
  listTentativeCastles,
  saveTentativeCastle,
  tentativeCastleToInitialDraft,
} from "../tentative-castle-drafts";

beforeEach(() => {
  localStorage.clear();
});

describe("tentative-castle-drafts", () => {
  it("persists a project-scoped list and trims the project key", () => {
    saveTentativeCastle("  proj_1  ", {
      name: "Billing snap",
      hostIds: ["h1", "h2"],
      serverAttachmentId: "sg1",
      skillSelection: { mode: "explicit", skillIds: ["sk1"] },
      computerEnvironmentId: null,
    });

    const listed = listTentativeCastles("proj_1");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: "Billing snap",
      hostIds: ["h1", "h2"],
      serverAttachmentId: "sg1",
      skillSelection: { mode: "explicit", skillIds: ["sk1"] },
    });
    expect(listTentativeCastles("proj_2")).toEqual([]);
  });

  it("maps a draft to editor initialDraft using the first host", () => {
    const castle = saveTentativeCastle("proj_1", {
      name: "Draft",
      hostIds: ["h-first", "h-second"],
      serverAttachmentId: null,
      skillSelection: null,
      computerEnvironmentId: "img1",
    })!;
    expect(tentativeCastleToInitialDraft(castle)).toEqual({
      name: "Draft",
      hostId: "h-first",
      serverAttachmentId: null,
      skillSelection: null,
      computerEnvironmentId: "img1",
    });
  });

  it("clears one draft without touching siblings", () => {
    const a = saveTentativeCastle("proj_1", {
      name: "A",
      hostIds: ["h1"],
      serverAttachmentId: null,
      skillSelection: null,
      computerEnvironmentId: null,
    })!;
    const b = saveTentativeCastle("proj_1", {
      name: "B",
      hostIds: ["h2"],
      serverAttachmentId: null,
      skillSelection: null,
      computerEnvironmentId: null,
    })!;
    clearTentativeCastle("proj_1", a.id);
    expect(listTentativeCastles("proj_1").map((c) => c.id)).toEqual([b.id]);
  });
});
