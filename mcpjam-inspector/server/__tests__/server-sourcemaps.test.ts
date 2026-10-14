import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
  uploadServerSourcemaps,
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
// esbuild resolves source symlinks, so the output root must use the same path.
const work = realpathSync(mkdtempSync(join(tmpdir(), "server sourcemaps-")));
let builds: string[] = [];
let injected: ReturnType<typeof injectServerSourcemaps>[] = [];

async function buildServer(name: string, banner: string): Promise<string> {
  if (typeof config === "function" || Array.isArray(config))
    throw new Error("Expected one server build configuration");
  const root = join(work, name);
  mkdirSync(join(root, "server"), { recursive: true });
  for (const [file, text] of Object.entries(FIXTURE))
    writeFileSync(join(root, "server", file), text);
  // Explicit entries avoid glob rewriting when Windows temp uses another drive.
  const entry = Object.fromEntries(
    ["index", "harness-install-cli"].map((name) => [
      name,
      join(root, "server", `${name}.ts`),
    ]),
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
  // Injected once here, so each test can also run on its own.
  injected = builds.map((root) =>
    injectServerSourcemaps(join(root, "dist/server")),
  );
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

it("ties each build's transport debug_meta to its map and maps the owned frame to its source", () => {
  const seen = builds.map((root, index) => {
    const dir = join(root, "dist/server");
    const [{ debugId }] = injected[index];
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

it("uploads under the frames' URL prefix and reports, not throws, a failed upload", () => {
  const summary = join(work, "step-summary.md");
  vi.stubEnv("GITHUB_STEP_SUMMARY", summary);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const target = { release: "9.9.9", dist: "npm", ids: "index.js id-1" };
    const calls: string[][] = [];
    const record = (args: string[]) => void calls.push(args);
    expect(uploadServerSourcemaps("dist/server", target, record)).toBe(true);
    const [args] = calls;
    expect(args.slice(0, 2)).toEqual(["sourcemaps", "upload"]);
    expect(args).toEqual(
      expect.arrayContaining([
        "--org=mcpjam-gh",
        "--project=inspector-server",
        "--release=9.9.9",
        "--dist=npm",
        "--strict",
        "dist/server",
      ]),
    );
    // Sentry matches an uploaded file to a frame by prefix + file name.
    const prefix = args
      .find((arg) => arg.startsWith("--url-prefix="))
      ?.slice("--url-prefix=".length);
    const { frameOutputNames } = sentryBuildMetadata(builds[0], [
      "dist/server/index.js",
    ]);
    expect(`${prefix}/index.js`).toBe(frameOutputNames["dist/server/index.js"]);

    const outage = () => {
      throw new Error("503 from sentry.io");
    };
    expect(uploadServerSourcemaps("dist/server", target, outage)).toBe(false);
    const failed =
      "[server-sourcemaps] NOT uploaded to mcpjam-gh/inspector-server release 9.9.9 dist npm: 503 from sentry.io";
    expect(log).toHaveBeenLastCalledWith(`::error::${failed}`);
    expect(readFileSync(summary, "utf8").split("\n")).toEqual([
      "[server-sourcemaps] uploaded index.js id-1 to mcpjam-gh/inspector-server release 9.9.9 dist npm",
      failed,
      "",
    ]);
  } finally {
    log.mockRestore();
    vi.unstubAllEnvs();
  }
});
