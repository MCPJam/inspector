import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  findGitWorktreeRoot,
  findNearestProjectLinkPath,
  inspectProjectLink,
  parseProjectLink,
  projectLinkPathForDir,
  projectLinkWriteDir,
} from "../src/lib/project-link.js";

const execFile = promisify(execFileCallback);

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "mcpjam-link-"));
}

function writeLink(directory: string, body: unknown): string {
  const filePath = projectLinkPathForDir(directory);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`);
  return filePath;
}

function assertSamePath(left: string, right: string): void {
  assert.equal(realpathSync(left), realpathSync(right));
}

test("parseProjectLink accepts version 1 with canonical http(s) apiUrl", () => {
  const parsed = parseProjectLink(
    {
      version: 1,
      project: { id: "proj-1", name: "Alpha" },
      organizationId: "org-1",
      apiUrl: "https://app.mcpjam.com/api/v1",
    },
    "/tmp/.mcpjam/project.json"
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.link.project.id, "proj-1");
    assert.equal(parsed.link.organizationId, "org-1");
  }
});

test("parseProjectLink rejects unsupported versions and empty names", () => {
  const version = parseProjectLink(
    { version: 2, project: { id: "p", name: "n" }, apiUrl: "https://x/api/v1" },
    "/x"
  );
  assert.equal(version.ok, false);

  const empty = parseProjectLink(
    {
      version: 1,
      project: { id: "p", name: "  " },
      apiUrl: "https://app.mcpjam.com/api/v1",
    },
    "/x"
  );
  assert.equal(empty.ok, false);

  const ftp = parseProjectLink(
    {
      version: 1,
      project: { id: "p", name: "n" },
      apiUrl: "ftp://example.com/api",
    },
    "/x"
  );
  assert.equal(ftp.ok, false);
});

test("outside Git, only cwd is inspected so a parent link is not ambient", () => {
  const parent = tmpDir();
  const child = path.join(parent, "nested");
  mkdirSync(child);
  writeLink(parent, {
    version: 1,
    project: { id: "home-proj", name: "Home" },
    apiUrl: "https://app.mcpjam.com/api/v1",
  });

  assert.equal(findGitWorktreeRoot(child), null);
  assert.equal(findNearestProjectLinkPath({ cwd: child }), undefined);
  assert.equal(inspectProjectLink({ cwd: child }).status, "missing");
  assert.equal(inspectProjectLink({ cwd: parent }).status, "valid");
});

test("inside Git, lookup walks to the worktree root inclusive", async () => {
  const root = tmpDir();
  await execFile("git", ["init"], { cwd: root });
  const nested = path.join(root, "apps", "cli");
  mkdirSync(nested, { recursive: true });
  const filePath = writeLink(root, {
    version: 1,
    project: { id: "root-proj", name: "Root" },
    apiUrl: "https://app.mcpjam.com/api/v1",
  });

  assertSamePath(findGitWorktreeRoot(nested) ?? "", root);
  assertSamePath(findNearestProjectLinkPath({ cwd: nested }) ?? "", filePath);
  assertSamePath(projectLinkWriteDir({ cwd: nested }), root);
  assertSamePath(projectLinkWriteDir({ cwd: nested, here: true }), nested);
});

test("nearest link wins over a parent link in the same worktree", async () => {
  const root = tmpDir();
  await execFile("git", ["init"], { cwd: root });
  const nested = path.join(root, "pkg");
  mkdirSync(nested);
  writeLink(root, {
    version: 1,
    project: { id: "root-proj", name: "Root" },
    apiUrl: "https://app.mcpjam.com/api/v1",
  });
  const nestedPath = writeLink(nested, {
    version: 1,
    project: { id: "nested-proj", name: "Nested" },
    apiUrl: "https://app.mcpjam.com/api/v1",
  });

  const inspection = inspectProjectLink({ cwd: nested });
  assert.equal(inspection.status, "valid");
  if (inspection.status === "valid") {
    assertSamePath(inspection.path, nestedPath);
    assert.equal(inspection.link.project.id, "nested-proj");
  }
});
