import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { workspaces } = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8")
);

// Root workspaces are authoritative. npm ci validates their lockfile graph even
// when a Docker image installs only one workspace's production dependencies.
function missingManifests(dockerfile, inventory) {
  const install = /^\s*RUN\s+[^\n]*\bnpm\s+ci\b/m.exec(dockerfile);
  assert.ok(install, "Dockerfile must contain an npm ci dependency layer");
  const beforeInstall = dockerfile.slice(0, install.index);
  const copies = [...beforeInstall.matchAll(/^\s*COPY\s+([^\n]+)$/gm)].map(
    (match) => match[1].trim().split(/\s+/)
  );
  return inventory.filter((workspace) => {
    assert.doesNotMatch(
      workspace,
      /[*?{}]/,
      "Expand workspace globs before checking Docker manifests"
    );
    return !copies.some((parts) => {
      const destination = path.posix.normalize(parts.at(-1));
      return (
        parts
          .slice(0, -1)
          .some(
            (source) =>
              path.posix.normalize(source) === `${workspace}/package.json`
          ) &&
        [workspace, `${workspace}/`, `${workspace}/package.json`].includes(
          destination
        )
      );
    });
  });
}

for (const dockerfile of [
  "mcpjam-inspector/Dockerfile",
  "slack-app/Dockerfile",
  "discord-app/Dockerfile",
]) {
  test(`${dockerfile} includes every root workspace manifest before npm ci`, () => {
    for (const workspace of workspaces) {
      assert.ok(
        JSON.parse(
          readFileSync(path.join(root, workspace, "package.json"), "utf8")
        ).name
      );
    }
    assert.deepEqual(
      missingManifests(
        readFileSync(path.join(root, dockerfile), "utf8"),
        workspaces
      ),
      []
    );
  });
}

test("the guard rejects missing, misplaced, and too-late manifests", () => {
  assert.deepEqual(
    missingManifests(
      "COPY sdk/package.json sdk/\nRUN npm ci\nCOPY evaluators/package.json evaluators/",
      ["sdk", "evaluators"]
    ),
    ["evaluators"]
  );
  assert.deepEqual(
    missingManifests("COPY evaluators/package.json wrong/\nRUN npm ci", [
      "evaluators",
    ]),
    ["evaluators"]
  );
});
