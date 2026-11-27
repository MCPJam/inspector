import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fetchNegotiatesHttp2, http1Fetch } from "../src/http1-fetch.js";
import { normalizeMCPConformanceConfig } from "../src/mcp-conformance/validation.js";
import { normalizeOAuthConformanceConfig } from "../src/oauth-conformance/validation.js";
import { mintTestCertificate } from "./support/events-tls.js";

const SDK = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHILD_SOURCE = join(SDK, "tests/support/http2-abort-child.ts");

describe("fetchNegotiatesHttp2", () => {
  it("is true only for Node's fetch on undici 8 or later", () => {
    expect(fetchNegotiatesHttp2({ node: "26.13.1", undici: "8.12.4" })).toBe(
      true
    );
    expect(fetchNegotiatesHttp2({ node: "24.22.1", undici: "7.30.1" })).toBe(
      false
    );
    expect(fetchNegotiatesHttp2({ node: "18.0.0" })).toBe(false);
    expect(
      fetchNegotiatesHttp2({ node: "24.3.0", bun: "1.4.2", undici: "8.0.0" })
    ).toBe(false);
  });
});

describe("http1Fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("leaves a caller's own dispatcher alone", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const init = { method: "POST", dispatcher: { dispatch: () => true } };

    await http1Fetch("https://example.test/mcp", init);

    expect(fetchMock).toHaveBeenCalledWith("https://example.test/mcp", init);
  });

  it.skipIf(fetchNegotiatesHttp2())(
    "is the built-in fetch, untouched, where fetch speaks HTTP/1.1",
    async () => {
      const fetchMock = vi.fn(async () => new Response("ok"));
      vi.stubGlobal("fetch", fetchMock);
      const init = { method: "POST" };

      await http1Fetch("https://example.test/mcp", init);

      expect(fetchMock).toHaveBeenCalledWith("https://example.test/mcp", init);
    }
  );

  it.runIf(fetchNegotiatesHttp2())(
    "adds an HTTP/1.1-only dispatcher where fetch negotiates HTTP/2",
    async () => {
      const fetchMock = vi.fn(async () => new Response("ok"));
      vi.stubGlobal("fetch", fetchMock);

      await http1Fetch("https://example.test/mcp", { method: "POST" });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.test/mcp",
        expect.objectContaining({
          method: "POST",
          dispatcher: expect.objectContaining({
            dispatch: expect.any(Function),
          }),
        })
      );
    }
  );
});

describe("conformance suites default to http1Fetch", () => {
  it("in the protocol suite, and keep a caller's own fetch", () => {
    const callerFetch: typeof fetch = async () => new Response("ok");
    expect(
      normalizeMCPConformanceConfig({ serverUrl: "https://example.test/mcp" })
        .fetchFn
    ).toBe(http1Fetch);
    expect(
      normalizeMCPConformanceConfig({
        serverUrl: "https://example.test/mcp",
        fetchFn: callerFetch,
      }).fetchFn
    ).toBe(callerFetch);
  });

  it("in the OAuth suite", () => {
    expect(
      normalizeOAuthConformanceConfig({
        serverUrl: "https://example.test/mcp",
        protocolVersion: "2025-11-25",
        registrationStrategy: "dcr",
      }).fetchFn
    ).toBe(http1Fetch);
  });
});

