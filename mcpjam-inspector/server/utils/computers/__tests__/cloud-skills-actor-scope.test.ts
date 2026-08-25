import { describe, it, expect, vi, beforeEach } from "vitest";

// COMP-38: the reads the chat skill tools make must follow the ACTOR. A member
// keeps the project-wide queries; a guest / swarm grant goes through the
// `*ForRuntimeExecution` pair, the only queries a non-member bearer can pass.
vi.mock("../convex-skills-client.js", () => ({
  convexListSkills: vi.fn(),
  convexListSkillsForRuntimeExecution: vi.fn(),
  convexGetSkillByName: vi.fn(),
  convexListSkillFiles: vi.fn(),
  convexListSkillFilesForRuntimeExecution: vi.fn(),
  convexGetSkillFileUrl: vi.fn(),
  // Unused by these reads, but the module namespace must resolve.
  convexAttachSkillFiles: vi.fn(),
  convexCreateSkill: vi.fn(),
  convexDeleteSkill: vi.fn(),
  convexGenerateSkillFileUploadUrl: vi.fn(),
  convexGetSkill: vi.fn(),
  convexPromoteSkill: vi.fn(),
  convexRemoveSkillFile: vi.fn(),
  convexUpdateSkill: vi.fn(),
}));

import {
  convexGetSkillByName,
  convexGetSkillFileUrl,
  convexListSkillFiles,
  convexListSkillFilesForRuntimeExecution,
  convexListSkills,
  convexListSkillsForRuntimeExecution,
} from "../convex-skills-client.js";
import {
  CloudSkillsError,
  SKILL_FILE_MAX_READ_BYTES,
  getCloudSkillBodyForActor,
  listCloudSkillFilesForActor,
  listCloudSkillsForActor,
  readCloudSkillFileForActor,
  type CloudSkillsContext,
} from "../cloud-skills";
import type { ExecutionScope } from "../../execution-scope.js";

const scope: ExecutionScope = {
  kind: "swarm",
  swarmId: "swarm_1",
  accessVersion: 3,
  projectId: "proj_1",
  workspaceId: "ws_1",
};

const member: CloudSkillsContext = {
  authHeader: "Bearer member",
  projectId: "proj_1",
};

const guest: CloudSkillsContext = {
  authHeader: "Bearer guest",
  projectId: "proj_1",
  executionScope: scope,
};

const scopedSkills = [
  {
    skillId: "sk_1",
    name: "pdf-tools",
    description: "Process PDFs",
    content: "Step 1. Extract text.",
    aggregateHash: "h1",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listCloudSkillsForActor", () => {
  it("uses the project-wide query for a member", async () => {
    vi.mocked(convexListSkills).mockResolvedValue([]);
    await listCloudSkillsForActor(member);
    expect(convexListSkills).toHaveBeenCalledWith("Bearer member", "proj_1");
    expect(convexListSkillsForRuntimeExecution).not.toHaveBeenCalled();
  });

  it("uses the scope-authorized query when the turn carries a scope", async () => {
    vi.mocked(convexListSkillsForRuntimeExecution).mockResolvedValue(
      scopedSkills
    );
    const catalog = await listCloudSkillsForActor(guest);
    expect(convexListSkillsForRuntimeExecution).toHaveBeenCalledWith(
      "Bearer guest",
      scope
    );
    expect(convexListSkills).not.toHaveBeenCalled();
    expect(catalog.map((entry) => entry.name)).toEqual(["pdf-tools"]);
  });
});

