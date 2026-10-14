import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let directory: string;
beforeAll(() => { directory = mkdtempSync(join(sdk, ".telemetry-test-")); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it("keeps real packaged constructor file/line locations without shipping function labels or customer paths", async () => {
  const entry = join(directory, "entry.ts");
  const packageRoot = join(directory, "node_modules/@mcpjam/sdk");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@mcpjam/sdk", type: "module" }));
  const bundle = join(packageRoot, "dist/index.js");
  writeFileSync(entry, 'export { EvalTest } from "../src/index.ts"; export { sdkDiagnosticBoundary } from "../src/internal/sentry-boundary.ts";');
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "esm", platform: "node", packages: "external", loader: { ".md": "text" }, define: { __MCPJAM_SDK_VERSION__: '"1.2.3"' } });
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { EvalTest, sdkDiagnosticBoundary } from ${JSON.stringify(pathToFileURL(bundle).href)};
    import { defaultStackParser } from '@sentry/node';
    let frames;
    try { new EvalTest({ id: 'synthetic-case', name: 'synthetic' }); }
    catch (error) { frames = defaultStackParser(error.stack).filter(f => f.filename === ${JSON.stringify(bundle)}); }
    const sent = [];
    const transport = sdkDiagnosticBoundary('@mcpjam/sdk@1.2.3')({ send: async envelope => { sent.push(envelope); return {}; }, flush: async () => true });
    const raw = { exception: { values: [{ type: 'Error', value: 'PRIVATE_SENTINEL', stacktrace: { frames: [
      ...frames.map(frame => ({ ...frame, function: 'PRIVATE_SENTINEL', pre_context: ['PRIVATE_SENTINEL'] })),
      { filename: '/customer/PRIVATE_SENTINEL/index.mjs', lineno: 10, function: 'PRIVATE_SENTINEL' }
    ] } }] } };
    await transport.send([{}, [[{ type: 'event' }, raw], [{ type: 'attachment' }, 'PRIVATE_SENTINEL']]]);
    process.stdout.write(JSON.stringify({ count: frames.length, sent }));
  `], { encoding: "utf8", env: { ...process.env, DO_NOT_TRACK: "", MCPJAM_TELEMETRY_DISABLED: "" }, timeout: 20000 }));
  expect(result.count).toBeGreaterThan(0);
  const kept = result.sent[0][1][0][1].exception.values[0].stacktrace.frames;
  expect(kept).toHaveLength(result.count);
  expect(kept.every((frame: { filename: string; lineno: number }) => frame.filename === "dist/index.js" && Number.isInteger(frame.lineno))).toBe(true);
  expect(result.sent[0][1]).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  expect(JSON.stringify(result)).not.toContain('"function"');
  const customer = join(directory, "customer-bundle.mjs");
  await build({ entryPoints: [entry], outfile: customer, bundle: true, format: "esm", platform: "node", packages: "external", loader: { ".md": "text" }, define: { __MCPJAM_SDK_VERSION__: '\"1.2.3\"' } });
  const unknown = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { sdkDiagnosticBoundary } from ${JSON.stringify(pathToFileURL(customer).href)};
    const transport = sdkDiagnosticBoundary('@mcpjam/sdk@1.2.3')({ send: async envelope => { process.stdout.write(JSON.stringify(envelope)); return {}; }, flush: async () => true });
    await transport.send([{}, [[{ type: 'event' }, { exception: { values: [{ type: 'Error', stacktrace: { frames: [{ filename: ${JSON.stringify(customer)}, lineno: 1 }, { filename: 'dist/index.js', lineno: 1 }] } }] } }]]]);
  `], { encoding: "utf8", env: { ...process.env, DO_NOT_TRACK: "", MCPJAM_TELEMETRY_DISABLED: "" }, timeout: 20000 });
  expect(unknown).not.toContain('"filename"');
  expect(unknown).toContain('"dropped_frames":2');
}, 30000);

it.each(["import", "require"])("retains owned frames from the actual built package under Node 24 %s", (load) => {
  const packageRoot = join(directory, load, "node_modules/@mcpjam/sdk");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), readFileSync(join(sdk, "package.json")));
  const bundle = join(packageRoot, "dist/index.js");
  // Test-only export exposes the private final transport without replacing any
  // generated runtime code or making a network request.
  writeFileSync(bundle, readFileSync(join(sdk, "dist/index.js"), "utf8") + "\nexport { sdkDiagnosticBoundary as testBoundary };\n");
  const program = `
    const sdk = ${load === "import" ? `await import(${JSON.stringify(pathToFileURL(bundle).href)})` : `require(${JSON.stringify(bundle)})`};
    const sentry = ${load === "import" ? "await import('@sentry/node')" : "require('@sentry/node')"};
    let frames;
    try { new sdk.EvalTest({ id: 'synthetic-case', name: 'synthetic' }); }
    catch (error) { frames = sentry.defaultStackParser(error.stack).filter(f => f.filename === ${JSON.stringify(bundle)}); }
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
  expect(JSON.stringify(result)).not.toContain('"function"');
});
