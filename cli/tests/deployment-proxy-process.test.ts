/**
 * The corporate proxy, proved on the real CLI process: an HTTPS MCPJam server
 * at `mcpjam.acme.test` and an npm registry stand-in, both reachable only
 * through a CONNECT proxy, with a private CA trusted through
 * NODE_EXTRA_CA_CERTS. The network guard allows the proxy and the loopback
 * fixtures only, so any direct connection fails the test.
 *
 * MCPJAM_TEST_NODE runs the CLI under another Node binary (this file reads it,
 * the product never does), for the oldest supported release.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  blockedAttempts,
  CLI_ENTRY,
  createSandbox,
  json,
  readAttempts,
  runGuarded,
  startRecorder,
  type Recorder,
  type Sandbox,
} from "./support/deployment-fixtures.js";
import { nodeHonorsEnvProxy } from "../src/lib/network-proxy.js";

const NODE = process.env.MCPJAM_TEST_NODE || process.execPath;
const NODE_VERSION = execFileSync(NODE, ["-p", "process.versions.node"], {
  encoding: "utf8",
}).trim();
const ME = { id: "user_acme", email: "dev@acme.test", name: "Dev" };

const OPENSSL = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let pki: string;
let origin: Server;
let proxy: Server;
let proxyPort: number;
/** What the proxy was asked for: `CONNECT host:port`, or `GET url` for plain HTTP. */
const proxied: string[] = [];
let local: Recorder;
let alias: Recorder;
let sandbox: Sandbox;

function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, host, () => resolve((server.address() as { port: number }).port)),
  );
}

before(async () => {
  if (!OPENSSL) return;
  // A private CA and one certificate for both hosts the proxy tunnels to.
  pki = mkdtempSync(path.join(os.tmpdir(), "mcpjam-proxy-pki-"));
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: pki, stdio: "pipe" });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=Acme Test Root"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "site.key", "-out", "site.csr", "-subj", "/CN=mcpjam.acme.test"]);
  writeFileSync(path.join(pki, "san.ext"), "subjectAltName=DNS:mcpjam.acme.test,DNS:registry.npmjs.org\n");
  run(["x509", "-req", "-in", "site.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "site.pem", "-days", "1", "-extfile", "san.ext"]);

  origin = createHttpsServer(
    { key: readFileSync(path.join(pki, "site.key")), cert: readFileSync(path.join(pki, "site.pem")) },
    (request, response) => {
      if (request.headers.host?.replace(/:\d+$/, "") === "registry.npmjs.org") {
        return json(response, 200, { version: "99.0.0" });
      }
      if (request.url === "/api/v1/me") return json(response, 200, ME);
      return json(response, 404, { code: "NOT_FOUND", message: "No fixture" });
    },
  );
  const originPort = await listen(origin);

  // Sends every tunnel to the origin, whatever host it names, and refuses
  // plain proxied HTTP: nothing in these tests should need it.
  proxy = createHttpServer((request, response) => {
    proxied.push(`${request.method} ${request.url}`);
    response.writeHead(405).end();
  });
  proxy.on("connect", (request, client: Socket, head: Buffer) => {
    proxied.push(`CONNECT ${request.url}`);
    const upstream = connect(originPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  proxyPort = await listen(proxy);

  local = await startRecorder({ "GET /api/v1/me": (_request, response) => json(response, 200, ME) });
  // A loopback address outside the CLI's built-in direct list, so only
  // NO_PROXY can send it direct.
  alias = await startRecorder({ "GET /api/v1/me": (_request, response) => json(response, 200, ME) }, "127.0.0.2");
});

after(async () => {
  if (!OPENSSL) return;
  proxy.closeAllConnections();
  origin.closeAllConnections();
  await Promise.all([
    new Promise((resolve) => proxy.close(resolve)),
    new Promise((resolve) => origin.close(resolve)),
    local.close(),
    alias.close(),
  ]);
});

function cli(args: string[], env: Record<string, string>) {
  return runGuarded(CLI_ENTRY, args, {
    sandbox,
    node: NODE,
    allow: [proxyPort, local.port, alias.port],
    env: {
      MCPJAM_TELEMETRY_DISABLED: "1",
      NODE_EXTRA_CA_CERTS: path.join(pki, "ca.pem"),
      ...env,
    },
  });
}

async function scenario(run: () => Promise<void>): Promise<void> {
  proxied.length = 0;
  local.requests.length = 0;
  alias.requests.length = 0;
  sandbox = await createSandbox();
  try {
    await run();
  } finally {
    await sandbox.remove();
  }
}

test(`through the proxy on Node ${NODE_VERSION}: the API and the update check tunnel, nothing goes direct`, { skip: !OPENSSL }, () =>
  scenario(async () => {
    const run = await cli(
      ["cloud", "whoami", "--api-url", "https://mcpjam.acme.test/api/v1", "--api-key", "sk_acme", "--format", "json"],
      // The empty lowercase spelling must not switch the proxy off.
      { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, https_proxy: "" },
    );
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).email, ME.email);
    assert.ok(proxied.includes("CONNECT mcpjam.acme.test:443"), proxied.join("\n"));

    if (nodeHonorsEnvProxy(NODE_VERSION)) {
      const deadline = Date.now() + 10_000;
      while (!proxied.includes("CONNECT registry.npmjs.org:443") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(proxied.includes("CONNECT registry.npmjs.org:443"), proxied.join("\n"));
    } else {
      // This Node cannot route `https` through the proxy, so the check is
      // skipped rather than sent direct.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.ok(
        !(await readAttempts(sandbox)).some((attempt) => attempt.kind === "spawn"),
        "the update check started on a Node that cannot use the proxy",
      );
    }
    assert.deepEqual(await blockedAttempts(sandbox), []);
  }));

test(`loopback and NO_PROXY connect directly on Node ${NODE_VERSION}`, { skip: !OPENSSL }, () =>
  scenario(async () => {
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    const env = {
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      MCPJAM_NO_UPDATE_CHECK: "1",
    };
    const loopback = await cli(["cloud", "whoami", "--api-url", `${local.url}/api/v1`, "--api-key", "sk_acme"], env);
    assert.equal(loopback.exitCode, 0, loopback.stderr);
    assert.deepEqual(local.requests.map((request) => request.path), ["/api/v1/me"]);

    const listed = await cli(
      ["cloud", "whoami", "--api-url", `${alias.url}/api/v1`, "--api-key", "sk_acme"],
      { ...env, NO_PROXY: "127.0.0.2" },
    );
    assert.equal(listed.exitCode, 0, listed.stderr);
    assert.deepEqual(alias.requests.map((request) => request.path), ["/api/v1/me"]);

    assert.deepEqual(proxied, [], "a direct destination went through the proxy");
    assert.deepEqual(await blockedAttempts(sandbox), []);
  }));

test(`an address outside NO_PROXY goes through the proxy on Node ${NODE_VERSION}`, { skip: !OPENSSL }, () =>
  scenario(async () => {
    // The control for the test above: without NO_PROXY, 127.0.0.2 is proxied.
    const run = await cli(["cloud", "whoami", "--api-url", `${alias.url}/api/v1`, "--api-key", "sk_acme"], {
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      MCPJAM_NO_UPDATE_CHECK: "1",
    });
    assert.notEqual(run.exitCode, 0);
    assert.deepEqual(alias.requests, []);
    assert.ok(proxied.some((entry) => entry.includes("127.0.0.2")), proxied.join("\n"));
  }));
