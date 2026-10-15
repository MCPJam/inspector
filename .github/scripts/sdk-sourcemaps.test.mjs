import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sdk = JSON.parse(readFileSync(join(root, "sdk/package.json"), "utf8"));

test("SDK packing injects map IDs after a rebuild and ships the upload bytes", () => {
  assert.equal(sdk.scripts.prepublishOnly, "npm run build");
  assert.equal(sdk.scripts.prepack, "npm run sentry:inject --silent 1>&2");
  const directory = mkdtempSync(join(tmpdir(), "sdk-sourcemaps-"));
  const dist = join(directory, "dist");
  const packed = join(directory, "packed");
  mkdirSync(dist);
  mkdirSync(packed);
  const scripts = {
    prepublishOnly: sdk.scripts.prepublishOnly,
    prepack: sdk.scripts.prepack,
    "sentry:inject": sdk.scripts["sentry:inject"],
    build: "node build.cjs",
  };
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "mcpjam-sdk-sourcemap-fixture",
      version: "1.0.0",
      files: sdk.files,
      scripts,
    }),
  );
  writeFileSync(
    join(directory, "build.cjs"),
    `const fs = require('node:fs');
    fs.writeFileSync('dist/index.js', 'exports.value = 1;\\n//# sourceMappingURL=index.js.map\\n');
    fs.writeFileSync('dist/index.js.map', JSON.stringify({ version: 3, file: 'index.js', sources: ['../src/index.ts'], sourcesContent: ['export const value = 1;'], names: [], mappings: 'AAAA' }));`,
  );
  const options = {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${join(root, "sdk/node_modules/.bin")}${delimiter}${join(root, "node_modules/.bin")}${delimiter}${process.env.PATH}`,
      SENTRY_AUTH_TOKEN: "",
    },
    stdio: "pipe",
    timeout: 30000,
  };
  try {
    // Exercise npm's publish ordering without contacting a registry.
    execFileSync("npm", ["run", "prepublishOnly", "--silent"], options);
    assert.doesNotMatch(
      readFileSync(join(dist, "index.js"), "utf8"),
      /sentry-dbid-|\/\/# debugId=/,
    );
    const output = execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", packed],
      { ...options, encoding: "utf8" },
    );
    const [metadata] = JSON.parse(output);
    assert.equal(metadata.name, "mcpjam-sdk-sourcemap-fixture");
    const archive = join(packed, metadata.filename);
    const code = readFileSync(join(dist, "index.js"), "utf8");
    const map = readFileSync(join(dist, "index.js.map"), "utf8");
    const mapMetadata = JSON.parse(map);
    const id = mapMetadata.debugId ?? mapMetadata.debug_id;
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    assert.ok(code.includes(`//# debugId=${id}`));
    assert.equal(
      execFileSync("tar", ["-xOf", archive, "package/dist/index.js"], {
        encoding: "utf8",
      }),
      code,
    );
    assert.equal(
      execFileSync("tar", ["-xOf", archive, "package/dist/index.js.map"], {
        encoding: "utf8",
      }),
      map,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("artifact smoke packs prepared bytes without local lifecycle dependencies", () => {
  const workflow = readFileSync(
    join(root, ".github/workflows/ask-mcpjam-smoke.yml"),
    "utf8",
  );
  const section = workflow.split(
    "- name: Pack the Inspector and the workspace packages it depends on",
  )[1];
  const commands = section
    .split("run: |\n")[1]
    .split("\n      - name:")[0]
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n");
  const directory = mkdtempSync(join(tmpdir(), "sdk-artifact-pack-"));
  try {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        private: true,
        workspaces: ["evaluators", "sdk", "inspector"],
      }),
    );
    for (const name of ["evaluators", "sdk", "inspector"]) {
      const workspace = join(directory, name);
      mkdirSync(join(workspace, "dist"), { recursive: true });
      writeFileSync(
        join(workspace, "package.json"),
        JSON.stringify({
          name: `@mcpjam/${name}`,
          version: "1.0.0",
          files: ["dist"],
          scripts: { prepack: "missing-artifact-build-dependency" },
        }),
      );
      writeFileSync(
        join(workspace, "dist/index.js"),
        "// prebuilt debugId=prepared\n",
      );
    }
    const outputFile = join(directory, "github-output");
    execFileSync("bash", ["-c", commands], {
      cwd: directory,
      env: {
        ...process.env,
        SOURCE: "artifact",
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: outputFile,
      },
      stdio: "pipe",
      timeout: 30000,
    });
    const tarballs = readFileSync(outputFile, "utf8")
      .trim()
      .replace(/^tarballs=/, "")
      .trim()
      .split(/\s+/);
    assert.equal(tarballs.length, 3);
    for (const archive of tarballs) {
      assert.equal(
        execFileSync("tar", ["-xOf", archive, "package/dist/index.js"], {
          encoding: "utf8",
        }),
        "// prebuilt debugId=prepared\n",
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
