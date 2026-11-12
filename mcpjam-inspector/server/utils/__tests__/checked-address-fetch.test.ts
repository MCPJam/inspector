/**
 * The gateway Test's fetch: hosted, it dials only the addresses the egress
 * guard checked, so a DNS answer that changes after the check cannot move the
 * connection somewhere else.
 */
import http from "node:http";
import type { LookupAddress, LookupOptions } from "node:dns";
import type { AddressInfo, LookupFunction } from "node:net";
import { Agent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BlockedEgressTargetError,
  assertAllowedHostedTargetUrl,
  type EgressHostResolver,
} from "../hosted-egress-guard.js";
import {
  checkedAddressLookup,
  createCheckedAddressFetch,
} from "../checked-address-fetch.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const resolvesTo =
  (...ips: string[]): EgressHostResolver =>
  async () =>
    ips;

type LookupAnswer = {
  error: NodeJS.ErrnoException | null;
  address: string | LookupAddress[];
  family?: number;
};

function lookupOnce(
  lookup: LookupFunction,
  hostname: string,
  options: LookupOptions,
): Promise<LookupAnswer> {
  return new Promise((resolve) =>
    lookup(hostname, options, (error, address, family) =>
      resolve({ error, address, family }),
    ),
  );
}

describe("checkedAddressLookup", () => {
  it("answers with only the address the check passed", async () => {
    // A second resolution could answer anything, a private address included,
    // so the lookup hands back what the check saw and never resolves again.
    const addresses = await assertAllowedHostedTargetUrl(
      "https://gateway.example.com/v1",
      "Gateway URL",
      { hosted: true, resolver: resolvesTo("93.184.216.34") },
    );
    const lookup = checkedAddressLookup("gateway.example.com", addresses);

    await expect(
      lookupOnce(lookup, "gateway.example.com", { all: true }),
    ).resolves.toEqual({
      error: null,
      address: [{ address: "93.184.216.34", family: 4 }],
      family: undefined,
    });
    await expect(
      lookupOnce(lookup, "Gateway.Example.com.", {}),
    ).resolves.toEqual({ error: null, address: "93.184.216.34", family: 4 });
  });

  it("finds no other host, and nothing when no address was checked", async () => {
    const other = await lookupOnce(
      checkedAddressLookup("gateway.example.com", ["93.184.216.34"]),
      "internal.example.com",
      { all: true },
    );
    expect(other.error?.code).toBe("ENOTFOUND");
    const none = await lookupOnce(
      checkedAddressLookup("gateway.example.com", []),
      "gateway.example.com",
      {},
    );
    expect(none.error?.code).toBe("ENOTFOUND");
  });
});

describe("createCheckedAddressFetch", () => {
  it("is plain fetch outside hosted mode", () => {
    expect(createCheckedAddressFetch({ hosted: false })).toBe(fetch);
  });

  it("refuses a name that resolves to a private address before dialing", async () => {
    const baseFetch = vi.fn<typeof fetch>();
    const checkedFetch = createCheckedAddressFetch({
      hosted: true,
      resolver: resolvesTo("10.0.0.5"),
      baseFetch,
    });

    await expect(
      checkedFetch("https://gateway.example.com/v1/models"),
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("dials through a pinned agent and hands a redirect back unfollowed", async () => {
    const baseFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://10.0.0.5/" },
        }),
    );
    const response = await createCheckedAddressFetch({
      hosted: true,
      resolver: resolvesTo("93.184.216.34"),
      baseFetch,
    })("https://gateway.example.com/v1/models", { redirect: "follow" });

    expect(response.status).toBe(302);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(baseFetch.mock.calls[0][1]).toMatchObject({
      redirect: "manual",
      dispatcher: expect.any(Agent),
    });
  });
});

describe("dialing through the pinned agent", () => {
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

  it("reaches the checked address under the name that was asked for", async () => {
    const hosts: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
      hosts.push(req.headers.host);
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"data":[]}');
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    // The loopback server stands in for a gateway on the operator's network.
    vi.stubEnv("MCPJAM_PRIVATE_EGRESS_ALLOWLIST", "127.0.0.1/32");

    // No DNS server answers a `.test` name, so reaching the server at all
    // shows the socket dialed the checked address rather than resolving.
    const response = await createCheckedAddressFetch({
      hosted: true,
      resolver: resolvesTo("127.0.0.1"),
    })(`http://gateway.example.test:${port}/v1/models`);

    // Read after the agent was closed: closing waits for the body.
    await expect(response.text()).resolves.toBe('{"data":[]}');
    expect(hosts).toEqual([`gateway.example.test:${port}`]);
  });
});
