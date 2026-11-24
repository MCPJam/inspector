import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { mintTestCertificate } from "./support/events-tls.js";

const CHILD = fileURLToPath(
  new URL("./support/http2-abort-child.ts", import.meta.url)
);

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

// The crash itself (CQT-216): on Node 26, an HTTP/2 request aborted in the
// same tick it starts takes the process down about four seconds later. Each
// case runs in a child process, so a crash is an exit code, not a dead worker.
describe.runIf(fetchNegotiatesHttp2())(
  "against an HTTP/2 server, where fetch negotiates HTTP/2",
  () => {
    let server: http2.Http2SecureServer;
    let origin: string;
    let dir: string;
    let caFile: string;
    const seen: Array<{ path: string; version: string }> = [];

    beforeAll(async () => {
      const certificate = mintTestCertificate();
      dir = mkdtempSync(join(tmpdir(), "mcpjam-http1-fetch-"));
      caFile = join(dir, "cert.pem");
      writeFileSync(caFile, certificate.cert);
      server = http2.createSecureServer(
        { ...certificate, allowHTTP1: true },
        (request, response) => {
          seen.push({ path: request.url, version: request.httpVersion });
          response.end("ok");
        }
      );
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve)
      );
      origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    });

    function runChild(
      mode: "plain" | "http1Fetch" | "installed",
      step: "once" | "abort"
    ): Promise<{ code: number | null; stderr: string }> {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", CHILD, `${origin}/${mode}`, mode, step],
        {
          env: { ...process.env, NODE_EXTRA_CA_CERTS: caFile },
          stdio: ["ignore", "ignore", "pipe"],
        }
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stderr }));
      });
    }

    const versionsFor = (mode: string) =>
      seen
        .filter(({ path }) => path === `/${mode}`)
        .map(({ version }) => version);

    it("plain fetch negotiates HTTP/2 with it, the crash's precondition", async () => {
      const { code, stderr } = await runChild("plain", "once");

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(versionsFor("plain")).toEqual(["2.0"]);
    });

    it("http1Fetch keeps HTTP/1.1, and a request aborted as it starts no longer kills the process", async () => {
      const { code, stderr } = await runChild("http1Fetch", "abort");

      expect(stderr).not.toContain("socket idle timeout");
      expect(code).toBe(0);
      expect(new Set(versionsFor("http1Fetch"))).toEqual(new Set(["1.1"]));
    }, 20_000);

    it("installHttp1GlobalDispatcher does the same for every fetch in the process", async () => {
      const { code, stderr } = await runChild("installed", "abort");

      expect(stderr).not.toContain("socket idle timeout");
      expect(code).toBe(0);
      expect(new Set(versionsFor("installed"))).toEqual(new Set(["1.1"]));
    }, 20_000);
  }
);
