import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `defaultEgressHostResolver` decides whether an empty DNS answer is a FACT
 * ("this name has no records" — fail closed on it) or an OUTAGE ("our resolver
 * broke" — retryable). Getting that wrong tells a user their server is
 * forbidden during a DNS incident.
 *
 * These tests mock `node:dns` so the real classification runs. A test that
 * stubbed the resolver itself would only be checking its own mock.
 */

const resolve4 = vi.hoisted(() => vi.fn());
const resolve6 = vi.hoisted(() => vi.fn());

vi.mock("node:dns", () => ({
  promises: { resolve4, resolve6 },
}));

function dnsError(code: string) {
  return Object.assign(new Error(code), { code });
}

async function resolver() {
  vi.resetModules();
  const { defaultEgressHostResolver } = await import("../hosted-egress-guard");
  return defaultEgressHostResolver;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("defaultEgressHostResolver", () => {
  it("merges both families when both answer", async () => {
    resolve4.mockResolvedValue(["93.184.216.34"]);
    resolve6.mockResolvedValue(["2606:2800:220:1::1"]);
    expect(await (await resolver())("example.com")).toEqual([
      "93.184.216.34",
      "2606:2800:220:1::1",
    ]);
  });

  it("keeps one family's answer when the other has no record", async () => {
    // Ordinary: plenty of hosts are v4-only.
    resolve4.mockResolvedValue(["93.184.216.34"]);
    resolve6.mockRejectedValue(dnsError("ENODATA"));
    expect(await (await resolver())("example.com")).toEqual(["93.184.216.34"]);
  });

  it("returns empty when BOTH families genuinely have no record", async () => {
    // A fact, not an outage — the caller fails closed on it.
    resolve4.mockRejectedValue(dnsError("ENOTFOUND"));
    resolve6.mockRejectedValue(dnsError("ENOTFOUND"));
    expect(await (await resolver())("nope.example.com")).toEqual([]);
  });

  it("throws when both families fail transiently", async () => {
    resolve4.mockRejectedValue(dnsError("ESERVFAIL"));
    resolve6.mockRejectedValue(dnsError("ESERVFAIL"));
    await expect((await resolver())("flaky.example.com")).rejects.toThrow(
      /ESERVFAIL/
    );
  });

  it("throws on a MIXED no-record + outage answer", async () => {
    // The subtle one. v4 says "no such record" (a fact), v6 SERVFAILs (an
    // outage) — so we never learned whether an AAAA exists. Reporting
    // "unresolvable" would be a claim we cannot support, and would answer 400
    // "your server is forbidden" in the middle of a DNS incident.
    resolve4.mockRejectedValue(dnsError("ENODATA"));
    resolve6.mockRejectedValue(dnsError("ESERVFAIL"));
    await expect((await resolver())("mixed.example.com")).rejects.toThrow(
      /ESERVFAIL/
    );
  });

  it("prefers a real answer over a sibling family's outage", async () => {
    // If one family ANSWERED, we have addresses to judge — no need to fail.
    resolve4.mockResolvedValue(["93.184.216.34"]);
    resolve6.mockRejectedValue(dnsError("ESERVFAIL"));
    expect(await (await resolver())("example.com")).toEqual(["93.184.216.34"]);
  });
});
