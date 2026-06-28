import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Fake E2B sandbox filesystem ──────────────────────────────────────────
// cloud-skills.ts talks to the computer only through `Sandbox.connect(...)` +
// `sandbox.files.*`. We mock the `e2b` module with an in-memory FS so the
// whole service is exercised without a vendor account. The control plane
// (reserve / sandbox-info) is stubbed via global fetch, exactly like
// computers-bash-tool.test.ts.

class FakeFs {
  files = new Map<string, string | Uint8Array>();
  dirs = new Set<string>();

  mkdir(p: string) {
    const parts = p.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur += "/" + part;
      this.dirs.add(cur);
    }
  }
  writeText(p: string, data: string) {
    this.mkdir(p.slice(0, p.lastIndexOf("/")));
    this.files.set(p, data);
  }

  list(dir: string) {
    const prefix = dir.endsWith("/") ? dir : dir + "/";
    const seen = new Map<string, "file" | "dir">();
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length);
        const name = rest.split("/")[0];
        seen.set(name, rest.includes("/") ? "dir" : "file");
      }
    }
    for (const d of this.dirs) {
      if (d.startsWith(prefix)) {
        const name = d.slice(prefix.length).split("/")[0];
        if (name && !seen.has(name)) seen.set(name, "dir");
      }
    }
    return Array.from(seen.entries()).map(([name, type]) => ({
      name,
      type,
      path: prefix + name,
      size:
        type === "file"
          ? byteLen(this.files.get(prefix + name) ?? "")
          : 0,
    }));
  }
}

function byteLen(v: string | Uint8Array): number {
  return typeof v === "string" ? new TextEncoder().encode(v).length : v.byteLength;
}

let fs: FakeFs;

vi.mock("e2b", () => {
  // Defined inside the factory: vi.mock is hoisted above top-level class
  // declarations, so a class referenced here would hit the TDZ.
  class FakeFileNotFoundError extends Error {}
  return {
    FileNotFoundError: FakeFileNotFoundError,
    Sandbox: {
      connect: vi.fn(async () => ({
        files: {
          list: vi.fn(async (dir: string) => {
            const exists =
              fs.dirs.has(dir) ||
              [...fs.files.keys()].some((f) => f.startsWith(dir + "/"));
            if (!exists) throw new FakeFileNotFoundError(dir);
            return fs.list(dir);
          }),
          read: vi.fn(async (p: string, opts?: { format?: string }) => {
            const v = fs.files.get(p);
            if (v === undefined) throw new FakeFileNotFoundError(p);
            if (opts?.format === "bytes") {
              return typeof v === "string" ? new TextEncoder().encode(v) : v;
            }
            return typeof v === "string" ? v : new TextDecoder().decode(v);
          }),
          write: vi.fn(async (p: string, data: string | ArrayBuffer) => {
            fs.mkdir(p.slice(0, p.lastIndexOf("/")));
            fs.files.set(
              p,
              typeof data === "string" ? data : new Uint8Array(data),
            );
          }),
          makeDir: vi.fn(async (p: string) => {
            fs.mkdir(p);
            return true;
          }),
          remove: vi.fn(async (p: string) => {
            for (const k of [...fs.files.keys()]) {
              if (k === p || k.startsWith(p + "/")) fs.files.delete(k);
            }
            for (const d of [...fs.dirs]) {
              if (d === p || d.startsWith(p + "/")) fs.dirs.delete(d);
            }
          }),
          getInfo: vi.fn(async (p: string) => {
            if (fs.files.has(p)) {
              return { type: "file", size: byteLen(fs.files.get(p)!) };
            }
            if (fs.dirs.has(p)) return { type: "dir", size: 0 };
            throw new FakeFileNotFoundError(p);
          }),
        },
      })),
    },
  };
});

import {
  listCloudSkills,
  getCloudSkill,
  uploadCloudSkill,
  uploadCloudSkillFolder,
  deleteCloudSkill,
  listCloudSkillFiles,
  readCloudSkillFile,
  CloudSkillsError,
} from "../computers/cloud-skills";

const CLAUDE_SKILLS = "/home/user/.claude/skills";

function installControlPlaneStub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (path === "/computers/reserve") {
        return json({ computerId: "comp_1", status: "ready", provider: "e2b" });
      }
      if (path === "/computers/sandbox-info") {
        return json({
          computerId: "comp_1",
          providerComputerId: "sbx_42",
          provider: "e2b",
          status: "ready",
        });
      }
      throw new Error(`unexpected path ${path}`);
    }),
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ctx = { authHeader: "Bearer user-token", projectId: "proj_1" };

