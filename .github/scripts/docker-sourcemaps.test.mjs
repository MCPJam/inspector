import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

const read = (name) =>
  readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");
const dockerfile = read("mcpjam-inspector/Dockerfile");
const instruction = dockerfile
  .replace(/\\\r?\n/g, " ")
  .split("\n")
  .find((line) => line.startsWith("RUN --mount=type=secret,id=sentry_auth_token "));

test("the release passes the Sentry token only through a Docker secret", () => {
  const releaseJob = read(".github/workflows/release.yml")
    .split("\n  docker-release:\n")[1]?.split(/\n  \S/)[0];
  assert.match(
    releaseJob ?? "",
    /SENTRY_AUTH_TOKEN: \$\{\{ secrets\.SENTRY_AUTH_TOKEN \}\}/,
  );
  const workflow = read(".github/workflows/docker-release.yml");
  assert.match(workflow, /SENTRY_AUTH_TOKEN:\s+required: true/);
  assert.match(
    workflow,
    /secrets: \|\s+sentry_auth_token=\$\{\{ secrets\.SENTRY_AUTH_TOKEN \}\}/,
  );
  assert.doesNotMatch(workflow, /SENTRY_AUTH_TOKEN=\$\{\{/);
  assert.ok(instruction?.includes("build:server"));
});

for (const mounted of [true, false]) {
  test(
    `the server build receives the ${mounted ? "mounted" : "Railway fallback"} credential and removes maps`,
    { skip: process.platform === "win32" },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "docker-sourcemaps-"));
      try {
        const bin = join(dir, "bin");
        const maps = join(dir, "mcpjam-inspector/dist/server");
        mkdirSync(bin);
        mkdirSync(maps, { recursive: true });
        writeFileSync(join(maps, "index.js.map"), "{}");
        writeFileSync(
          join(bin, "npm"),
          `#!/bin/sh
if [ "$2" = "build:server" ]; then printf '%s' "$SENTRY_AUTH_TOKEN" > received; fi
`,
          { mode: 0o755 },
        );
        const secret = join(dir, "secret");
        if (mounted) writeFileSync(secret, "mounted-fixture-token");
        const command = instruction
          .replace(/^RUN --mount=\S+\s+/, "")
          .replaceAll("/run/secrets/sentry_auth_token", secret);
        execFileSync("/bin/sh", ["-ec", command], {
          cwd: dir,
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH}`,
            SENTRY_AUTH_TOKEN: "railway-fixture-token",
          },
          stdio: "pipe",
        });
        assert.equal(
          readFileSync(join(dir, "received"), "utf8"),
          mounted ? "mounted-fixture-token" : "railway-fixture-token",
        );
        assert.equal(existsSync(join(maps, "index.js.map")), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}
