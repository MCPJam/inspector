import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const appDirectory = fileURLToPath(new URL("../", import.meta.url));
let app;
let origin;
let provider;
let providerRequests = 0;
let output = "";

function appEnv(port) {
  return {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    WORKOS_API_KEY: "sk_test_synthetic_not_a_real_key",
    WORKOS_CLIENT_ID: "client_synthetic",
    WORKOS_COOKIE_PASSWORD: "synthetic-cookie-password-at-least-32-characters",
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: `http://127.0.0.1:${port}/callback`,
    WORKOS_API_HOSTNAME: "127.0.0.1",
    WORKOS_API_PORT: String(provider.address().port),
    WORKOS_API_HTTPS: "false",
    MCPJAM_NONPROD_LOCKDOWN: "true",
    MCPJAM_EMPLOYEE_EMAIL_DOMAINS: "example.invalid",
  };
}

before(async () => {
  provider = createServer((_request, response) => {
    providerRequests++;
    response.writeHead(503).end();
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  // Production build + `next start`, not `next dev`: the dev server marks every
  // response no-store on its own, which would make the cache assertions pass
  // whatever the middleware does. `NEXT_PUBLIC_*` values are inlined at build
  // time, so the port is chosen before the build.
  const next = require.resolve("next/dist/bin/next");
  const build = spawnSync(process.execPath, [next, "build"], { cwd: appDirectory, env: appEnv(port), encoding: "utf8" });
  assert.equal(build.status, 0, `next build failed:\n${build.stdout}\n${build.stderr}`);
  app = spawn(process.execPath, [next, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: appDirectory,
    env: appEnv(port),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Next startup timed out: ${output}`)), 30000);
    for (const stream of [app.stdout, app.stderr]) stream.on("data", (data) => {
      output += data.toString();
      if (output.includes("Ready in")) { clearTimeout(timer); resolve(); }
    });
    app.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Next exited ${code}: ${output}`)); });
  });
  await ready;
});

after(async () => {
  if (app && app.exitCode === null) { const exited = once(app, "exit"); app.kill("SIGTERM"); await exited; }
  if (provider) await new Promise((resolve) => provider.close(resolve));
});

function assertPrivate(response) {
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
}

for (const [path, method] of [["/", "GET"], ["/api/release/dispatch", "POST"]]) {
  test(`anonymous ${method} ${path} requires sign-in`, async () => {
    const response = await fetch(`${origin}${path}`, { method, redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(response.status, method === "POST" ? 303 : 307, output);
    const location = new URL(response.headers.get("location"));
    assert.equal(location.pathname, "/user_management/authorize");
    assert.equal(location.searchParams.get("client_id"), "client_synthetic");
    assert.equal(location.searchParams.get("redirect_uri"), `${origin}/callback`);
    assert.ok(location.searchParams.get("state"));
    assert.match(response.headers.get("set-cookie") ?? "", /wos-auth-verifier/);
    assertPrivate(response);
    assert.equal(providerRequests, 0);
  });
}

test("callback without matching sign-in state is rejected locally", async () => {
  const response = await fetch(`${origin}/callback?code=synthetic&state=unmatched`, { redirect: "manual" });
  assert.ok(response.status >= 400 && response.status < 600, output);
  assertPrivate(response);
  assert.equal(providerRequests, 0);
  assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /wos-session=[^;]/);
});
