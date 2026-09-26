// Isolated real Electron + real Sentry SDK, with an in-memory transport.
// Injects a child exit and a synthetic native event; never crashes the machine
// or sends an event to Sentry. Run from the inspector package directory.
const { mkdtempSync, writeFileSync, rmSync, symlinkSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildSync } = require("esbuild");
const directory = mkdtempSync(path.join(tmpdir(), "mcpjam-diagnostics-smoke-"));
const root = path.resolve(__dirname, "..");
try {
  symlinkSync(
    path.join(root, "../node_modules"),
    path.join(directory, "node_modules"),
    "dir",
  );
  for (const [entry, output] of [
    ["desktop-diagnostics-electron.ts", "diagnostics.cjs"],
    ["preload.ts", "preload.cjs"],
  ]) {
    buildSync({
      entryPoints: [path.join(root, "src", entry)],
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron", "@sentry/electron/main"],
      outfile: path.join(directory, output),
    });
  }
  writeFileSync(
    path.join(directory, "main.cjs"),
    `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const Sentry = require('@sentry/electron/main');
app.setPath('userData', path.join(__dirname, 'profile'));
const events = [];
Sentry.init({ dsn: 'https://public@example.invalid/1', defaultIntegrations: false,
  environment: 'test', release: 'diagnostic-smoke', transport: () => ({
    send: async envelope => { for (const [header, payload] of envelope[1]) if(header.type === 'event') events.push(payload); return { statusCode: 200 }; },
    flush: async () => true
  }) });
const { installDesktopDiagnostics } = require('./diagnostics.cjs');
const diagnostics = installDesktopDiagnostics();
(async () => {
  await app.whenReady();
  const server = http.createServer((_req, res) => res.end('<html><body>Internal smoke</body></html>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true } });
  diagnostics.bind(window, url);
  await window.loadURL(url);
  await window.webContents.executeJavaScript('window.electronAPI.diagnostics.record({kind:"auth",phase:"state",auth:"signed_in",version:"1.2.3"})');
  await new Promise(resolve => setTimeout(resolve, 50));
  const details = {type:'Utility',serviceName:'proxy_resolver.mojom.ProxyResolverFactory',reason:'killed',exitCode:9};
  app.emit('child-process-gone', {}, details);
  const nativeId = Sentry.captureEvent({ platform:'native', message:'Synthetic native event', contexts: {electron:{details}} });
  await Sentry.flush(1000);
  await window.webContents.executeJavaScript('window.electronAPI.diagnostics.record({kind:"connect",phase:"success"})');
  await new Promise(resolve => setTimeout(resolve, 50));
  app.emit('will-quit');
  await Sentry.flush(1000);
  const native = events.find(e => e.event_id === nativeId);
  const summary = events.find(e => e.message === 'Desktop proxy process observation');
  assert.equal(native.contexts.desktop_diagnostics.auth, 'signed_in');
  assert.ok(native.contexts.desktop_diagnostics.activity.some(x => x.kind === 'auth'));
  assert.ok(summary.contexts.desktop_diagnostics.after.some(x => x.kind === 'connect'));
  assert.equal(native.contexts.desktop_diagnostics.observation_event_id, summary.event_id);
  assert.equal(summary.contexts.desktop_diagnostics.outcome, 'connection_succeeded_afterward');
  assert.deepEqual(summary.contexts.desktop_diagnostics.native_event_ids, [nativeId]);
  assert.equal(summary.tags.desktop_run_id, native.tags.desktop_run_id);
  assert.equal(summary.contexts.desktop_diagnostics.observation, 'interrupted');
  assert.equal(summary.user, undefined);
  process.stdout.write('PASS: real preload IPC, native context, linked follow-up, isolated transport\\n');
  server.close(); window.destroy(); app.exit(0);
})().catch(error => { process.stderr.write(String(error.stack)+'\\n'); app.exit(1); });
`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(
    require("electron"),
    [path.join(directory, "main.cjs")],
    { env, stdio: "inherit", timeout: 20000 },
  );
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
