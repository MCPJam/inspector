/**
 * The plan's acceptance tests that need real networking: a download cut off
 * mid-stream over HTTP, and an install through a CONNECT proxy to an HTTPS
 * origin whose certificate only a custom CA vouches for.
 *
 * (The other failure paths — disk, probe, crash during activation, rollback,
 * revocation, two Inspector versions, GC under a running session — are in
 * `runtime-updates.test.ts`; pre-provisioning, doctor and repair in
 * `runtime-supportability.test.ts`.)
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create as createTar } from "tar";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as packDigests from "../pack-digests.generated.js";
import {
  installRuntimePack,
  packPlatformKey,
  readRuntimeInstallStatus,
  resetRuntimeInstallStateForTests,
  setPackSigningKeysForTests,
} from "../runtime-install.js";
import { packAssetStem } from "../pack-naming.js";
import { computeTreeDigest } from "../runtime-identity.js";
import { setRuntimeProbeForTests } from "../runtime-probe.js";
import { setRuntimeMetricsSinkForTests } from "../runtime-metrics.js";
import { localPackTarget } from "../targets.js";

const TARGET = localPackTarget()!;
const OLD = "3.0.0";
const NEW = "3.0.1";
const keys = generateKeyPairSync("ed25519");
const testKey = { keyId: "test", publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString() };

let base: string;
let runtimeRoot: string;
const files = new Map<string, Buffer>(); // asset name → bytes served
const digests: Record<string, string> = {};
let server: Server;
let cutAfterBytes: number | null = null;
let served: string[] = [];

async function buildRelease(version: string): Promise<void> {
  const staging = await mkdtemp(join(base, `stage-${version}-`));
  const root = join(staging, "claude-code");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "bin", "node"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "bin", "node"), 0o755);
  // Incompressible bytes, so the archive is large enough that a cut-off at a
  // few kilobytes is genuinely mid-stream.
  await writeFile(join(root, "vendor.bin"), randomBytes(256 * 1024));
  digests[version] = await computeTreeDigest(root);
  const stem = packAssetStem("claude-code", packPlatformKey(), version);
  const archive = join(staging, "pack.tar.gz");
  await createTar({ file: archive, gzip: true, cwd: resolve(staging), portable: false }, ["claude-code"]);
  const archiveBytes = readFileSync(archive);
  const manifest = Buffer.from(
    JSON.stringify({
      schema: "mcpjam.local-harness-pack/1",
      harnessId: "claude-code",
      packVersion: version,
      adapterVersion: "test",
      platform: packPlatformKey(),
      nodeVersion: "24",
      treeDigest: digests[version],
      files: 2,
      bytes: archiveBytes.length * 4,
      archive: { name: `${stem}.tar.gz`, sha256: createHash("sha256").update(archiveBytes).digest("hex") },
    }),
  );
  files.set(`${stem}.tar.gz`, archiveBytes);
  files.set(`${stem}.manifest.json`, manifest);
  files.set(`${stem}.manifest.json.sig`, Buffer.from(sign(null, manifest, keys.privateKey).toString("base64")));
  await rm(staging, { recursive: true, force: true });
}

function pin(desired: string, permitted?: string): void {
  const ref = (version: string) => ({ packVersion: version, treeDigest: digests[version]! });
  vi.spyOn(packDigests, "PACK_RECORDS", "get").mockReturnValue({
    "claude-code": { [TARGET]: ref(desired) },
    codex: {},
  } as typeof packDigests.PACK_RECORDS);
  vi.spyOn(packDigests, "PERMITTED_PACK_RECORDS", "get").mockReturnValue({
    "claude-code": permitted ? { [TARGET]: ref(permitted) } : {},
    codex: {},
  } as typeof packDigests.PERMITTED_PACK_RECORDS);
}

function serveVersion(version: string): void {
  const port = (server.address() as { port: number }).port;
  process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE = `http://127.0.0.1:${port}/${packAssetStem("claude-code", packPlatformKey(), version)}.tar.gz`;
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-acceptance-")));
  await buildRelease(OLD);
  await buildRelease(NEW);
  server = createHttpServer((req, res) => {
    const name = (req.url ?? "").slice(1);
    served.push(name);
    const bytes = files.get(name);
    if (bytes === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-length": String(bytes.length) });
    if (cutAfterBytes !== null && name.endsWith(".tar.gz")) {
      // The connection dies mid-download, as a laptop lid or a flaky Wi-Fi does.
      res.write(bytes.subarray(0, cutAfterBytes), () => res.socket?.destroy());
      return;
    }
    res.end(bytes);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  setPackSigningKeysForTests([testKey]);
  setRuntimeProbeForTests(async () => ({ ok: true, node: "v24", vendorVersion: "2" }));
  setRuntimeMetricsSinkForTests(() => {});
});

beforeEach(() => {
  runtimeRoot = join(base, `runtime-${Math.random().toString(36).slice(2)}`);
  process.env.MCPJAM_RUNTIME_ROOT = runtimeRoot;
  cutAfterBytes = null;
  served = [];
});

afterEach(async () => {
  resetRuntimeInstallStateForTests();
  vi.restoreAllMocks();
  await new Promise((r) => setTimeout(r, 20));
  await rm(runtimeRoot, { recursive: true, force: true });
});

afterAll(async () => {
  delete process.env.MCPJAM_RUNTIME_ROOT;
  delete process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE;
  setPackSigningKeysForTests(null);
  setRuntimeProbeForTests(null);
  setRuntimeMetricsSinkForTests(null);
  server.closeAllConnections?.();
  await new Promise((r) => server.close(() => r(undefined)));
  await rm(base, { recursive: true, force: true });
});

describe("a download interrupted mid-way", () => {
  it("leaves the active runtime usable, and a clean retry follows", async () => {
    pin(OLD);
    serveVersion(OLD);
    expect((await installRuntimePack({ harnessId: "claude-code", trigger: "cli" })).state).toBe("ready");
    expect(served.some((name) => name.endsWith(".manifest.json.sig"))).toBe(true);

    pin(NEW, OLD);
    serveVersion(NEW);
    cutAfterBytes = 4096;
    const interrupted = await installRuntimePack({ harnessId: "claude-code", trigger: "gesture" });
    expect(interrupted).toMatchObject({ state: "failed", stage: "download" });
    // The machine keeps working on what it had…
    expect(await readRuntimeInstallStatus({ harnessId: "claude-code" })).toMatchObject({
      state: "ready",
      role: "permitted",
      packVersion: OLD,
    });
    // …nothing half-written is left to collide with the retry…
    const installRoot = join(runtimeRoot, TARGET);
    expect((await readdir(installRoot)).filter((name) => name.startsWith(".mcpjam-tmp-") || name === NEW)).toEqual([]);
    // …and the retry is an ordinary install.
    cutAfterBytes = null;
    expect((await installRuntimePack({ harnessId: "claude-code", trigger: "gesture" })).state).toBe("ready");
    expect(await readRuntimeInstallStatus({ harnessId: "claude-code" })).toMatchObject({ role: "desired", packVersion: NEW });
  });
});

const OPENSSL = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!OPENSSL || process.platform === "win32")("behind a proxy with a custom CA", () => {
  it("installs over HTTPS through a CONNECT proxy, trusting the CA from NODE_EXTRA_CA_CERTS", async () => {
    // A private CA and a certificate for `packs.corp.test` it signed.
    const pki = join(base, "pki");
    await mkdir(pki, { recursive: true });
    const run = (args: string[]) => execFileSync("openssl", args, { cwd: pki, stdio: "pipe" });
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=Corp Test Root"]);
    run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "site.key", "-out", "site.csr", "-subj", "/CN=packs.corp.test"]);
    await writeFile(join(pki, "san.ext"), "subjectAltName=DNS:packs.corp.test\n");
    run(["x509", "-req", "-in", "site.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "site.pem", "-days", "1", "-extfile", "san.ext"]);

    // The HTTPS origin serving the release, and a CONNECT proxy in front of it
    // that sends every tunnel there whatever host it names.
    const origin = createHttpsServer(
      { key: readFileSync(join(pki, "site.key")), cert: readFileSync(join(pki, "site.pem")) },
      (req, res) => {
        const bytes = files.get((req.url ?? "").slice(1));
        if (bytes === undefined) res.writeHead(404).end();
        else res.writeHead(200, { "content-length": String(bytes.length) }).end(bytes);
      },
    );
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", () => r()));
    const tunnels: string[] = [];
    const proxy = createHttpServer((_req, res) => res.writeHead(405).end());
    proxy.on("connect", (req, client: import("node:net").Socket, head: Buffer) => {
      tunnels.push(req.url ?? "");
      const upstream = connect((origin.address() as { port: number }).port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));

    try {
      // NODE_EXTRA_CA_CERTS is read once, at process start — so the install
      // runs in a fresh process, exactly as an Inspector started with it would.
      const stem = packAssetStem("claude-code", packPlatformKey(), NEW);
      const here = dirname(fileURLToPath(import.meta.url));
      const script = join(base, "install-through-proxy.mts");
      const fromHere = (relative: string) => JSON.stringify(resolve(here, relative));
      await writeFile(
        script,
        `
        import { installRuntimePack, setPackSigningKeysForTests } from ${fromHere("../runtime-install.ts")};
        import { setRuntimeProbeForTests } from ${fromHere("../runtime-probe.ts")};
        setPackSigningKeysForTests([${JSON.stringify(testKey)}]);
        setRuntimeProbeForTests(async () => ({ ok: true, node: "v24", vendorVersion: "2" }));
        const result = await installRuntimePack({ harnessId: "claude-code", trigger: "cli" });
        console.log("RESULT " + JSON.stringify(result));
        `,
      );
      const child = spawn(process.execPath, ["--import", "tsx", script], {
        cwd: resolve(here, "../../../../.."),
        env: {
          ...process.env,
          MCPJAM_RUNTIME_ROOT: runtimeRoot,
          MCPJAM_LOCAL_HARNESS_PACK_SOURCE: `https://packs.corp.test/${stem}.tar.gz`,
          // The pack this "build" pins (the documented development override,
          // honoured only beside a pack source). The source is a URL, so the
          // signed manifest is still required and verified.
          MCPJAM_LOCAL_HARNESS_EXPECTED_PACK: `${NEW}:${digests[NEW]}`,
          HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
          https_proxy: "",
          HTTP_PROXY: "",
          http_proxy: "",
          NO_PROXY: "",
          no_proxy: "",
          NODE_EXTRA_CA_CERTS: join(pki, "ca.pem"),
          VITEST: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      const code = await new Promise<number | null>((r) => child.on("exit", r));
      const line = out.split("\n").find((l) => l.startsWith("RESULT "));
      expect(line, `exit ${code}\n${out}\n${err}`).toBeDefined();
      expect(JSON.parse(line!.slice(7)), out).toMatchObject({ state: "ready", packVersion: NEW });
      expect(tunnels).toContain("packs.corp.test:443");
    } finally {
      proxy.closeAllConnections?.();
      origin.closeAllConnections?.();
      await new Promise((r) => proxy.close(() => r(undefined)));
      await new Promise((r) => origin.close(() => r(undefined)));
    }
  }, 60_000);
});
