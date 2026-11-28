import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkVersionCommitBetween,
  parseReleaseCommit,
  releaseCommitMessage,
} from "./release-commit.mjs";

const releases = [
  { name: "@mcpjam/inspector", type: "minor", oldVersion: "3.21.2", newVersion: "3.22.0" },
  { name: "@mcpjam/sdk", type: "patch", oldVersion: "10.7.0", newVersion: "10.7.1" },
  { name: "@mcpjam/cli", type: "none", oldVersion: "6.2.2", newVersion: "6.2.2" },
];

test("the message round-trips the label, options and requester", () => {
  const message = releaseCommitMessage({
    releases,
    options: { deploy_backend_prod: true, deploy_webapp: true, skip_verify: false },
    requestedBy: "octocat",
  });
  assert.match(message, /^chore\(release\): version packages \(3\.22\.0\)\n/);
  assert.doesNotMatch(message, /@mcpjam\/cli/);
  assert.deepEqual(parseReleaseCommit(message), {
    label: "3.22.0",
    options: { deploy_backend_prod: true, deploy_webapp: true, skip_verify: false },
    requestedBy: "octocat",
  });
});

test("a packages-only release is labelled by its packages", () => {
  const message = releaseCommitMessage({
    releases: [{ name: "@mcpjam/sdk", type: "patch", oldVersion: "1.0.0", newVersion: "1.0.1" }],
    options: {},
  });
  assert.equal(parseReleaseCommit(message).label, "@mcpjam/sdk 1.0.1");
});

test("other commits and malformed options never read as a deploy", () => {
  assert.equal(parseReleaseCommit("fix: something\n\nRelease-Versions: 1.0.0"), null);
  assert.equal(parseReleaseCommit("chore(release): version packages (1.0.0)\n"), null);
  const parsed = parseReleaseCommit(
    "chore(release): version packages (1.0.0)\n\nRelease-Versions: 1.0.0\nRelease-Deploy-Webapp: yes\n"
  );
  assert.deepEqual(parsed.options, { deploy_backend_prod: false, deploy_webapp: false, skip_verify: false });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "release-commit-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const write = (path, content) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  write("package.json", { name: "root", private: true, workspaces: ["sdk", "cli"] });
  write("sdk/package.json", { name: "@mcpjam/sdk", version: "1.0.0", dependencies: { zod: "^3.0.0" } });
  write("cli/package.json", { name: "@mcpjam/cli", version: "2.0.0", dependencies: { "@mcpjam/sdk": "^1.0.0" } });
  write("sdk/CHANGELOG.md", "# @mcpjam/sdk\n");
  write("sdk/index.js", "export const a = 1;\n");
  write(".changeset/brave-fox.md", "---\n\"@mcpjam/sdk\": patch\n---\n\nFix\n");
  write("package-lock.json", {
    name: "root",
    lockfileVersion: 3,
    packages: {
      "": { name: "root", workspaces: ["sdk", "cli"] },
      sdk: { name: "@mcpjam/sdk", version: "1.0.0", dependencies: { zod: "^3.0.0" } },
      cli: { name: "@mcpjam/cli", version: "2.0.0", dependencies: { "@mcpjam/sdk": "^1.0.0" } },
      "node_modules/zod": { version: "3.0.0", resolved: "https://registry.npmjs.org/zod/-/zod-3.0.0.tgz" },
    },
  });
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { dir, git, write, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function bump({ write, git }) {
  write("sdk/package.json", { name: "@mcpjam/sdk", version: "1.0.1", dependencies: { zod: "^3.0.0" } });
  write("cli/package.json", { name: "@mcpjam/cli", version: "2.0.1", dependencies: { "@mcpjam/sdk": "^1.0.1" } });
  write("sdk/CHANGELOG.md", "# @mcpjam/sdk\n\n## 1.0.1\n\n- Fix\n");
  git("rm", "-q", ".changeset/brave-fox.md");
  write("package-lock.json", {
    name: "root",
    lockfileVersion: 3,
    packages: {
      "": { name: "root", workspaces: ["sdk", "cli"] },
      sdk: { name: "@mcpjam/sdk", version: "1.0.1", dependencies: { zod: "^3.0.0" } },
      cli: { name: "@mcpjam/cli", version: "2.0.1", dependencies: { "@mcpjam/sdk": "^1.0.1" } },
      "node_modules/zod": { version: "3.0.0", resolved: "https://registry.npmjs.org/zod/-/zod-3.0.0.tgz" },
    },
  });
}

test("a plain version bump passes", (t) => {
  const r = repo();
  t.after(r.cleanup);
  bump(r);
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "version");
  assert.deepEqual(checkVersionCommitBetween("HEAD^", "HEAD", r.dir), []);
});

test("source code, new files and dependency changes are refused", (t) => {
  const r = repo();
  t.after(r.cleanup);
  bump(r);
  r.write("sdk/index.js", "export const a = 2;\n");
  r.write("sdk/new.js", "export {};\n");
  r.write("sdk/package.json", { name: "@mcpjam/sdk", version: "1.0.1", dependencies: { zod: "^4.0.0" } });
  r.write("package-lock.json", {
    name: "root",
    lockfileVersion: 3,
    packages: {
      "": { name: "root", workspaces: ["sdk", "cli"] },
      sdk: { name: "@mcpjam/sdk", version: "1.0.1", dependencies: { zod: "^3.0.0" } },
      cli: { name: "@mcpjam/cli", version: "2.0.1", dependencies: { "@mcpjam/sdk": "^1.0.1" } },
      "node_modules/zod": { version: "3.0.1", resolved: "https://example.com/zod.tgz" },
    },
  });
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "not a version commit");
  const problems = checkVersionCommitBetween("HEAD^", "HEAD", r.dir);
  assert.deepEqual(problems.sort(), [
    "package-lock.json: changes more than workspace versions and sibling ranges",
    "sdk/index.js: a version commit may not change this file",
    "sdk/new.js: a version commit may not add this file",
    "sdk/package.json: changes more than versions and sibling ranges",
  ]);
});

test("deleting anything but a changeset is refused", (t) => {
  const r = repo();
  t.after(r.cleanup);
  r.git("rm", "-q", "sdk/index.js");
  r.git("commit", "-q", "-m", "delete");
  assert.deepEqual(checkVersionCommitBetween("HEAD^", "HEAD", r.dir), [
    "sdk/index.js: a version commit may not delete this file",
  ]);
});
