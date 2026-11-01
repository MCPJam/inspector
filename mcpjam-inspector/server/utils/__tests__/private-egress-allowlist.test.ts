import { describe, expect, it } from "vitest";
import { parsePrivateEgressAllowlist } from "../private-egress-allowlist.js";

function allowlist(raw: string) {
  const parsed = parsePrivateEgressAllowlist(raw);
  expect(parsed.invalid).toEqual([]);
  return parsed.allowlist;
}

describe("parsePrivateEgressAllowlist — what an entry is", () => {
  it("is empty for an unset, blank or separators-only value", () => {
    for (const raw of [undefined, "", "   ", " , ,"]) {
      const parsed = parsePrivateEgressAllowlist(raw);
      expect(parsed.invalid).toEqual([]);
      expect(parsed.allowlist.isEmpty).toBe(true);
      expect(parsed.allowlist.admits({ hostname: "10.0.0.1" })).toBe(false);
    }
  });

  it("reads IPv4 and IPv6 ranges, bare addresses and suffixes, trimming each", () => {
    const list = allowlist(
      " 10.0.0.0/8 , fd00::/8,192.168.1.7, ::1 ,.svc.cluster.local, Corp.Example. ",
    );
    expect(list.isEmpty).toBe(false);
    expect(list.admits({ hostname: "10.200.3.4" })).toBe(true);
    expect(list.admits({ hostname: "[fd12::5]" })).toBe(true);
    expect(list.admits({ hostname: "192.168.1.7" })).toBe(true);
    expect(list.admits({ hostname: "192.168.1.8" })).toBe(false);
    expect(list.admits({ hostname: "[::1]" })).toBe(true);
    expect(list.admits({ hostname: "mcp.tools.svc.cluster.local" })).toBe(true);
    expect(list.admits({ hostname: "MCP.CORP.EXAMPLE." })).toBe(true);
  });

  it.each([
    ["10.0.0.0/33", /prefix length from 0 to 32/],
    ["fd00::/129", /prefix length from 0 to 128/],
    ["10.0.0.0/", /prefix length/],
    ["10.0.0.0/08", /prefix length/],
    ["10.0.0.0/-1", /prefix length/],
    ["10.0.0.1/8", /bits set past its \/8 prefix/],
    ["fd00::1/8", /bits set past its \/8 prefix/],
    ["010.0.0.0/8", /not a valid IPv4 or IPv6 address/],
    ["10.0.0/8", /not a valid IPv4 or IPv6 address/],
    ["256.0.0.0/8", /not a valid IPv4 or IPv6 address/],
    ["10.0.0.0 /8", /not a valid IPv4 or IPv6 address/],
    ["fe80::1%eth0", /not a valid IPv4 or IPv6 address/],
    ["[fd00::]/8", /not a valid IPv4 or IPv6 address/],
    ["10.1.2", /not a valid IPv4 or IPv6 address/],
    ["*.svc.cluster.local", /no wildcards/],
    ["svc..cluster.local", /not a host suffix/],
    ["under_score.example", /not a host suffix/],
    ["-leading.example", /not a host suffix/],
    ["bücher.example", /not a host suffix/],
    ["printer.10", /ends in a number/],
  ])("refuses %s", (entry, reason) => {
    const parsed = parsePrivateEgressAllowlist(entry);
    expect(parsed.invalid).toHaveLength(1);
    expect(parsed.invalid[0].entry).toBe(entry);
    expect(parsed.invalid[0].reason).toMatch(reason);
  });

  it("voids the whole list when any entry is invalid, so a typo never widens it", () => {
    const parsed = parsePrivateEgressAllowlist(
      "10.0.0.0/8,svc.cluster.local,10.0.0.0/",
    );
    expect(parsed.invalid.map(({ entry }) => entry)).toEqual(["10.0.0.0/"]);
    expect(parsed.allowlist.isEmpty).toBe(true);
    // Neither the valid range nor the valid suffix survives the bad entry.
    expect(parsed.allowlist.admits({ hostname: "10.1.2.3" })).toBe(false);
    expect(
      parsed.allowlist.admits({ hostname: "mcp.tools.svc.cluster.local" }),
    ).toBe(false);
  });
});

describe("parsePrivateEgressAllowlist — how entries match", () => {
  it("matches suffixes on label boundaries only", () => {
    const list = allowlist("corp.example");
    expect(list.admits({ hostname: "corp.example" })).toBe(true);
    expect(list.admits({ hostname: "a.corp.example" })).toBe(true);
    expect(list.admits({ hostname: "a.b.corp.example" })).toBe(true);
    expect(list.admits({ hostname: "evilcorp.example" })).toBe(false);
    expect(list.admits({ hostname: "corp.example.evil" })).toBe(false);
    expect(list.admits({ hostname: "example" })).toBe(false);
  });

  it("matches a suffix against names only, never against an IP literal", () => {
    const list = allowlist("example");
    expect(list.admits({ hostname: "10.0.0.1" })).toBe(false);
    expect(list.admits({ hostname: "[fd00::1]" })).toBe(false);
  });

  it("matches a range against addresses only, never against a name", () => {
    const list = allowlist("10.0.0.0/8");
    expect(list.admits({ hostname: "ten.example" })).toBe(false);
    expect(list.admits({ hostname: "ten.example", address: "10.0.0.5" })).toBe(
      true,
    );
    expect(
      list.admits({ hostname: "ten.example", address: "172.16.0.5" }),
    ).toBe(false);
  });

  it("lets a listed suffix admit whatever address the name resolved to", () => {
    const list = allowlist("svc.cluster.local");
    expect(
      list.admits({ hostname: "a.svc.cluster.local", address: "10.96.0.10" }),
    ).toBe(true);
    expect(
      list.admits({ hostname: "a.other.local", address: "10.96.0.10" }),
    ).toBe(false);
  });

  it("judges an IPv4-mapped IPv6 address as the IPv4 address it carries", () => {
    const list = allowlist("10.0.0.0/8");
    expect(list.admits({ hostname: "[::ffff:10.1.2.3]" })).toBe(true);
    expect(list.admits({ hostname: "[::ffff:a01:203]" })).toBe(true);
    expect(list.admits({ hostname: "n.example", address: "::ffff:10.1.2.3" })).toBe(
      true,
    );
    // An IPv6 range does not reach a mapped address, which is IPv4.
    expect(allowlist("::/0").admits({ hostname: "[::ffff:10.1.2.3]" })).toBe(
      false,
    );
  });

  it("matches IPv6 ranges bit by bit", () => {
    const list = allowlist("fd12:3456::/32");
    expect(list.admits({ hostname: "[fd12:3456:ffff::1]" })).toBe(true);
    expect(list.admits({ hostname: "[fd12:3457::1]" })).toBe(false);
    expect(list.admits({ hostname: "10.0.0.1" })).toBe(false);
  });

  it("matches IPv4 ranges with prefixes that end inside an octet", () => {
    const list = allowlist("172.16.0.0/12");
    expect(list.admits({ hostname: "172.31.255.255" })).toBe(true);
    expect(list.admits({ hostname: "172.32.0.0" })).toBe(false);
    expect(list.admits({ hostname: "172.15.255.255" })).toBe(false);
  });
});
