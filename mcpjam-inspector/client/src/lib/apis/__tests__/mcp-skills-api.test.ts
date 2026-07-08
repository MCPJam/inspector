import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const webPostMock = vi.fn();

vi.mock("@/lib/apis/web/base", () => {
  class WebApiError extends Error {
    status: number;
    code: string | null;
    constructor(status: number, code: string | null, message: string) {
      super(message);
      this.name = "WebApiError";
      this.status = status;
      this.code = code;
    }
  }
  return {
    WebApiError,
    webPost: (...args: unknown[]) => webPostMock(...args),
  };
});

import { buildSkillFileTree, uploadSkillFolder } from "../mcp-skills-api";
import { WebApiError } from "@/lib/apis/web/base";

const meta = (path: string, size = 10) => ({
  path,
  size,
  contentHash: "h",
  updatedAt: 0,
});

describe("buildSkillFileTree", () => {
  it("always includes SKILL.md first", () => {
    const tree = buildSkillFileTree([]);
    expect(tree[0]).toMatchObject({ name: "SKILL.md", type: "file" });
  });

  it("nests directories from flat paths", () => {
    const tree = buildSkillFileTree([
      meta("scripts/run.py"),
      meta("scripts/lib/util.py"),
      meta("refs/guide.md"),
    ]);
    const byName = Object.fromEntries(tree.map((n) => [n.name, n]));
    expect(byName["scripts"].type).toBe("directory");
    // scripts/ has run.py + a nested lib/ directory.
    const scriptsChildren = byName["scripts"].children!;
    expect(scriptsChildren.some((c) => c.name === "run.py")).toBe(true);
    const lib = scriptsChildren.find((c) => c.name === "lib");
    expect(lib?.type).toBe("directory");
    expect(lib?.children?.[0].name).toBe("util.py");
    expect(byName["refs"].children?.[0].name).toBe("guide.md");
  });

  it("carries file size and extension on leaf nodes", () => {
    const tree = buildSkillFileTree([meta("a/data.json", 42)]);
    const file = tree.find((n) => n.name === "a")!.children![0];
    expect(file).toMatchObject({
      name: "data.json",
      type: "file",
      size: 42,
      extension: ".json",
    });
  });
});

describe("uploadSkillFolder (cloud, atomic)", () => {
  const source = { kind: "cloud" as const, projectId: "proj_1" };
  const SKILL_MD = "---\nname: my-skill\ndescription: d\n---\n\nBody.";

  function makeFile(name: string, content: string, relPath?: string): File {
    const file = new File([content], name, { type: "text/plain" });
    if (relPath) {
      Object.defineProperty(file, "webkitRelativePath", {
        value: relPath,
        writable: false,
      });
    }
    // jsdom's File lacks the Blob read methods the API uses.
    Object.defineProperty(file, "text", { value: async () => content });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode(content).buffer,
    });
    return file;
  }

  const skillWire = {
    skillId: "s1",
    name: "my-skill",
    description: "d",
    sharing: "user" as const,
    isOwner: true,
    content: "Body.",
  };

  /** Route webPost by path; per-test overrides win. */
  function routeWebPost(
    overrides: Record<string, (payload: any) => Promise<unknown>> = {},
  ) {
    webPostMock.mockImplementation(async (path: string, payload: unknown) => {
      const override = overrides[path];
      if (override) return override(payload);
      switch (path) {
        case "/api/web/skills/create":
          return { success: true, skill: skillWire };
        case "/api/web/skills/list":
          return { skills: [skillWire] };
        case "/api/web/skills/files/upload-url":
          return { uploadUrl: "https://upload.test/u1" };
        case "/api/web/skills/files/attach":
          return { files: [] };
        case "/api/web/skills/delete":
          return { success: true };
        default:
          throw new Error(`unexpected webPost path: ${path}`);
      }
    });
  }

  const callsTo = (path: string) =>
    webPostMock.mock.calls.filter(([p]) => p === path);

  beforeEach(() => {
    webPostMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the raw SKILL.md as skillMd on create (server-side parse)", async () => {
    routeWebPost();
    const skill = await uploadSkillFolder(
      [makeFile("SKILL.md", SKILL_MD)],
      "my-skill",
      source,
    );
    expect(skill.name).toBe("my-skill");
    const [, payload] = callsTo("/api/web/skills/create")[0];
    expect(payload).toMatchObject({
      projectId: "proj_1",
      name: "my-skill",
      skillMd: SKILL_MD,
    });
  });

  it("rolls back the created skill and throws when a supporting file fails", async () => {
    routeWebPost();
    // The direct-to-Convex blob PUT fails for the supporting file.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    await expect(
      uploadSkillFolder(
        [
          makeFile("SKILL.md", SKILL_MD, "my-skill/SKILL.md"),
          makeFile("notes.txt", "hello", "my-skill/notes.txt"),
        ],
        "my-skill",
        source,
      ),
    ).rejects.toThrow(
      /Upload failed — nothing was saved\. Fix the failing files \(notes\.txt\) and retry\./,
    );
    expect(callsTo("/api/web/skills/delete")).toHaveLength(1);
  });

  it("surfaces BOTH facts when the rollback itself fails", async () => {
    routeWebPost({
      "/api/web/skills/delete": async () => {
        throw new Error("delete unavailable");
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    await expect(
      uploadSkillFolder(
        [
          makeFile("SKILL.md", SKILL_MD, "my-skill/SKILL.md"),
          makeFile("notes.txt", "hello", "my-skill/notes.txt"),
        ],
        "my-skill",
        source,
      ),
    ).rejects.toThrow(
      /supporting file\(s\) failed \(notes\.txt\).*removing the partially created skill also failed.*'my-skill'/s,
    );
  });

  it("surfaces a 409 name conflict directly — no resume probing", async () => {
    routeWebPost({
      "/api/web/skills/create": async () => {
        throw new WebApiError(409, "VALIDATION_ERROR", "name already exists");
      },
    });
    await expect(
      uploadSkillFolder(
        [
          makeFile("SKILL.md", SKILL_MD, "my-skill/SKILL.md"),
          makeFile("notes.txt", "hello", "my-skill/notes.txt"),
        ],
        "my-skill",
        source,
      ),
    ).rejects.toThrow(/name already exists/);
    // With rollback, partial states no longer persist — a 409 is a genuine
    // conflict, so nothing else is fetched, attached, or deleted.
    expect(callsTo("/api/web/skills/get-by-name")).toHaveLength(0);
    expect(callsTo("/api/web/skills/list")).toHaveLength(0);
    expect(callsTo("/api/web/skills/delete")).toHaveLength(0);
  });

  it("attaches uploaded files and succeeds without any rollback", async () => {
    routeWebPost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ storageId: "st_1" }),
      })),
    );
    const skill = await uploadSkillFolder(
      [
        makeFile("SKILL.md", SKILL_MD, "my-skill/SKILL.md"),
        makeFile("notes.txt", "hello", "my-skill/notes.txt"),
      ],
      "my-skill",
      source,
    );
    expect(skill.name).toBe("my-skill");
    const [, attachPayload] = callsTo("/api/web/skills/files/attach")[0];
    expect(attachPayload).toMatchObject({
      skillId: "s1",
      files: [expect.objectContaining({ path: "notes.txt", storageId: "st_1" })],
    });
    expect(callsTo("/api/web/skills/delete")).toHaveLength(0);
  });
});