function seedSkill(name: string, description: string, body = "do the thing") {
  fs.writeText(
    `${CLAUDE_SKILLS}/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
  );
}

describe("cloud-skills service", () => {
  beforeEach(() => {
    fs = new FakeFs();
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    process.env.COMPUTERS_DATA_PLANE_SECRET = "secret";
    process.env.E2B_API_KEY = "e2b-key";
    installControlPlaneStub();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists skills across dirs, deduped by name", async () => {
    seedSkill("pdf-tools", "Process PDFs");
    fs.writeText(
      `/home/user/.mcpjam/skills/data-viz/SKILL.md`,
      `---\nname: data-viz\ndescription: Make charts\n---\n\nchart it`,
    );
    const list = await listCloudSkills(ctx);
    expect(list.map((s) => s.name).sort()).toEqual(["data-viz", "pdf-tools"]);
    expect(list.find((s) => s.name === "pdf-tools")?.path).toBe(
      "~/.claude/skills/pdf-tools",
    );
  });

  it("returns empty when no skills dirs exist", async () => {
    expect(await listCloudSkills(ctx)).toEqual([]);
  });

  it("gets a skill's full content", async () => {
    seedSkill("pdf-tools", "Process PDFs", "step 1\nstep 2");
    const skill = await getCloudSkill(ctx, "pdf-tools");
    expect(skill?.content).toBe("step 1\nstep 2");
    expect(await getCloudSkill(ctx, "missing")).toBeNull();
  });

  it("uploads a new skill to ~/.claude/skills", async () => {
    const skill = await uploadCloudSkill(ctx, {
      name: "greeter",
      description: "Say hi",
      content: "wave",
    });
    expect(skill.path).toBe("~/.claude/skills/greeter");
    expect(fs.files.has(`${CLAUDE_SKILLS}/greeter/SKILL.md`)).toBe(true);
  });

  it("rejects an invalid skill name on upload", async () => {
    await expect(
      uploadCloudSkill(ctx, { name: "Bad Name", description: "x", content: "y" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a duplicate skill", async () => {
    seedSkill("dupe", "first");
    await expect(
      uploadCloudSkill(ctx, { name: "dupe", description: "x", content: "y" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("uploads a folder with supporting files", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const skill = await uploadCloudSkillFolder(ctx, "kit", [
      { path: "SKILL.md", bytes: enc("---\nname: kit\ndescription: A kit\n---\n\nuse it") },
      { path: "scripts/run.py", bytes: enc("print('hi')") },
    ]);
    expect(skill.name).toBe("kit");
    expect(fs.files.has(`${CLAUDE_SKILLS}/kit/scripts/run.py`)).toBe(true);
  });

  it("rejects a folder whose SKILL.md name mismatches", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    await expect(
      uploadCloudSkillFolder(ctx, "kit", [
        { path: "SKILL.md", bytes: enc("---\nname: other\ndescription: x\n---\n\ny") },
      ]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("blocks path traversal in folder upload", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    await uploadCloudSkillFolder(ctx, "safe", [
      { path: "SKILL.md", bytes: enc("---\nname: safe\ndescription: x\n---\n\ny") },
      { path: "../../escape.txt", bytes: enc("nope") },
    ]);
    expect(fs.files.has("/home/user/escape.txt")).toBe(false);
    expect([...fs.files.keys()].some((k) => k.includes("escape.txt"))).toBe(
      false,
    );
  });

  it("lists and reads skill files; blocks traversal on read", async () => {
    seedSkill("docs", "Docs skill");
    fs.writeText(`${CLAUDE_SKILLS}/docs/notes/readme.md`, "hello");
    const files = await listCloudSkillFiles(ctx, "docs");
    const flat = JSON.stringify(files);
    expect(flat).toContain("SKILL.md");
    expect(flat).toContain("notes");

    const file = await readCloudSkillFile(ctx, "docs", "notes/readme.md");
    expect(file.content).toBe("hello");
    expect(file.isText).toBe(true);

    await expect(
      readCloudSkillFile(ctx, "docs", "../../../etc/passwd"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("deletes a skill", async () => {
    seedSkill("temp", "Temporary");
    expect(await deleteCloudSkill(ctx, "temp")).toBe(true);
    expect(await deleteCloudSkill(ctx, "temp")).toBe(false);
    expect(fs.files.has(`${CLAUDE_SKILLS}/temp/SKILL.md`)).toBe(false);
  });

  it("fails closed when the data plane is not configured", async () => {
    delete process.env.E2B_API_KEY;
    await expect(listCloudSkills(ctx)).rejects.toBeInstanceOf(CloudSkillsError);
  });
});
