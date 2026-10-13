import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateTelemetryFrames } from "../scripts/generate-telemetry-frames.mjs";
import { packagedTelemetryCatalog } from "../src/internal/packaged-telemetry";

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let directory: string;
let bundle: string;
let manifest: ReturnType<typeof generateTelemetryFrames>;
beforeAll(async () => {
  directory = mkdtempSync(join(sdk, ".telemetry-test-"));
  bundle = join(directory, "index.mjs");
  const entry = join(directory, "customer.ts");
  writeFileSync(
    entry,
    'export { EvalTest } from "../src/index.ts"; export { sdkDiagnosticBoundary } from "../src/internal/sentry-boundary.ts"; export function PRIVATE_SENTINEL() { return 1; }'
  );
  await build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    sourcemap: true,
    loader: { ".md": "text" },
    define: { __MCPJAM_SDK_VERSION__: '"1.2.3"' },
  });
  manifest = generateTelemetryFrames(bundle, sdk);
}, 30000);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it("runs the bundled hooks and final envelope with owned and customer frames", () => {
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { EvalTest, sdkDiagnosticBoundary } from ${JSON.stringify(pathToFileURL(bundle).href)};
    import { defaultStackParser } from '@sentry/node';
    let frames;
    try { new EvalTest({ id: 'synthetic-case', name: 'synthetic' }); }
    catch (error) { frames = defaultStackParser(error.stack).filter(f => f.filename === ${JSON.stringify(bundle)}); }
    const boundary = sdkDiagnosticBoundary('@mcpjam/sdk@1.2.3');
    const raw = { exception: { values: [{ type: 'Error', value: 'PRIVATE_SENTINEL', stacktrace: { frames: [
      ...frames, { filename: '/customer/PRIVATE_SENTINEL.js', function: frames[0].function },
      { filename: ${JSON.stringify(bundle)}, function: 'PRIVATE_SENTINEL' }
    ] } }] } };
    const event = await boundary.hooks.beforeSend(raw, { attachments: ['PRIVATE_SENTINEL'] });
    const envelope = [{}, [[{ type: 'event' }, event], [{ type: 'attachment' }, 'PRIVATE_SENTINEL']]];
    boundary.envelope(envelope);
    process.stdout.write(JSON.stringify({ functions: frames.map(f => f.function), event, envelope }));
  `,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DO_NOT_TRACK: "",
          MCPJAM_TELEMETRY_DISABLED: "",
        },
        timeout: 20000,
      }
    )
  );
  expect(result.functions.some((name: string) => name.startsWith("new "))).toBe(
    true
  );
  expect(manifest.functions).not.toContain("PRIVATE_SENTINEL");
  const kept = result.event.exception.values[0].stacktrace.frames;
  expect(kept).toHaveLength(result.functions.length);
  expect(kept[0].filename).toBe("dist/index.js");
  expect(result.envelope[1]).toHaveLength(1);
  expect(
    result.envelope[1][0][1].exception.values[0].stacktrace.frames
  ).toEqual(kept);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
}, 30000);

it.each(["missing", "malformed", "wrong-hash", "invalid-name"])(
  "fails closed for a %s sidecar",
  (kind) => {
    const path = join(directory, "telemetry-frames.generated.json");
    const original = readFileSync(path);
    try {
      if (kind === "missing") rmSync(path);
      else
        writeFileSync(
          path,
          kind === "malformed"
            ? "{"
            : JSON.stringify({
                ...manifest,
                ...(kind === "wrong-hash"
                  ? { sha256: "0".repeat(64) }
                  : { functions: ["customer PRIVATE_SENTINEL"] }),
              })
        );
      expect(packagedTelemetryCatalog(pathToFileURL(bundle).href)).toEqual({});
    } finally {
      writeFileSync(path, original);
    }
  }
);

it("rejects unmapped code following a trusted source-map segment", () => {
  const isolated = join(directory, "unmapped");
  mkdirSync(join(isolated, "src/internal"), { recursive: true });
  mkdirSync(join(isolated, "dist"));
  const file = join(isolated, "dist/index.js");
  writeFileSync(
    file,
    "function trusted() {} function PRIVATE_SENTINEL() {}\nfunction UNMAPPED() {}\n"
  );
  writeFileSync(
    `${file}.map`,
    JSON.stringify({
      version: 3,
      sources: ["../src/trusted.ts"],
      names: [],
      mappings: "SAAS",
    })
  );
  writeFileSync(
    join(isolated, "src/internal/telemetry-catalog.generated.json"),
    JSON.stringify({ frames: { "src/trusted.ts": ["trusted"] } })
  );
  expect(generateTelemetryFrames(file, isolated).functions).toEqual([
    "trusted",
  ]);
});
