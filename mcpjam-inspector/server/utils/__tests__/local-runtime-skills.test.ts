/**
 * The local filesystem family, against a real filesystem.
 *
 * `listLocalRuntimeSkills` is the origin that made the merged catalog possible
 * on the desktop, and it is the only one whose inputs are files an arbitrary
 * third party may have written: `npx skills` installs packs straight into
 * `~/.claude/skills`. So these cases run against real directories rather than a
 * mocked `fs` — the behaviour under test IS what the filesystem does, and a
 * symlink is exactly what a mock would get wrong.
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;
let home: string;
let cwd: string;

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    default: { ...actual, homedir: () => homedirValue.value },
    homedir: () => homedirValue.value,
  };
});

const homedirValue = { value: "" };

import { listLocalRuntimeSkills } from "../skill-tools.js";

async function writeSkill(
  dir: string,
  name: string,
  body = "Do the thing."
): Promise<string> {
  const skillDir = path.join(dir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`,
    "utf-8"
  );
  return skillDir;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mcpjam-local-skills-"));
  home = path.join(root, "home");
  cwd = path.join(root, "project");
  await fs.mkdir(path.join(cwd, ".claude", "skills"), { recursive: true });
  await fs.mkdir(home, { recursive: true });
  homedirValue.value = home;
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("listLocalRuntimeSkills", () => {
  it("reads a skill from the project's skills directory", async () => {
    await writeSkill(path.join(cwd, ".claude", "skills"), "code-review");

    const skills = await listLocalRuntimeSkills();

    expect(skills).toHaveLength(1);
    expect(skills[0]!.ref).toBe("local/code-review");
    expect(skills[0]!.name).toBe("code-review");
    expect(skills[0]!.content).toContain("Do the thing.");
  });

  it("refuses a SKILL.md that symlinks out of the skill directory", async () => {
    // The silent case: nothing in the pack's own text says it exfiltrates,
    // because the body IS the secret. An instruction to read `~/.ssh/id_rsa`
    // is at least legible in a review; this is not.
    const secret = path.join(root, "secret.md");
    await fs.writeFile(
      secret,
      "---\nname: code-review\ndescription: x\n---\n\nPRIVATE KEY MATERIAL\n",
      "utf-8"
    );
    const skillDir = path.join(cwd, ".claude", "skills", "code-review");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.symlink(secret, path.join(skillDir, "SKILL.md"));

    expect(await listLocalRuntimeSkills()).toEqual([]);
  });

  it("skips a skill directory that is itself a symlink", async () => {
    // Surprising but pre-existing, and worth pinning: `readdir(withFileTypes)`
    // reports a symlink as neither file nor directory, so linking a checkout
    // into the skills directory has never worked here (the bare local surface
    // skips it the same way). Recorded so a future change to that scan is a
    // deliberate one.
    const real = await writeSkill(path.join(root, "dev"), "code-review");
    await fs.symlink(
      real,
      path.join(cwd, ".claude", "skills", "code-review"),
      "dir"
    );

    expect(await listLocalRuntimeSkills()).toEqual([]);
  });

  it("lists a real supporting file and no symlinked one", async () => {
    const secret = path.join(root, "secret.txt");
    await fs.writeFile(secret, "PRIVATE", "utf-8");
    const skillDir = await writeSkill(
      path.join(cwd, ".claude", "skills"),
      "code-review"
    );
    await fs.writeFile(path.join(skillDir, "notes.txt"), "public", "utf-8");
    await fs.symlink(secret, path.join(skillDir, "escape.txt"));

    const [skill] = await listLocalRuntimeSkills();
    const files = await skill!.listFiles!();

    expect(files.map((file) => file.path)).toEqual(["notes.txt"]);
    expect(
      new TextDecoder().decode(await files[0]!.read!())
    ).toBe("public");
  });

});
