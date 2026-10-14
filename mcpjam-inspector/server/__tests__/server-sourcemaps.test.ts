import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { createStackParser, nodeStackLineParser } from "@sentry/core";
import { build } from "tsup";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import config from "../tsup.config";
import {
  injectServerSourcemaps,
  verifyServerSourcemaps,
} from "../../scripts/server-sourcemaps.mjs";
import { sentryBuildMetadata } from "../../shared/sentry-build-metadata";
import {
  INSPECTOR_SENTRY_CATALOG,
  restrictSentryEnvelope,
} from "../../shared/strict-sentry";

// `lazy` is imported dynamically: a code split would emit it as an unowned chunk.
const FIXTURE = {
  "index.ts": `export function fail(reason: string): never {
  const detail = { reason, retries: reason.length };
  throw new Error(detail.reason);
}
export const later = () => import("./lazy").then((lazy) => lazy.describe(3));\n`,
  "lazy.ts": `export function describe(count: number) {
  const words = Array.from({ length: count }, (_, index) => String(index));
  return words.join(",");
}\n`,
  "harness-install-cli.ts": `export function install(target: string) {
  const parts = target.trim().split("/");
  return parts.filter((part) => part.length > 0).join("/");
}\n`,
};
const THROW = "throw new Error(detail.reason)";
const work = mkdtempSync(join(tmpdir(), "server-sourcemaps-"));
let builds: string[] = [];

async function buildServer(name: string, banner: string): Promise<string> {
  if (typeof config === "function" || Array.isArray(config))
    throw new Error("Expected one server build configuration");
  const root = join(work, name);
  mkdirSync(join(root, "server"), { recursive: true });
  for (const [file, text] of Object.entries(FIXTURE))
    writeFileSync(join(root, "server", file), text);
  const entry = ["index.ts", "harness-install-cli.ts"].map((file) =>
    join(root, "server", file),
  );
  await build({
    ...config,
    config: false,
    silent: true,
    entry,
    outDir: join(root, "dist/server"),
    banner: { js: banner },
  });
  return root;
}

// Real tsup builds and sentry-cli runs can outlast vitest's default timeouts on a slow runner.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// The second build differs only by a banner that moves every emitted line.
beforeAll(async () => {
  builds = [
    await buildServer("a", ""),
    await buildServer("b", "// offset\n// offset\n// offset"),
  ];
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

it("ties each build's transport debug_meta to its map and maps the owned frame to its source", () => {
  const seen = builds.map((root) => {
    const dir = join(root, "dist/server");
    const [{ debugId }] = injectServerSourcemaps(dir);
    const map = JSON.parse(readFileSync(join(dir, "index.js.map"), "utf8"));
    expect(debugId).toBe(map.debugId ?? map.debug_id);
    const lines = readFileSync(join(dir, "index.js"), "utf8").split("\n");
    const lineno = lines.findIndex((text) => text.includes(THROW)) + 1;
    const colno = lines[lineno - 1].indexOf(THROW) + 1;
    const url = pathToFileURL(join(dir, "index.js")).href;
    const frames = createStackParser(nodeStackLineParser())(
      `Error: x\n    at fail (${url}:${lineno}:${colno})`,
    );
    const event = {
      exception: { values: [{ type: "Error", stacktrace: { frames } }] },
    };
    const envelope = { 0: {}, 1: [[{ type: "event" }, event]] };
    restrictSentryEnvelope(envelope, {
      ...INSPECTOR_SENTRY_CATALOG,
      ...sentryBuildMetadata(root, ["dist/server/index.js"]),
    });
    const filename = "app:///dist/server/index.js";
    expect(envelope[1]).toMatchObject([
      [
        { type: "event" },
        {
          debug_meta: {
            images: [
              { type: "sourcemap", code_file: filename, debug_id: debugId },
            ],
          },
          exception: {
            values: [{ stacktrace: { frames: [{ filename, lineno, colno }] } }],
          },
        },
      ],
    ]);
    expect(
      originalPositionFor(new TraceMap(map), {
        line: lineno,
        column: colno - 1,
      }),
    ).toMatchObject({ source: "../../server/index.ts", line: 3 });
    return { debugId, lineno };
  });
  expect(seen[1].debugId).not.toBe(seen[0].debugId);
  expect(seen[1].lineno).toBe(seen[0].lineno + 3);
});

it("fails a shifted, mismatched, missing or uninjected map and any unowned output", () => {
  const [a, b] = builds.map((root) => join(root, "dist/server"));
  const broken = join(work, "broken");
  const reset = () => {
    rmSync(broken, { recursive: true, force: true });
    cpSync(a, broken, { recursive: true });
  };
  const [mapPath, codePath] = ["index.js.map", "index.js"].map((file) =>
    join(broken, file),
  );
  const { debug_id, debugId } = JSON.parse(
    readFileSync(join(a, "index.js.map"), "utf8"),
  );
  const mapB = readFileSync(join(b, "index.js.map"), "utf8");

  reset();
  expect(verifyServerSourcemaps(broken)).toHaveLength(2);
  // The other build's mappings under this build's ID.
  writeFileSync(
    mapPath,
    JSON.stringify({ ...JSON.parse(mapB), debug_id, debugId }),
  );
  expect(() => verifyServerSourcemaps(broken)).toThrow(/first-party mappings/);
  writeFileSync(mapPath, mapB);
  expect(() => verifyServerSourcemaps(broken)).toThrow(/does not match/);
  rmSync(mapPath);
  expect(() => verifyServerSourcemaps(broken)).toThrow(/ENOENT/);

  reset();
  writeFileSync(
    codePath,
    readFileSync(codePath, "utf8").replace(/\/\/# debugId=.*\s*$/, ""),
  );
  expect(() => verifyServerSourcemaps(broken)).toThrow(/does not match/);
  reset();
  writeFileSync(join(broken, "chunk-ABC123.js"), "export {};\n");
  expect(() => verifyServerSourcemaps(broken)).toThrow(/unowned outputs/);
});
