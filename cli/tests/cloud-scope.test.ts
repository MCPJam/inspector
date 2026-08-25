import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CliError } from "../src/lib/output.js";
import {
  appendProjectLinkHint,
  describeProjectScope,
  resolveProjectSelector,
} from "../src/lib/cloud-scope.js";
import { projectLinkPathForDir } from "../src/lib/project-link.js";

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "mcpjam-scope-"));
}

function writeLink(
  directory: string,
  project: { id: string; name: string }
): string {
  const filePath = projectLinkPathForDir(directory);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        version: 1,
        project,
        apiUrl: "https://app.mcpjam.com/api/v1",
      },
      null,
      2
    )}\n`
  );
  return filePath;
}

test("project selector precedence is flag, input, env, link, automatic", () => {
  const cwd = tmpDir();
  const linkPath = writeLink(cwd, { id: "from-link", name: "Linked" });
  const env = { MCPJAM_PROJECT: "from-env" };

  assert.deepEqual(
    resolveProjectSelector({
      flagProject: "from-flag",
      inputProject: "from-input",
      env,
      cwd,
    }),
    { kind: "project", selector: "from-flag", source: "flag" }
  );

  assert.deepEqual(
    resolveProjectSelector({
      inputProject: "from-input",
      env,
      cwd,
    }),
    { kind: "project", selector: "from-input", source: "input" }
  );

  assert.deepEqual(resolveProjectSelector({ env, cwd }), {
    kind: "project",
    selector: "from-env",
    source: "env",
  });

  assert.deepEqual(resolveProjectSelector({ env: {}, cwd }), {
    kind: "project",
    selector: "from-link",
    source: "link",
    linkPath,
    linkedName: "Linked",
  });

  assert.deepEqual(
    resolveProjectSelector({ env: {}, cwd: tmpDir(), ignoreLink: true }),
    { kind: "project", source: "automatic" }
  );
});

test("empty flag and MCPJAM_PROJECT are usage errors, not automatic", () => {
  assert.throws(
    () => resolveProjectSelector({ flagProject: "  " }),
    (error: unknown) =>
      error instanceof CliError &&
      error.exitCode === 2 &&
      /--project cannot be empty/.test(error.message)
  );
  assert.throws(
    () =>
      resolveProjectSelector({
        flagProject: "  ",
        emptyFlagMessage:
          "Project argument cannot be empty. Omit it to use MCPJAM_PROJECT or automatic selection.",
      }),
    (error: unknown) =>
      error instanceof CliError &&
      error.exitCode === 2 &&
      /Project argument cannot be empty/.test(error.message) &&
      !/--project/.test(error.message)
  );
  assert.throws(
    () => resolveProjectSelector({ env: { MCPJAM_PROJECT: "" } }),
    (error: unknown) =>
      error instanceof CliError &&
      error.exitCode === 2 &&
      /MCPJAM_PROJECT cannot be empty/.test(error.message)
  );
});

test("malformed link hard-errors instead of falling through to automatic", () => {
  const cwd = tmpDir();
  const filePath = projectLinkPathForDir(cwd);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "{ not json\n");

  assert.throws(
    () => resolveProjectSelector({ env: {}, cwd }),
    (error: unknown) =>
      error instanceof CliError &&
      error.exitCode === 1 &&
      error.message.includes(filePath)
  );
});

test("describeProjectScope never says default", () => {
  assert.equal(
    describeProjectScope({ kind: "project", source: "automatic" }),
    "automatic (most recently updated)"
  );
  assert.equal(
    describeProjectScope({
      kind: "project",
      source: "link",
      selector: "id",
      linkedName: "Alpha",
      linkPath: "/repo/.mcpjam/project.json",
    }),
    "link (Alpha)"
  );
  assert.doesNotMatch(
    describeProjectScope({ kind: "project", source: "automatic" }),
    /default/i
  );
});

test("stale-link hint is appended only for project selector failures", () => {
  const scope = {
    kind: "project" as const,
    source: "link" as const,
    selector: "gone",
    linkPath: "/repo/.mcpjam/project.json",
    linkedName: "Gone",
  };
  assert.match(
    appendProjectLinkHint('Project "gone" was not found.', scope),
    /Selector came from \/repo\/\.mcpjam\/project\.json — re-run `mcpjam cloud link`\./
  );
  assert.equal(
    appendProjectLinkHint('Eval suite "s" was not found.', scope),
    'Eval suite "s" was not found.'
  );
  assert.equal(
    appendProjectLinkHint(
      "Project Alpha has no GitHub organization connected.",
      scope
    ),
    "Project Alpha has no GitHub organization connected."
  );
});
