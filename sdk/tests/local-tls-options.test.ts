import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { localTlsOptions } from "../src/oauth/local-tls-options.js";
import { executeDebugOAuthProxy, fetchOAuthMetadata } from "../src/oauth-proxy.js";
import { createPinnedStreamingFetch } from "../src/oauth/pinned-stream-fetch.js";

const store = tls as typeof tls & {
  getCACertificates?: (type: "default" | "system") => string[];
};
const originalReader = store.getCACertificates;
const defaults = originalReader?.("default") ?? [...tls.rootCertificates];
let directory: string;
let cert: string;
let origin: string;
let server: https.Server;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "mcpjam-tls-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"),
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
  ], { stdio: "ignore" });
  cert = readFileSync(join(directory, "cert.pem"), "utf8");
  server = https.createServer({
    key: readFileSync(join(directory, "key.pem")), cert,
  }, (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ issuer: "https://localhost" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", resolve);
  });
  origin = `https://localhost:${(server.address() as AddressInfo).port}`;
});

afterEach(() => { store.getCACertificates = originalReader; });
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function trustTestCa() {
  store.getCACertificates = vi.fn((type) => type === "system" ? [cert] : defaults);
}

describe("local system CA trust", () => {
  it("combines default and system roots without changing verification", () => {
    trustTestCa();
    expect(localTlsOptions(new URL(origin), true)).toEqual({ ca: [...new Set([...defaults, cert])] });
  });

  it("leaves hosted, HTTP, and older Node runtimes on their default trust", () => {
    trustTestCa();
    expect(localTlsOptions(new URL(origin), false)).toEqual({});
    expect(localTlsOptions(new URL("http://localhost"), true)).toEqual({});
    expect(store.getCACertificates).not.toHaveBeenCalled();
    store.getCACertificates = undefined;
    expect(localTlsOptions(new URL(origin), true)).toEqual({});
  });

  it("fetches debug metadata, discovery metadata, and MCP streams using a system CA", async () => {
    trustTestCa();
    const debug = await executeDebugOAuthProxy({ url: origin, allowPrivateNetwork: true });
    expect(debug.status).toBe(200);
    const metadata = await fetchOAuthMetadata(origin, { allowPrivateNetwork: true });
    expect(metadata).toMatchObject({ metadata: { issuer: "https://localhost" } });
    const response = await createPinnedStreamingFetch({ allowPrivateNetwork: true })(origin);
    expect(await response.json()).toEqual({ issuer: "https://localhost" });
  });

  it("still rejects an untrusted certificate", async () => {
    store.getCACertificates = (type) => type === "system" ? [] : defaults;
    await expect(executeDebugOAuthProxy({ url: origin, allowPrivateNetwork: true }))
      .rejects.toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
  });

  it("still verifies the hostname even with a trusted CA", async () => {
    trustTestCa();
    const { address } = server.address() as AddressInfo;
    const host = address.includes(":") ? `[${address}]` : address;
    await expect(executeDebugOAuthProxy({
      url: origin.replace("localhost", host), allowPrivateNetwork: true,
    })).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });
});
