import { describe, expect, it } from "vitest";
import {
  BlockedEgressTargetError,
  assertAllowedHostedTargetUrl,
  type EgressHostResolver,
} from "../hosted-egress-guard.js";

/** Never consulted — reaching it means the literal check failed to short-circuit. */
const exploding: EgressHostResolver = async () => {
  throw new Error("resolver must not be called for an IP literal");
};

const resolvesTo =
  (...ips: string[]): EgressHostResolver =>
  async () =>
    ips;

async function assertBlocked(url: string, resolver?: EgressHostResolver) {
  await expect(
    assertAllowedHostedTargetUrl(url, "Server URL", {
      hosted: true,
      resolver: resolver ?? exploding,
    })
  ).rejects.toBeInstanceOf(BlockedEgressTargetError);
}

async function assertAllowed(url: string, resolver?: EgressHostResolver) {
  await expect(
    assertAllowedHostedTargetUrl(url, "Server URL", {
      hosted: true,
      resolver: resolver ?? exploding,
    })
  ).resolves.toBeUndefined();
}

describe("assertAllowedHostedTargetUrl — literal hosts", () => {
  it("blocks cloud metadata, link-local and the unspecified address", async () => {
    await assertBlocked("http://169.254.169.254/mcp");
    await assertBlocked("http://169.254.0.1/mcp");
    await assertBlocked("http://metadata.google.internal/mcp", resolvesTo());
    await assertBlocked("http://0.0.0.0/mcp");
    await assertBlocked("http://[::]/mcp");
    await assertBlocked("http://[fe80::1]/mcp");
  });

  it("blocks loopback and `.localhost` when hosted", async () => {
    await assertBlocked("http://127.0.0.1:3000/mcp");
    await assertBlocked("http://127.9.9.9/mcp");
    await assertBlocked("http://[::1]:3000/mcp");
    await assertBlocked("http://localhost:3000/mcp", resolvesTo());
    await assertBlocked("http://my-server.localhost/mcp", resolvesTo());
  });

  it("blocks RFC-1918, CGNAT and IPv6 ULA", async () => {
    await assertBlocked("http://10.0.0.5/mcp");
    await assertBlocked("http://192.168.1.1/mcp");
    await assertBlocked("http://172.16.0.1/mcp");
    await assertBlocked("http://172.31.255.254/mcp");
    await assertBlocked("http://100.64.0.1/mcp");
    await assertBlocked("http://[fc00::1]/mcp");
    await assertBlocked("http://[fd12:3456::1]/mcp");
  });

  it("blocks IPv4-mapped IPv6 spellings of the same addresses", async () => {
    await assertBlocked("http://[::ffff:169.254.169.254]/mcp");
    await assertBlocked("http://[::ffff:127.0.0.1]/mcp");
    await assertBlocked("http://[::ffff:10.0.0.5]/mcp");
  });

  it("blocks the hex spelling `new URL()` rewrites those into", async () => {
    // `new URL("http://[::ffff:169.254.169.254]/").hostname` is
    // `[::ffff:a9fe:a9fe]` — checking only the dotted form left the metadata
    // endpoint reachable through any parsed URL.
    expect(new URL("http://[::ffff:169.254.169.254]/").hostname).toBe(
      "[::ffff:a9fe:a9fe]"
    );
    await assertBlocked("http://[::ffff:a9fe:a9fe]/mcp"); // 169.254.169.254
    await assertBlocked("http://[::ffff:7f00:1]/mcp"); // 127.0.0.1
    await assertBlocked("http://[::ffff:a00:5]/mcp"); // 10.0.0.5
    await assertBlocked("http://[::ffff:c0a8:101]/mcp"); // 192.168.1.1
    // …and the same spelling of a PUBLIC address still goes through.
    await assertAllowed("http://[::ffff:808:808]/mcp"); // 8.8.8.8
  });

  it("allows public IP literals without touching DNS", async () => {
    // `exploding` proves the literal path never resolves.
    await assertAllowed("https://8.8.8.8/mcp");
    await assertAllowed("https://172.32.0.1/mcp");
    await assertAllowed("https://11.0.0.1/mcp");
    await assertAllowed("https://[2606:4700::1111]/mcp");
  });

  it("rejects non-http(s) schemes and unparseable URLs", async () => {
    await assertBlocked("file:///etc/passwd");
    await assertBlocked("gopher://example.com/");
    await assertBlocked("not a url");
  });
});

describe("assertAllowedHostedTargetUrl — DNS rebinding", () => {
  it("blocks a public hostname that resolves to a private address", async () => {
    await assertBlocked(
      "https://rebind.example.com/mcp",
      resolvesTo("127.0.0.1")
    );
    await assertBlocked(
      "https://rebind.example.com/mcp",
      resolvesTo("169.254.169.254")
    );
    await assertBlocked("https://rebind.example.com/mcp", resolvesTo("::1"));
  });

  it("blocks when ANY resolved address is private, not just the first", async () => {
    await assertBlocked(
      "https://mixed.example.com/mcp",
      resolvesTo("93.184.216.34", "10.0.0.5")
    );
  });

  it("fails closed on an unresolvable hostname", async () => {
    await expect(
      assertAllowedHostedTargetUrl(
        "https://nope.example.test/mcp",
        "Server URL",
        {
          hosted: true,
          resolver: resolvesTo(),
        }
      )
    ).rejects.toThrow(/could not be resolved/);
  });

  it("reports a resolver failure as a lookup problem, not a verdict", async () => {
    // A DNS blip must not read as "your server is blocked" — the wording is
    // the only thing separating an infra hiccup from a real refusal.
    await expect(
      assertAllowedHostedTargetUrl(
        "https://flaky.example.com/mcp",
        "Server URL",
        {
          hosted: true,
          resolver: async () => {
            throw new Error("ESERVFAIL");
          },
        }
      )
    ).rejects.toThrow(/Could not check .* for a safe address: ESERVFAIL/);
  });

  it("allows a hostname that resolves entirely to public addresses", async () => {
    await assertAllowed(
      "https://mcp.example.com/mcp",
      resolvesTo("93.184.216.34", "2606:2800:220:1::1")
    );
  });

  it("allows a tunnel-backed server URL", async () => {
    // Tunnels ride public `*.tunnels.mcpjam.com` hostnames, so they clear the
    // guard like any other public target.
    await assertAllowed(
      "https://abc123.tunnels.mcpjam.com/mcp",
      resolvesTo("104.18.0.1")
    );
  });
});

describe("assertAllowedHostedTargetUrl — local mode", () => {
  it("is a no-op outside hosted mode, localhost very much included", async () => {
    // Testing a server on localhost is the inspector's whole job locally.
    for (const url of [
      "http://localhost:3000/mcp",
      "http://127.0.0.1:3000/mcp",
      "http://192.168.1.50/mcp",
      "http://169.254.169.254/mcp",
    ]) {
      await expect(
        assertAllowedHostedTargetUrl(url, "Server URL", {
          hosted: false,
          resolver: exploding,
        })
      ).resolves.toBeUndefined();
    }
  });
});

describe("assertAllowedHostedTargetUrl — error text", () => {
  it("names the field that was refused", async () => {
    await expect(
      assertAllowedHostedTargetUrl(
        "http://10.0.0.5/mcp",
        "OAuth profile server URL",
        { hosted: true, resolver: exploding }
      )
    ).rejects.toThrow(/OAuth profile server URL/);
  });
});
