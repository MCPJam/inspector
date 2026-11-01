/**
 * `MCPJAM_PRIVATE_EGRESS_ALLOWLIST` through the guard's one decision.
 *
 * The matrix a self-hosted install depends on: a listed range or suffix opens
 * exactly what it names, the metadata floor holds under any entry, every
 * redirect hop is judged again, and a malformed value opens nothing.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import {
  BlockedEgressTargetError,
  admitsPrivateEgress,
  assertAllowedHostedTargetUrl,
  createGuardedFetch,
  hostedPrivateEgressAdmission,
  isBlockedEgressAddress,
  isBlockedEgressHost,
  type EgressHostResolver,
} from "../hosted-egress-guard.js";
import { createStreamingPinnedFetch } from "../pinned-fetch.js";

const ENV = "MCPJAM_PRIVATE_EGRESS_ALLOWLIST";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function allow(value: string) {
  vi.stubEnv(ENV, value);
}

const dnsTable =
  (table: Record<string, string[]>): EgressHostResolver =>
  async (hostname) =>
    table[hostname] ?? [];

async function verdict(
  url: string,
  resolver: EgressHostResolver = dnsTable({}),
): Promise<"allowed" | "blocked"> {
  try {
    await assertAllowedHostedTargetUrl(url, "Server URL", {
      hosted: true,
      resolver,
    });
    return "allowed";
  } catch (error) {
    if (error instanceof BlockedEgressTargetError) return "blocked";
    throw error;
  }
}

describe("an allowlisted range", () => {
  it("opens the private literals it covers, IPv4 and IPv6", async () => {
    allow("10.0.0.0/8,fd00::/8");
    expect(await verdict("http://10.1.2.3:8080/mcp")).toBe("allowed");
    expect(await verdict("http://[fd12::7]/mcp")).toBe("allowed");
    expect(await verdict("http://[::ffff:10.1.2.3]/mcp")).toBe("allowed");
  });

  it("opens a name whose every answer it covers", async () => {
    allow("10.0.0.0/8");
    const resolver = dnsTable({ "models.internal.example": ["10.4.0.9"] });
    expect(await verdict("http://models.internal.example/v1", resolver)).toBe(
      "allowed",
    );
  });

  it("does not open a name with one answer outside it", async () => {
    allow("10.0.0.0/8");
    const resolver = dnsTable({
      "mixed.example": ["10.4.0.9", "192.168.7.7"],
    });
    expect(await verdict("http://mixed.example/mcp", resolver)).toBe("blocked");
  });
});

describe("an allowlisted suffix", () => {
  it("opens names on its label boundary, whatever private address they answer", async () => {
    allow(".svc.cluster.local");
    const resolver = dnsTable({
      "mcp.tools.svc.cluster.local": ["10.96.0.10"],
      "svc.cluster.local": ["172.20.0.1"],
      "ollama.ai.svc.cluster.local": ["fd00:10:96::a"],
    });
    expect(
      await verdict("http://mcp.tools.svc.cluster.local:8080/mcp", resolver),
    ).toBe("allowed");
    expect(await verdict("http://svc.cluster.local/mcp", resolver)).toBe(
      "allowed",
    );
    expect(
      await verdict("http://ollama.ai.svc.cluster.local/v1", resolver),
    ).toBe("allowed");
  });

  it("never opens a name that only ends in the same letters", async () => {
    allow("corp.example");
    const resolver = dnsTable({
      "evilcorp.example": ["10.0.0.5"],
      "corp.example.attacker.test": ["10.0.0.5"],
    });
    expect(await verdict("http://evilcorp.example/mcp", resolver)).toBe(
      "blocked",
    );
    expect(
      await verdict("http://corp.example.attacker.test/mcp", resolver),
    ).toBe("blocked");
  });

  it("opens a listed loopback name, but not loopback literals", async () => {
    allow("localhost");
    expect(isBlockedEgressHost("localhost", true)).toBe(false);
    expect(isBlockedEgressHost("my-server.localhost", true)).toBe(false);
    expect(isBlockedEgressHost("127.0.0.1", true)).toBe(true);
  });
});

describe("the metadata floor, under any entry", () => {
  it("refuses metadata, link-local, multicast and unspecified literals under a covering range", async () => {
    allow("0.0.0.0/0,::/0");
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://169.254.170.2/v2/credentials",
      "http://100.100.100.200/latest/meta-data/",
      "http://0.0.0.0/mcp",
      "http://224.0.0.1/mcp",
      "http://[::]/mcp",
      "http://[fe80::1]/mcp",
      "http://[fd00:ec2::254]/latest/meta-data/",
      "http://[ff02::1]/mcp",
      "http://[::ffff:169.254.169.254]/mcp",
    ]) {
      expect(await verdict(url), url).toBe("blocked");
    }
    // The same range does open the private space it was meant for.
    expect(await verdict("http://10.0.0.1/mcp")).toBe("allowed");
    expect(await verdict("http://100.64.0.1/mcp")).toBe("allowed");
  });

  it("refuses metadata names even when a suffix covers them", async () => {
    allow("internal,google.internal,goog,metadata");
    for (const url of [
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://metadata.goog/computeMetadata/v1/",
      "http://metadata/computeMetadata/v1/",
      "http://metadata.google.internal./computeMetadata/v1/",
    ]) {
      expect(await verdict(url, dnsTable({}))).toBe("blocked");
    }
  });

  it("refuses a listed name that resolves to metadata or link-local", async () => {
    allow("0.0.0.0/0,svc.cluster.local");
    const resolver = dnsTable({
      "rebind.svc.cluster.local": ["169.254.169.254"],
      "v6.svc.cluster.local": ["fe80::1"],
    });
    expect(await verdict("http://rebind.svc.cluster.local/mcp", resolver)).toBe(
      "blocked",
    );
    expect(await verdict("http://v6.svc.cluster.local/mcp", resolver)).toBe(
      "blocked",
    );
    expect(
      isBlockedEgressAddress("rebind.svc.cluster.local", "169.254.169.254"),
    ).toBe(true);
    expect(
      admitsPrivateEgress({
        hostname: "rebind.svc.cluster.local",
        address: "169.254.169.254",
      }),
    ).toBe(false);
  });
});

describe("what the list does not name", () => {
  it("stays refused", async () => {
    allow("10.0.0.0/8,svc.cluster.local");
    expect(await verdict("http://172.16.0.1/mcp")).toBe("blocked");
    expect(await verdict("http://192.168.1.1/mcp")).toBe("blocked");
    expect(await verdict("http://127.0.0.1:3000/mcp")).toBe("blocked");
    expect(await verdict("http://[fd00::1]/mcp")).toBe("blocked");
    const resolver = dnsTable({ "other.cluster.local": ["10.96.0.10"] });
    // Listed range, so this name is allowed by its answer, not its suffix...
    expect(await verdict("http://other.cluster.local/mcp", resolver)).toBe(
      "allowed",
    );
    // ...and one answering outside the range is refused.
    const outside = dnsTable({ "other.cluster.local": ["172.20.0.4"] });
    expect(await verdict("http://other.cluster.local/mcp", outside)).toBe(
      "blocked",
    );
  });

  it("leaves public targets exactly as they were", async () => {
    allow("10.0.0.0/8");
    const resolver = dnsTable({ "mcp.example.com": ["93.184.216.34"] });
    expect(await verdict("https://mcp.example.com/mcp", resolver)).toBe(
      "allowed",
    );
    expect(await verdict("https://8.8.8.8/mcp")).toBe("allowed");
  });

  it("changes nothing without a list", async () => {
    expect(hostedPrivateEgressAdmission()).toBeUndefined();
    expect(await verdict("http://10.0.0.1/mcp")).toBe("blocked");
    expect(isBlockedEgressHost("10.0.0.1", true)).toBe(true);
    // Local mode was never gated on the list.
    expect(isBlockedEgressHost("10.0.0.1", false)).toBe(false);
  });
});

describe("an invalid list", () => {
  it("opens nothing, even the entries that were valid, and says why through the logger", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    allow("10.0.0.0/8, *.svc.cluster.local, 172.16.0.0/33");
    const resolver = dnsTable({ "mcp.svc.cluster.local": ["10.96.0.10"] });

    expect(await verdict("http://10.0.0.1/mcp")).toBe("blocked");
    expect(await verdict("http://mcp.svc.cluster.local/mcp", resolver)).toBe(
      "blocked",
    );
    expect(hostedPrivateEgressAdmission()).toBeUndefined();

    expect(error).toHaveBeenCalledTimes(1);
    const [message] = error.mock.calls[0];
    expect(message).toContain("MCPJAM_PRIVATE_EGRESS_ALLOWLIST is ignored");
    expect(message).toContain('"*.svc.cluster.local"');
    expect(message).toContain('"172.16.0.0/33"');
    expect(message).not.toContain('"10.0.0.0/8"');
  });

  it("reports a value once, not on every check", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    allow("10.0.0.0/");
    for (let i = 0; i < 3; i += 1) {
      expect(isBlockedEgressHost("10.0.0.1", true)).toBe(true);
    }
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("redirect hops go through the same decision", () => {
  const redirectTo = (location: string) =>
    new Response(null, { status: 302, headers: { location } });

  it("refuses a redirect into a private range the list does not cover", async () => {
    allow("192.168.0.0/16");
    const baseFetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith("https://public.example/")
        ? redirectTo("http://10.1.2.3/internal")
        : new Response("reached"),
    );
    const guarded = createGuardedFetch({
      hosted: true,
      baseFetch: baseFetch as typeof fetch,
      resolver: dnsTable({ "public.example": ["93.184.216.34"] }),
    });

    await expect(
      guarded("https://public.example/start"),
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect into a range the list covers", async () => {
    allow("10.0.0.0/8");
    const baseFetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith("https://public.example/")
        ? redirectTo("http://10.1.2.3/internal")
        : new Response("reached"),
    );
    const guarded = createGuardedFetch({
      hosted: true,
      baseFetch: baseFetch as typeof fetch,
      resolver: dnsTable({ "public.example": ["93.184.216.34"] }),
    });

    const response = await guarded("https://public.example/start");
    await expect(response.text()).resolves.toBe("reached");
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it("refuses a redirect from a listed host into metadata", async () => {
    allow("0.0.0.0/0,svc.cluster.local");
    const baseFetch = vi.fn(async () =>
      redirectTo("http://169.254.169.254/latest/meta-data/iam/"),
    );
    const guarded = createGuardedFetch({
      hosted: true,
      baseFetch: baseFetch as typeof fetch,
      resolver: dnsTable({ "mcp.svc.cluster.local": ["10.96.0.10"] }),
    });

    await expect(
      guarded("http://mcp.svc.cluster.local/mcp"),
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });
});

describe("the pinned transport hosted MCP connections ride", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function serve(
    host: string,
    handler: http.RequestListener,
  ): Promise<{ origin: string; hits: string[] }> {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      handler(req, res);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    const { port } = server.address() as AddressInfo;
    return { origin: `http://${host}:${port}`, hits };
  }

  it("dials a listed private address in plaintext, and refuses it unlisted", async () => {
    const target = await serve("127.0.0.1", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });

    await expect(
      createStreamingPinnedFetch({ hosted: true })(`${target.origin}/mcp`),
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
    expect(target.hits).toEqual([]);

    allow("127.0.0.1/32");
    const response = await createStreamingPinnedFetch({ hosted: true })(
      `${target.origin}/mcp`,
    );
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(target.hits).toEqual(["/mcp"]);
  });

  it("judges every redirect hop: onto a listed address it follows, onto an unlisted one it refuses", async () => {
    const final = await serve("127.0.0.1", (_req, res) => {
      res.writeHead(200);
      res.end("final");
    });
    const listed = await serve("127.0.0.1", (req, res) => {
      res.writeHead(302, {
        location:
          req.url === "/to-listed"
            ? `${final.origin}/landed`
            : "http://192.168.0.1/internal",
      });
      res.end();
    });
    allow("127.0.0.1/32");
    const guarded = createStreamingPinnedFetch({ hosted: true });

    const followed = await guarded(`${listed.origin}/to-listed`);
    await expect(followed.text()).resolves.toBe("final");
    expect(final.hits).toEqual(["/landed"]);

    // Refused as a verdict, before any socket: a dial would surface as a
    // connection error instead.
    const refused = await guarded(`${listed.origin}/to-unlisted`).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(BlockedEgressTargetError);
    expect((refused as Error).message).toMatch(
      /not a publicly routable address/,
    );
  });

  it("refuses a redirect from a listed address into metadata", async () => {
    const listed = await serve("127.0.0.1", (_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/" });
      res.end();
    });
    allow("0.0.0.0/0");

    await expect(
      createStreamingPinnedFetch({ hosted: true })(`${listed.origin}/mcp`),
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
  });
});
