import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listRepoFiles,
  MAX_REPO_FILES,
  parseLsFilesEntries,
} from "../resolver";

// This listing is the ONLY evidence rule C has. If its parsing regresses, the
// detector does not fail loudly — it quietly stops finding entry points, every
// candidate drops to `ownershipProof: 'unverified'` or is suppressed, and
// corpus recall moves for reasons nobody attributes to this function. Hence
// coverage for the three ways it can silently produce a wrong listing:
// NUL-delimited parsing, git failing, and the truncation cap.

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "repo-files-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

const record = (mode: string, path: string) => `${mode} 0000000000 0\t${path}`;

describe("parseLsFilesEntries — NUL-delimited records", () => {
  it("splits on NUL and reads the mode column into a kind", () => {
    const stdout = [
      record("100644", "package.json"),
      record("100755", "bin/cli"),
      record("120000", "server.js"),
      record("160000", "vendor/sub"),
      "",
    ].join("\0");

    expect(parseLsFilesEntries(stdout)).toEqual([
      { path: "package.json", kind: "file" },
      { path: "bin/cli", kind: "file" },
      { path: "server.js", kind: "symlink" },
      { path: "vendor/sub", kind: "other" },
    ]);
  });

  it("keeps a path containing a NEWLINE intact", () => {
    // The whole reason for `-z`: newlines are legal in git paths, and a
    // line-oriented parser would split one path into two bogus entries — two
    // lookups that silently miss.
    const stdout = `${record("100644", "src/we\nird.js")}\0`;
    expect(parseLsFilesEntries(stdout)).toEqual([
      { path: "src/we\nird.js", kind: "file" },
    ]);
  });

  it("keeps a path containing SPACES intact (the mode split is on the tab)", () => {
    const stdout = `${record("100644", "my dir/my server.js")}\0`;
    expect(parseLsFilesEntries(stdout)).toEqual([
      { path: "my dir/my server.js", kind: "file" },
    ]);
  });

  it("drops malformed records instead of guessing at them", () => {
    const stdout = ["no-tab-here", record("100644", "ok.js"), "\t", ""].join(
      "\0"
    );
    expect(parseLsFilesEntries(stdout)).toEqual([
      { path: "ok.js", kind: "file" },
    ]);
  });

  it("returns nothing for empty output", () => {
    expect(parseLsFilesEntries("")).toEqual([]);
  });

  it("truncates at MAX_REPO_FILES", () => {
    const stdout = Array.from({ length: MAX_REPO_FILES + 500 }, (_, i) =>
      record("100644", `f${i}.js`)
    ).join("\0");
    const entries = parseLsFilesEntries(stdout);
    expect(entries).toHaveLength(MAX_REPO_FILES);
    // Truncation is safe in the SUPPRESS direction only if it keeps a prefix of
    // real entries rather than corrupting the tail.
    expect(entries[MAX_REPO_FILES - 1]).toEqual({
      path: `f${MAX_REPO_FILES - 1}.js`,
      kind: "file",
    });
  });
});

describe("listRepoFiles — against real git", () => {
  it("reports a regular file as 'file' and a symlink as 'symlink'", () => {
    // Run against real git rather than a mocked stdout: mode 120000 is the one
    // fact this module exists to carry, and a fixture asserting our own guess
    // about git's output would not catch git disagreeing with it.
    const dir = tempDir();
    execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "package.json"), "{}\n");
    writeFileSync(join(dir, "real.js"), "//\n");
    symlinkSync("node_modules/acme/server.js", join(dir, "linked.js"));
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });

    const entries = listRepoFiles(dir);
    const byPath = new Map(entries.map((e) => [e.path, e.kind]));
    expect(byPath.get("package.json")).toBe("file");
    expect(byPath.get("real.js")).toBe("file");
    expect(byPath.get("linked.js")).toBe("symlink");
  });

  it("returns an empty listing when the command fails", () => {
    // Not a git repo -> `git ls-files` exits non-zero. An empty listing is a
    // VALID input (detection reads it as "no listing" and marks what it emits
    // unverified), so this must not throw into the caller.
    expect(listRepoFiles(tempDir())).toEqual([]);
  });

  it("returns an empty listing when the directory does not exist", () => {
    expect(listRepoFiles(join(tmpdir(), "definitely-not-here-0f8a2c"))).toEqual(
      []
    );
  });
});
