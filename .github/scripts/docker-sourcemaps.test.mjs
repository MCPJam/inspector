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
const instructions = dockerfile.replace(/\\\r?\n/g, " ").split("\n");
const buildServer = instructions.find((line) =>
  line.startsWith("RUN ") && line.includes("npm run build:server"),
);
const stripMaps = instructions.find((line) =>
  line.startsWith("RUN rm mcpjam-inspector/dist/server/*.map"),
);
const workflow = read(".github/workflows/docker-release.yml");
const upload = workflow.split("      - name: Upload server source maps\n")[1]
  ?.split("\n      - name:")[0];

test("Docker releases upload from the shared server stage without build secrets", () => {
  const releaseJob = read(".github/workflows/release.yml")
    .split("\n  docker-release:\n")[1]?.split(/\n  \S/)[0];
  assert.match(releaseJob ?? "", /SENTRY_AUTH_TOKEN: \$\{\{ secrets\.SENTRY_AUTH_TOKEN \}\}/);
  assert.match(workflow, /SENTRY_AUTH_TOKEN:\s+required: true/);
  const stage = workflow.split("      - name: Build server source-map stage\n")[1]
    ?.split("\n      - name:")[0];
  assert.match(stage ?? "", /target: server-build\s+load: true/);
  assert.match(stage ?? "", /tags: mcpjam-server-sourcemaps:local/);
  assert.match(upload ?? "", /SENTRY_AUTH_TOKEN: \$\{\{ secrets\.SENTRY_AUTH_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /sentry_auth_token=|SENTRY_AUTH_TOKEN=\$\{\{/);
  assert.doesNotMatch(dockerfile, /--mount=type=secret/);
  assert.match(dockerfile, /FROM server-build AS build/);
  assert.match(dockerfile, /COPY --from=build .*\/dist \.\/dist/);
  assert.ok(dockerfile.indexOf(stripMaps) > dockerfile.indexOf("FROM server-build AS build"));
});

test("the uploader receives a runtime credential without putting it in Docker arguments", {
  skip: process.platform === "win32",
}, () => {
  const dir = mkdtempSync(join(tmpdir(), "docker-upload-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), `#!/bin/sh
printf '%s\\n' "$@" > arguments
printf '%s' "$SENTRY_AUTH_TOKEN" > received
`, { mode: 0o755 });
    const command = upload.split("        run: |\n")[1];
    execFileSync("/bin/sh", ["-ec", command], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, SENTRY_AUTH_TOKEN: "runtime-fixture-token" },
    });
    assert.equal(readFileSync(join(dir, "received"), "utf8"), "runtime-fixture-token");
    assert.deepEqual(readFileSync(join(dir, "arguments"), "utf8").trim().split("\n"), [
      "run", "--rm", "--env", "SENTRY_AUTH_TOKEN", "--entrypoint", "node",
      "mcpjam-server-sourcemaps:local", "mcpjam-inspector/scripts/server-sourcemaps.mjs",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Railway builds with its ARG credential and only the runtime stage removes maps", {
  skip: process.platform === "win32",
}, () => {
  const dir = mkdtempSync(join(tmpdir(), "docker-sourcemaps-"));
  try {
    const bin = join(dir, "bin");
    const maps = join(dir, "mcpjam-inspector/dist/server");
    mkdirSync(bin);
    mkdirSync(maps, { recursive: true });
    writeFileSync(join(maps, "index.js.map"), "{}");
    writeFileSync(join(maps, "index.js"), "verified server bytes");
    writeFileSync(join(bin, "npm"), `#!/bin/sh
if [ "$2" = "build:server" ]; then printf '%s' "$SENTRY_AUTH_TOKEN" > received; fi
`, { mode: 0o755 });
    execFileSync("/bin/sh", ["-ec", buildServer.replace(/^RUN /, "")], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, SENTRY_AUTH_TOKEN: "railway-fixture-token" },
    });
    assert.equal(readFileSync(join(dir, "received"), "utf8"), "railway-fixture-token");
    assert.ok(existsSync(join(maps, "index.js.map")));
    execFileSync("/bin/sh", ["-ec", stripMaps.replace(/^RUN /, "")], { cwd: dir });
    assert.equal(existsSync(join(maps, "index.js.map")), false);
    assert.equal(readFileSync(join(maps, "index.js"), "utf8"), "verified server bytes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
