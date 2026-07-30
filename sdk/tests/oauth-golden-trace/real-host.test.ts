/**
 * HP-44 — the first golden trace of a REAL third-party host.
 *
 * `claude-code` is one of the 16 catalog hosts. This trace was captured by
 * pointing a headless Claude Code (`claude -p --mcp-config`) at the recording
 * server in `tests/support/oauth-capture-server.ts` and letting it authenticate
 * against a server we control end to end. Nothing was proxied, nothing was
 * inferred, and nothing was typed by hand — the artifact is the bytes Claude Code
 * chose to send.
 *
 * It matters because it settles cells the HP-47 desk survey could not, and
 * because it CORRECTS two values that survey had read from a vendor-published
 * CIMD document. That is the harness doing the one job it exists for: making
 * client behavior falsifiable instead of asserted.
 *
 * | Field | HP-47 desk research | This trace |
 * | --- | --- | --- |
 * | User-Agent | `unverifiable` | `claude-code/2.1.220 (sdk-cli)` |
 * | `MCP-Protocol-Version` header | `unverifiable` | `2025-11-25` on OAuth discovery, **absent** on MCP traffic |
 * | DCR `client_name` | `Claude Code` (from CIMD) | `Claude Code (<serverName>)` — **templated** |
 * | DCR `redirect_uris` | `localhost/callback` + `127.0.0.1/callback`, **port-less** (from CIMD) | `http://localhost:3118/callback` — **explicit port** |
 *
 * The last two are not contradictions of the CIMD document; they are evidence
 * that what a client REGISTERS via DCR differs from what its published CIMD
 * declares. A server gating on an exact `client_name` would accept one and
 * reject the other. Only a capture surfaces that.
 *
 * The capture is PARTIAL: a non-interactive session cannot open a browser, so
 * `/authorize` and `/token` were never sent. Those legs are `not-observed` with
 * reasons — never `absent` — which is the whole point of the tri-state and is
 * asserted below.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  diffGoldenTraces,
  findObservationDrift,
  findRedactionViolations,
  traceToOAuthProfile,
} from "../../src/oauth-golden-trace/index.js";
import type { GoldenTrace } from "../../src/oauth-golden-trace/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures", "golden-traces");
const CLAUDE_CODE_TRACE = join(
  FIXTURES,
  "claude-code-http-capture-dcr-authcode-prm.json",
);
const MCPJAM_TRACE = join(FIXTURES, "mcpjam-in-memory-dcr-authcode-prm.json");

function load(path: string): GoldenTrace {
  return JSON.parse(readFileSync(path, "utf8")) as GoldenTrace;
}

describe("HP-44 real-host trace: claude-code", () => {
  it("is a valid, redacted, self-consistent artifact", () => {
    const trace = load(CLAUDE_CODE_TRACE);
    expect(trace.traceVersion).toBe(1);
    expect(trace.subject.kind).toBe("real-host");
    expect(trace.subject.hostId).toBe("claude-code");
    expect(trace.capture.method.via).toBe("har");
    expect(findRedactionViolations(trace)).toEqual([]);
    // Observations must still follow from the wire they claim to summarize.
    expect(findObservationDrift(trace)).toEqual([]);
  });

  it("settles the User-Agent that desk research could not", () => {
    const trace = load(CLAUDE_CODE_TRACE);
    // One UA across every captured leg — which also answers, for this host, the
    // question left open for Goose: whether the client's UA reaches the
    // authorization server. Here it demonstrably does.
    expect(trace.observations.userAgent.consistent).toBe(true);
    expect(trace.observations.userAgent.byLeg["dcr-register"]).toEqual({
      state: "present",
      value: ["claude-code/2.1.220 (sdk-cli)"],
    });
    expect(trace.observations.userAgent.byLeg["prm-discovery"]).toEqual({
      state: "present",
      value: ["claude-code/2.1.220 (sdk-cli)"],
    });
  });

  it("shows claude-code is a split-wire client", () => {
    const pv = load(CLAUDE_CODE_TRACE).observations.protocolVersion;

    // Present on OAuth discovery...
    expect(pv.headerOnOAuthDiscovery).toEqual({
      state: "present",
      value: ["2025-11-25"],
    });
    // ...and demonstrably ABSENT on MCP traffic. `absent` rather than
    // `not-observed`: the MCP request WAS captured and simply carried no such
    // header. That distinction is what makes this a citable finding instead of a
    // gap, and it is the reason the tri-state exists.
    expect(pv.headerOnMcpTraffic).toEqual({ state: "absent" });

    // Which makes the two wires disagree — the flag that would have been averaged
    // away by a single `protocolVersionPinning` field.
    expect(pv.wiresDisagree).toBe(true);

    // The `initialize` body still names 2025-11-25, so the header and the body do
    // NOT disagree; only the two wires do. Tracking these separately is what lets
    // both statements be true at once.
    expect(pv.initializeBody).toEqual({ state: "present", value: "2025-11-25" });
    expect(pv.headerDisagreesWithInitializeBody).toBe(false);
  });

  it("records the DCR identity actually sent, not the one CIMD advertises", () => {
    const dcr = load(CLAUDE_CODE_TRACE).observations.dcrIdentity;

    // Templated with the configured server name — NOT the bare "Claude Code" the
    // published CIMD document declares. A server gating on an exact client_name
    // would treat these as two different clients.
    expect(dcr.clientName).toEqual({
      state: "present",
      value: "Claude Code (hp44capture)",
    });

    // `localhost` with an explicit port, not the port-less form CIMD registers.
    expect(dcr.redirectUris).toEqual({
      state: "present",
      value: ["http://localhost:{port}/callback"],
    });
    // The port is placeheld for diffing but retained as evidence, because the
    // port RANGE is a per-host fact.
    expect(dcr.observedLoopbackPorts).toEqual({ state: "present", value: [3118] });

    // A public client, confirming the desk finding.
    expect(dcr.tokenEndpointAuthMethod).toEqual({ state: "present", value: "none" });
    expect(dcr.grantTypes).toEqual({
      state: "present",
      value: ["authorization_code", "refresh_token"],
    });
  });

  it("reports the legs it never reached as not-observed, never as absent", () => {
    const trace = load(CLAUDE_CODE_TRACE);
    const ri = trace.observations.resourceIndicator;

    // This is the load-bearing assertion of the whole file. A headless session
    // cannot open a browser, so /authorize and /token were never sent. Recording
    // `resource` as `absent` here would assert "Claude Code does not send RFC 8707
    // resource indicators" — a claim this capture cannot support, and precisely the
    // class of false claim that made this harness necessary.
    expect(ri.onAuthorize.state).toBe("not-observed");
    expect(ri.onToken.state).toBe("not-observed");
    if (ri.onAuthorize.state === "not-observed") {
      expect(ri.onAuthorize.reason).toContain("no /authorize request was captured");
    }

    expect(trace.observations.legOrder).toEqual([
      "mcp-unauthenticated",
      "prm-discovery",
      "as-metadata-discovery",
      "dcr-register",
    ]);
  });

  it("projects onto a profile that claims exactly what the capture supports", () => {
    const profile = traceToOAuthProfile(load(CLAUDE_CODE_TRACE), {
      tracePath:
        "sdk/tests/fixtures/golden-traces/claude-code-http-capture-dcr-authcode-prm.json",
    });

    // DCR identity: verified, because those bytes were on the wire.
    expect(profile.dcrIdentity?.status).toBe("verified");
    if (profile.dcrIdentity?.status === "verified") {
      expect(profile.dcrIdentity.value.clientName).toBe("Claude Code (hp44capture)");
      expect(profile.dcrIdentity.value.userAgent).toBe("claude-code/2.1.220 (sdk-cli)");
    }

    // Resource indicator: unverifiable, because the legs carrying it were never
    // sent. The partial capture does not get upgraded into a claim.
    expect(profile.sendsResourceIndicator?.status).toBe("unverifiable");

    // Spec revision: a behavioral FLOOR from the observed PRM fetch, never an
    // exact revision.
    expect(profile.oauthSpecVersion?.status).toBe("verified");
    if (profile.oauthSpecVersion?.status === "verified") {
      expect(profile.oauthSpecVersion.value).toEqual({
        basis: "behavioral",
        minimumRevision: "2025-06-18",
      });
    }

    // Pinning: verified from the OAuth-discovery header, which cannot have been
    // negotiated because no `initialize` had happened yet.
    expect(profile.protocolVersionPinning?.status).toBe("verified");
    if (profile.protocolVersionPinning?.status === "verified") {
      expect(profile.protocolVersionPinning.value).toEqual({
        mode: "pinned",
        version: "2025-11-25",
      });
    }

    // And the staleness gap is preserved rather than papered over: we never
    // resolved which dependency produced this behavior.
    const provenance = (profile.extensions as Record<string, unknown>)
      .traceProvenance as Record<string, unknown>;
    expect((provenance.oauthImplementation as { state: string }).state).toBe(
      "not-observed",
    );
  });

  it("refuses to diff a real claude-code trace against an mcpjam trace", () => {
    // The gate, exercised on two REAL artifacts rather than a synthetic pair. No
    // host is supposed to behave like another one, so a cross-host diff is
    // meaningless and must produce one blocking finding — not a wall of
    // differences that looks like an emulator bug.
    const diff = diffGoldenTraces(load(CLAUDE_CODE_TRACE), load(MCPJAM_TRACE));

    expect(diff.parity).toBe(false);
    expect(diff.counts.incomparable).toBeGreaterThan(0);
    expect(diff.findings.some((f) => f.path === "subject.hostId")).toBe(true);
  });
});
