import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let directory: string;
// The space makes module URLs percent-encoded while Sentry's parser reports
// decoded paths, as in a Windows "Program Files" install.
beforeAll(() => { directory = mkdtempSync(join(sdk, ".telemetry test-")); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

// The CLI's Node entry runs on every OS; the .bin shim needs a shell on Windows.
const injectDebugIds = (dir: string) => execFileSync(process.execPath, [join(sdk, "node_modules/@sentry/cli/bin/sentry-cli"), "sourcemaps", "inject", dir], { stdio: "pipe", timeout: 20000 });

// Child-process source: parse a real constructor failure with Sentry's Node
// parser, keep the frames naming `file`, and repeat each as the native path and
// module URL that CommonJS and unparsed ESM frames carry.
const framesFrom = (Test: string, file: string) => `(() => {
  try { new ${Test}({ id: 'synthetic-case', name: 'synthetic' }); }
  catch (error) { return defaultStackParser(error.stack).filter(f => f.filename && resolve(f.filename) === ${JSON.stringify(file)})
    .flatMap(f => [f, { ...f, filename: ${JSON.stringify(file)} }, { ...f, filename: ${JSON.stringify(pathToFileURL(file).href)} }]); }
})()`;

it("keeps real packaged constructor file/line locations without shipping function labels or customer paths", async () => {
  const entry = join(directory, "entry.ts");
  const packageRoot = join(directory, "node_modules/@mcpjam/sdk");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@mcpjam/sdk", type: "module" }));
  const bundle = join(packageRoot, "dist/index.js");
  writeFileSync(entry, 'export { EvalTest } from "../src/index.ts"; export { sdkDiagnosticBoundary } from "../src/internal/sentry-boundary.ts";');
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, sourcemap: true, format: "esm", platform: "node", packages: "external", loader: { ".md": "text" }, define: { __MCPJAM_SDK_VERSION__: '"1.2.3"' } });
  injectDebugIds(join(packageRoot, "dist"));
  // A customer rebundle at the same package-relative path: only package
  // provenance tells it apart, and its frames must never alias SDK files.
  const customerRoot = join(directory, "customer app");
  mkdirSync(join(customerRoot, "dist"), { recursive: true });
  writeFileSync(join(customerRoot, "package.json"), JSON.stringify({ name: "customer-app", type: "module" }));
  const customer = join(customerRoot, "dist/index.js");
  await build({ entryPoints: [entry], outfile: customer, bundle: true, format: "esm", platform: "node", packages: "external", loader: { ".md": "text" }, define: { __MCPJAM_SDK_VERSION__: '"1.2.3"' } });
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { EvalTest, sdkDiagnosticBoundary } from ${JSON.stringify(pathToFileURL(bundle).href)};
    import { EvalTest as CustomerTest, sdkDiagnosticBoundary as customerBoundary } from ${JSON.stringify(pathToFileURL(customer).href)};
    import { defaultStackParser } from '@sentry/node';
    import { resolve } from 'node:path';
    const frames = ${framesFrom("EvalTest", bundle)};
    const customerFrames = ${framesFrom("CustomerTest", customer)};
    const sent = [];
    const transport = sdkDiagnosticBoundary('@mcpjam/sdk@1.2.3')({ send: async envelope => { sent.push(envelope); return {}; }, flush: async () => true });
    const raw = { exception: { values: [{ type: 'Error', value: 'PRIVATE_SENTINEL', stacktrace: { frames: [
      ...[...frames, ...customerFrames].map(frame => ({ ...frame, function: 'PRIVATE_SENTINEL', pre_context: ['PRIVATE_SENTINEL'] })),
      { filename: '/customer/PRIVATE_SENTINEL/index.mjs', lineno: 10, function: 'PRIVATE_SENTINEL' }
    ] } }] } };
    await transport.send([{}, [[{ type: 'event' }, raw], [{ type: 'attachment' }, 'PRIVATE_SENTINEL']]]);
    const unknown = [];
    await customerBoundary('@mcpjam/sdk@1.2.3')({ send: async envelope => { unknown.push(envelope); return {}; }, flush: async () => true })
      .send([{}, [[{ type: 'event' }, { exception: { values: [{ type: 'Error', stacktrace: { frames: [...customerFrames, ...frames, { filename: 'dist/index.js', lineno: 1 }] } }] } }]]]);
    process.stdout.write(JSON.stringify({ count: frames.length, customerCount: customerFrames.length, sent, unknown }));
  `], { encoding: "utf8", env: { ...process.env, DO_NOT_TRACK: "", MCPJAM_TELEMETRY_DISABLED: "" }, timeout: 20000 }));
  expect(result.count).toBeGreaterThan(0);
  expect(result.customerCount).toBeGreaterThan(0);
  const kept = result.sent[0][1][0][1].exception.values[0].stacktrace.frames;
  expect(kept).toHaveLength(result.count);
  expect(kept.every((frame: { filename: string; lineno: number }) => frame.filename === "dist/index.js" && Number.isInteger(frame.lineno))).toBe(true);
  expect(result.sent[0][1][0][1].extra.dropped_frames).toBe(result.customerCount + 1);
  expect(result.sent[0][1]).toHaveLength(1);
  const map = JSON.parse(readFileSync(`${bundle}.map`, "utf8"));
  const debugId = map.debugId ?? map.debug_id;
  expect(result.sent[0][1][0][1]).toMatchObject({
    platform: "node",
    debug_meta: { images: [{ type: "sourcemap", code_file: "dist/index.js", debug_id: debugId }] },
  });
  expect(debugId).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_SENTINEL|"function"|customer app|telemetry test-|file:/);
  expect(JSON.stringify(result.unknown)).not.toContain('"filename"');
  expect(result.unknown[0][1][0][1].extra.dropped_frames).toBe(result.count + result.customerCount + 1);
}, 60000);

it.each(["import", "require"])("retains owned frames from the actual built package with Node %s", (load) => {
  const packageRoot = join(directory, load, "node_modules/@mcpjam/sdk");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), readFileSync(join(sdk, "package.json")));
  const bundle = join(packageRoot, "dist/index.js");
  // Keep runtime line positions and the injected debug-ID footer intact while
  // exposing the private final transport for the test.
  const builtCode = readFileSync(join(sdk, "dist/index.js"), "utf8");
  const footer = builtCode.lastIndexOf("\n//# sourceMappingURL=");
  expect(footer).toBeGreaterThan(0);
  writeFileSync(bundle, builtCode.slice(0, footer) + "\nexport { sdkDiagnosticBoundary as testBoundary };\n" + builtCode.slice(footer));
  writeFileSync(`${bundle}.map`, readFileSync(join(sdk, "dist/index.js.map")));
  injectDebugIds(dirname(bundle));
  const map = JSON.parse(readFileSync(`${bundle}.map`, "utf8"));
  const debugId = map.debugId ?? map.debug_id;
  const program = `
    const sdk = ${load === "import" ? `await import(${JSON.stringify(pathToFileURL(bundle).href)})` : `require(${JSON.stringify(bundle)})`};
    const { defaultStackParser } = ${load === "import" ? "await import('@sentry/node')" : "require('@sentry/node')"};
    const { resolve } = ${load === "import" ? "await import('node:path')" : "require('node:path')"};
    const frames = ${framesFrom("sdk.EvalTest", bundle)};
    delete process.env.DO_NOT_TRACK;
    const sent = [];
    await sdk.testBoundary('@mcpjam/sdk@9.3.0')({ send: async value => { sent.push(value); return {}; }, flush: async () => true }).send([{}, [[{ type: 'event' }, { exception: { values: [{ type: 'Error', stacktrace: { frames } }] } }]]]);
    process.stdout.write(JSON.stringify({ count: frames.length, sent }));
  `;
  const script = load === "import" ? program : `(async () => { ${program} })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });`;
  const result = JSON.parse(execFileSync(process.execPath, [...(load === "import" ? ["--input-type=module"] : []), "-e", script], { encoding: "utf8", env: { ...process.env, DO_NOT_TRACK: "1", MCPJAM_TELEMETRY_DISABLED: "" }, timeout: 20000 }));
  expect(result.count).toBeGreaterThan(0);
  const frames = result.sent[0][1][0][1].exception.values[0].stacktrace.frames;
  expect(frames).toHaveLength(result.count);
  expect(frames.every((frame: { filename: string; lineno: number }) => frame.filename === "dist/index.js" && Number.isInteger(frame.lineno))).toBe(true);
  expect(result.sent[0][1][0][1].debug_meta).toEqual({ images: [{ type: "sourcemap", code_file: "dist/index.js", debug_id: debugId }] });
  expect(JSON.stringify(result)).not.toContain('"function"');
}, 60000);