// The crash itself (CQT-216): on Node 26, an HTTP/2 request aborted in the
// same tick it starts takes the process down about four seconds later. Each
// case runs in a child process, so a crash is an exit code, not a dead worker.
describe.runIf(fetchNegotiatesHttp2())(
  "against an HTTP/2 server, where fetch negotiates HTTP/2",
  () => {
    let dir: string;
    let caFile: string;
    let child: string;
    let certificate: ReturnType<typeof mintTestCertificate>;

    // The child is bundled from source the way the published build is (the
    // SDK imports `.md` as text), inside the package so its dependencies
    // resolve, then run with plain Node.
    beforeAll(async () => {
      certificate = mintTestCertificate();
      dir = mkdtempSync(join(SDK, ".http1-fetch-"));
      caFile = join(dir, "cert.pem");
      writeFileSync(caFile, certificate.cert);
      child = join(dir, "child.mjs");
      await build({
        entryPoints: [CHILD_SOURCE],
        outfile: child,
        bundle: true,
        format: "esm",
        platform: "node",
        packages: "external",
        loader: { ".md": "text" },
        define: { __MCPJAM_SDK_VERSION__: '"0.0.0-test"' },
        logLevel: "silent",
      });
    }, 60_000);

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    /**
     * Answers just enough JSON-RPC to be dialled as an MCP server at `/mcp`
     * (and plain `ok` elsewhere), recording each request's path and version.
     */
    async function startServer() {
      const seen: Array<{ path: string; version: string }> = [];
      const server = http2.createSecureServer(
        { ...certificate, allowHTTP1: true },
        (request, response) => {
          seen.push({ path: request.url, version: request.httpVersion });
          if (!request.url.startsWith("/mcp")) {
            response.end("ok");
            return;
          }
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" }).end();
            return;
          }
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            body += chunk;
          });
          request.on("end", () => {
            const message = JSON.parse(body || "{}");
            if (message.id === undefined) {
              response.writeHead(202).end();
              return;
            }
            const result =
              message.method === "initialize"
                ? {
                    protocolVersion: message.params?.protocolVersion,
                    capabilities: {},
                    serverInfo: { name: "http2-test", version: "0.0.0" },
                  }
                : {};
            response
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
          });
        }
      );
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve)
      );
      const port = (server.address() as AddressInfo).port;
      return {
        origin: `https://127.0.0.1:${port}`,
        versionsFor: (prefix: string) =>
          seen
            .filter(({ path }) => path.startsWith(prefix))
            .map(({ version }) => version),
        close: () => new Promise((resolve) => server.close(resolve)),
      };
    }

    function runChild(
      origin: string,
      mode: "plain" | "http1Fetch" | "runConformance" | "oauthAuto"
    ): Promise<{ code: number | null; stderr: string }> {
      const childProcess = spawn(process.execPath, [child, origin, mode], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: caFile },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      childProcess.stderr.setEncoding("utf8");
      childProcess.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      return new Promise((resolve, reject) => {
        childProcess.on("error", reject);
        childProcess.on("close", (code) => resolve({ code, stderr }));
      });
    }

    it("plain fetch negotiates HTTP/2 with it, the crash's precondition", async () => {
      const server = await startServer();
      try {
        const { code, stderr } = await runChild(server.origin, "plain");

        expect(stderr).toBe("");
        expect(code).toBe(0);
        expect(server.versionsFor("/plain")).toEqual(["2.0"]);
      } finally {
        await server.close();
      }
    });

    it("http1Fetch keeps HTTP/1.1 and survives an instant abort, without changing the process's other fetches", async () => {
      const server = await startServer();
      try {
        const { code, stderr } = await runChild(server.origin, "http1Fetch");

        expect(stderr).not.toContain("socket idle timeout");
        expect(code).toBe(0);
        expect(new Set(server.versionsFor("/http1"))).toEqual(new Set(["1.1"]));
        expect(server.versionsFor("/global")).toEqual(["2.0"]);
      } finally {
        await server.close();
      }
    }, 20_000);

    it("the CLI's runConformance dials HTTP/1.1 throughout and survives", async () => {
      const server = await startServer();
      try {
        const { code, stderr } = await runChild(
          server.origin,
          "runConformance"
        );
        const versions = server.versionsFor("/");

        expect(stderr).not.toContain("socket idle timeout");
        expect(code).toBe(0);
        expect(versions.length).toBeGreaterThan(0);
        expect(new Set(versions)).toEqual(new Set(["1.1"]));
      } finally {
        await server.close();
      }
    }, 60_000);

    it("the OAuth suite's automatic registration probe dials HTTP/1.1 too", async () => {
      const server = await startServer();
      try {
        const { code, stderr } = await runChild(server.origin, "oauthAuto");
        const probes = server.versionsFor("/mcp");

        expect(stderr).not.toContain("socket idle timeout");
        expect(code).toBe(0);
        expect(probes.length).toBeGreaterThan(0);
        expect(new Set(server.versionsFor("/"))).toEqual(new Set(["1.1"]));
      } finally {
        await server.close();
      }
    }, 60_000);
  }
);
