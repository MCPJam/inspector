import { describe, it, expect } from "vitest";
import {
  PILL_MAX_LOGOS,
  selectSupportingReports,
  sortSupportersForPill,
} from "../ClientSupportPill";
import type { CompatVerdict, HostCompatReport } from "@/lib/host-compat/types";

function makeReport(
  hostId: string,
  verdict: CompatVerdict = "works",
  findings: HostCompatReport["findings"] = [],
): HostCompatReport {
  return {
    hostId,
    hostLabel: hostId,
    verdict,
    provenance: "observed",
    lanes: {
      apps: { verdict, provenance: "observed" },
      server: { verdict, provenance: "observed" },
    },
    findings,
    logoSrc: "",
  };
}

describe("selectSupportingReports", () => {
  it("keeps only hosts whose compat status is green", () => {
    const supporters = selectSupportingReports([
      makeReport("chatgpt", "works"),
      makeReport("cursor", "blocked"),
      makeReport("vscode", "degraded"),
      makeReport("goose", "unknown"),
      makeReport("claude", "works"),
    ]);
    expect(supporters.map((r) => r.hostId)).toEqual(["chatgpt", "claude"]);
  });

  it("does not count a works verdict that carries a blocking finding", () => {
    // getCompatDisplayStatus downgrades these to orange — a host that needs
    // verification is not a supporter, and counting it would overstate support.
    const supporters = selectSupportingReports([
      makeReport("chatgpt", "works", [
        {
          code: "protocol_version_mismatch",
          severity: "info",
          title: "Protocol version not advertised",
          detail: "The negotiated version isn't in this host's set.",
          lane: "server",
          provenance: "observed",
        },
      ]),
      makeReport("claude", "works"),
    ]);
    expect(supporters.map((r) => r.hostId)).toEqual(["claude"]);
  });

  it("returns nothing when no host supports the server", () => {
    expect(
      selectSupportingReports([
        makeReport("cursor", "blocked"),
        makeReport("vscode", "unknown"),
      ]),
    ).toEqual([]);
  });
});

describe("sortSupportersForPill", () => {
  it("leads with chatgpt then claude", () => {
    const order = sortSupportersForPill([
      makeReport("cursor"),
      makeReport("claude"),
      makeReport("vscode"),
      makeReport("chatgpt"),
    ]).map((r) => r.hostId);
    expect(order.slice(0, 2)).toEqual(["chatgpt", "claude"]);
  });

  it("omits absent leaders rather than inserting gaps", () => {
    const order = sortSupportersForPill([
      makeReport("cursor"),
      makeReport("claude"),
    ]).map((r) => r.hostId);
    expect(order).toEqual(["claude", "cursor"]);
  });

  it("keeps the incoming order for hosts outside the leading/trailing set", () => {
    const order = sortSupportersForPill([
      makeReport("vscode"),
      makeReport("cursor"),
      makeReport("goose"),
    ]).map((r) => r.hostId);
    expect(order).toEqual(["vscode", "cursor", "goose"]);
  });

  it("trails mcpjam so our own client never costs a visible slot", () => {
    // MCPJam leads the host catalog, so with no trailing rule it lands first
    // among the non-leaders and eats one of the three marks on show. Ordering
    // is the only thing keeping it out, which is why this is asserted against
    // the truncation and not just the full list.
    const order = sortSupportersForPill([
      makeReport("mcpjam"),
      makeReport("vscode"),
      makeReport("cursor"),
      makeReport("claude"),
    ]).map((r) => r.hostId);
    expect(order).toEqual(["claude", "vscode", "cursor", "mcpjam"]);
    expect(order.slice(0, PILL_MAX_LOGOS)).not.toContain("mcpjam");
  });

  it("still shows mcpjam when it is the only supporter", () => {
    // Trailing must not read as hidden: with nothing else green, our own mark
    // is the honest answer rather than an empty stack.
    const order = sortSupportersForPill([makeReport("mcpjam")]).map(
      (r) => r.hostId,
    );
    expect(order).toEqual(["mcpjam"]);
  });

  it("produces the full documented order end to end", () => {
    // Both leaders, two middles and the trailer in one assertion — the shape
    // the strip's own end-to-end test pinned before it was deleted. The
    // trailing test above uses a single leader, so without this nothing
    // asserts the whole chain at once.
    const order = sortSupportersForPill([
      makeReport("mcpjam"),
      makeReport("vscode"),
      makeReport("claude"),
      makeReport("cursor"),
      makeReport("chatgpt"),
    ]).map((r) => r.hostId);
    expect(order).toEqual(["chatgpt", "claude", "vscode", "cursor", "mcpjam"]);
  });

  it("puts both leaders in front of the first three shown logos", () => {
    // The stack is truncated to PILL_MAX_LOGOS, so ordering is what decides
    // whether ChatGPT/Claude are visible at all on a widely supported server.
    const shown = sortSupportersForPill([
      makeReport("vscode"),
      makeReport("cursor"),
      makeReport("goose"),
      makeReport("claude"),
      makeReport("n8n"),
      makeReport("chatgpt"),
    ])
      .slice(0, PILL_MAX_LOGOS)
      .map((r) => r.hostId);
    expect(shown).toEqual(["chatgpt", "claude", "vscode"]);
  });
});