describe("getCloudSkillBodyForActor", () => {
  it("resolves a name off the scoped listing, never the member query", async () => {
    vi.mocked(convexListSkillsForRuntimeExecution).mockResolvedValue(
      scopedSkills
    );
    const skill = await getCloudSkillBodyForActor(guest, "pdf-tools");
    expect(skill).toMatchObject({
      skillId: "sk_1",
      name: "pdf-tools",
      content: "Step 1. Extract text.",
    });
    expect(convexGetSkillByName).not.toHaveBeenCalled();
  });

  it("returns null for a skill the grant does not expose", async () => {
    vi.mocked(convexListSkillsForRuntimeExecution).mockResolvedValue(
      scopedSkills
    );
    expect(await getCloudSkillBodyForActor(guest, "other")).toBeNull();
  });
});

describe("listCloudSkillFilesForActor", () => {
  it("narrows the scope's whole-grant file listing to the asked-for skill", async () => {
    vi.mocked(convexListSkillFilesForRuntimeExecution).mockResolvedValue([
      { skillId: "sk_1", path: "scripts/fill.py", size: 12, url: "u1" },
      { skillId: "sk_2", path: "other.txt", size: 3, url: "u2" },
    ]);
    const files = await listCloudSkillFilesForActor(guest, "sk_1");
    expect(files.map((file) => file.path)).toEqual(["scripts/fill.py"]);
    expect(convexListSkillFiles).not.toHaveBeenCalled();
  });
});

describe("readCloudSkillFileForActor", () => {
  it("reads the bytes from the URL the scoped listing minted", async () => {
    vi.mocked(convexListSkillFilesForRuntimeExecution).mockResolvedValue([
      { skillId: "sk_1", path: "notes.md", size: 5, url: "https://blob/1" },
    ]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("hello"));
    const file = await readCloudSkillFileForActor(guest, "sk_1", "notes.md");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://blob/1",
      expect.objectContaining({ signal: expect.anything() })
    );
    expect(file).toMatchObject({ path: "notes.md", isText: true });
    expect(convexGetSkillFileUrl).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("404s a path the grant does not expose", async () => {
    vi.mocked(convexListSkillFilesForRuntimeExecution).mockResolvedValue([]);
    await expect(
      readCloudSkillFileForActor(guest, "sk_1", "missing.md")
    ).rejects.toMatchObject({ status: 404 });
  });

  it("404s an entry the scoped listing minted no URL for", async () => {
    vi.mocked(convexListSkillFilesForRuntimeExecution).mockResolvedValue([
      { skillId: "sk_1", path: "notes.md", size: 5, url: null },
    ]);
    await expect(
      readCloudSkillFileForActor(guest, "sk_1", "notes.md")
    ).rejects.toMatchObject({ status: 404 });
  });

  it("413s past the read cap, before fetching a single byte", async () => {
    vi.mocked(convexListSkillFilesForRuntimeExecution).mockResolvedValue([
      {
        skillId: "sk_1",
        path: "big.bin",
        size: SKILL_FILE_MAX_READ_BYTES + 1,
        url: "https://blob/big",
      },
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      readCloudSkillFileForActor(guest, "sk_1", "big.bin")
    ).rejects.toMatchObject({ status: 413 });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("502s a storage response that isn't ok", async () => {
    vi.mocked(convexListSkillFilesForRuntimeExecution).mockResolvedValue([
      { skillId: "sk_1", path: "notes.md", size: 5, url: "https://blob/1" },
    ]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(
      readCloudSkillFileForActor(guest, "sk_1", "notes.md")
    ).rejects.toMatchObject({ status: 502 });
    fetchMock.mockRestore();
  });

  it("keeps the member read on the member query", async () => {
    vi.mocked(convexGetSkillFileUrl).mockResolvedValue({
      url: null,
      size: 0,
    });
    await expect(
      readCloudSkillFileForActor(member, "sk_1", "notes.md")
    ).rejects.toBeInstanceOf(CloudSkillsError);
    expect(convexGetSkillFileUrl).toHaveBeenCalledWith(
      "Bearer member",
      "proj_1",
      "sk_1",
      "notes.md"
    );
    expect(convexListSkillFilesForRuntimeExecution).not.toHaveBeenCalled();
  });
});
