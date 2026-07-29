/**
 * HP-44 — the trace → `HostConfigOAuthProfileV1` projection.
 *
 * These tests are mostly about RESTRAINT. A trace is the strongest evidence we
 * have, and the temptation is to let it settle every field. It cannot, and the
 * places where it cannot are exactly where the previous rounds of this work went
 * wrong. Each test below pins one of those limits so a later change cannot
 * quietly relax it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalizeOAuthProfile } from "../../src/host-config/internal.js";
import {
  deriveObservations,
  traceToOAuthProfile,
} from "../../src/oauth-golden-trace/index.js";
import type { GoldenTrace } from "../../src/oauth-golden-trace/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(
  HERE,
  "..",
  "fixtures",
  "golden-traces",
  "mcpjam-in-memory-dcr-authcode-prm.json",
);

function loadTrace(): GoldenTrace {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as GoldenTrace;
}

/** Rebuild observations after editing a wire, keeping the trace consistent. */
function reobserve(trace: GoldenTrace): GoldenTrace {
  return {
    ...trace,
    observations: deriveObservations({
      wire: trace.wire,
      scenario: trace.scenario,
    }),
  };
}

describe("traceToOAuthProfile", () => {
  it("produces a profile the host-config canonicalizer accepts", () => {
    // The point of projecting onto the existing type rather than inventing a
    // parallel vocabulary: the output has to survive the real canonicalizer.
    const profile = traceToOAuthProfile(loadTrace(), {
      tracePath: "sdk/tests/fixtures/golden-traces/mcpjam-in-memory-dcr-authcode-prm.json",
    });
    expect(() => canonicalizeOAuthProfile(profile)).not.toThrow();
  });

  it("verifies sendsResourceIndicator with the trace as the source", () => {
    const profile = traceToOAuthProfile(loadTrace(), { tracePath: "traces/x.json" });
    const evidence = profile.sendsResourceIndicator;

    expect(evidence?.status).toBe("verified");
    if (evidence?.status === "verified" || evidence?.status === "refuted") {
      expect(evidence.value).toBe(true);
      // A trace is E2 evidence and cites itself, so a reviewer can open it.
      expect(evidence.source).toContain("E2");
      expect(evidence.source).toContain("traces/x.json");
      expect(evidence.capturedAt).toBe("2026-07-29");
    }
  });

  it("refuses to call `resource` absent when the server published no PRM", () => {
    // VS Code and Cline both omit `resource` entirely when PRM discovery fails,
    // and that is CORRECT. Recording `false` from a no-PRM capture would
    // manufacture a finding about the client out of a property of the server.
    const trace = loadTrace();
    const noPrm = reobserve({
      ...trace,
      scenario: {
        ...trace.scenario,
        capabilities: {
          ...trace.scenario.capabilities,
          publishesPrm: false,
          prmResource: undefined,
        },
      },
      wire: trace.wire.map((exchange) => {
        const next = JSON.parse(JSON.stringify(exchange)) as typeof exchange;
        if (next.request.query?.resource) delete next.request.query.resource;
        if (next.request.body?.encoding === "form") {
          delete next.request.body.fields.resource;
        }
        return next;
      }),
    });

    const evidence = traceToOAuthProfile(noPrm).sendsResourceIndicator;
    expect(evidence?.status).toBe("unverifiable");
    if (evidence?.status === "unverifiable") {
      expect(evidence.reason).toContain("publishes no RFC 9728 PRM document");
    }
  });

  it("verifies `resource: false` when a PRM-publishing server was still ignored", () => {
    const trace = loadTrace();
    const stripped = reobserve({
      ...trace,
      wire: trace.wire.map((exchange) => {
        const next = JSON.parse(JSON.stringify(exchange)) as typeof exchange;
        if (next.request.query?.resource) delete next.request.query.resource;
        if (next.request.body?.encoding === "form") {
          delete next.request.body.fields.resource;
        }
        return next;
      }),
    });

    const evidence = traceToOAuthProfile(stripped).sendsResourceIndicator;
    expect(evidence?.status).toBe("verified");
    if (evidence?.status === "verified") expect(evidence.value).toBe(false);
  });

  it("verifies protocolVersionPinning ONLY from the OAuth-discovery header", () => {
    // The single arm one trace can prove: at discovery time no `initialize` has
    // happened, so the header cannot be a negotiated value — it is a client-chosen
    // constant. This is how `rmcp`'s hardcoded 2024-11-05 becomes provable.
    const profile = traceToOAuthProfile(loadTrace());
    const evidence = profile.protocolVersionPinning;

    expect(evidence?.status).toBe("verified");
    if (evidence?.status === "verified") {
      expect(evidence.value).toEqual({ mode: "pinned", version: "2025-11-25" });
      expect(evidence.source).toContain("BEFORE any `initialize` exchange");
      // Scope is stated explicitly so nobody reads this as a claim about the MCP wire.
      expect(evidence.source).toContain("the OAuth wire only");
    }
  });

  it("leaves protocolVersionPinning unverifiable with no OAuth-discovery header", () => {
    // Without that header a single capture cannot tell a pin from a negotiation:
    // a client that negotiates emits the same byte as one that pins when it is
    // talking to exactly one server. This is the trap that produced wrong answers
    // for SDK-delegated clients.
    const trace = loadTrace();
    const noHeader = reobserve({
      ...trace,
      wire: trace.wire.map((exchange) => {
        const next = JSON.parse(JSON.stringify(exchange)) as typeof exchange;
        delete next.request.headers["mcp-protocol-version"];
        return next;
      }),
    });

    const evidence = traceToOAuthProfile(noHeader).protocolVersionPinning;
    expect(evidence?.status).toBe("unverifiable");
    if (evidence?.status === "unverifiable") {
      expect(evidence.reason).toContain("cannot distinguish a pin from a negotiation");
      // The reason names the experiment that WOULD settle it.
      expect(evidence.reason).toContain("second server advertising a DIFFERENT");
    }
  });

  it("settles pin-vs-negotiate from a contrast trace", () => {
    const trace = loadTrace();
    const noHeader = reobserve({
      ...trace,
      wire: trace.wire.map((exchange) => {
        const next = JSON.parse(JSON.stringify(exchange)) as typeof exchange;
        delete next.request.headers["mcp-protocol-version"];
        return next;
      }),
    });

    // Same client, second server advertising a different version, same value in
    // the initialize body ⇒ the value does not follow the server ⇒ a real pin.
    const pinned = traceToOAuthProfile(noHeader, { contrastTrace: noHeader });
    expect(pinned.protocolVersionPinning?.status).toBe("verified");
    if (pinned.protocolVersionPinning?.status === "verified") {
      expect(pinned.protocolVersionPinning.value).toEqual({
        mode: "pinned",
        version: "2025-11-25",
      });
    }

    // A different value against the second server ⇒ it follows the server.
    const contrast = reobserve({
      ...noHeader,
      traceId: "mcpjam/other-scenario/2026-07-29/emulator",
      wire: noHeader.wire.map((exchange) => {
        const next = JSON.parse(JSON.stringify(exchange)) as typeof exchange;
        if (
          next.request.body?.encoding === "jsonrpc" &&
          next.request.body.json &&
          typeof next.request.body.json === "object"
        ) {
          const json = next.request.body.json as {
            params?: { protocolVersion?: string };
          };
          if (json.params?.protocolVersion) json.params.protocolVersion = "2025-06-18";
        }
        return next;
      }),
    });

    const negotiated = traceToOAuthProfile(noHeader, { contrastTrace: contrast });
    expect(negotiated.protocolVersionPinning?.status).toBe("verified");
    if (negotiated.protocolVersionPinning?.status === "verified") {
      expect(negotiated.protocolVersionPinning.value).toEqual({ mode: "negotiated" });
    }
  });

  it("records oauthSpecVersion as a behavioral FLOOR, never an exact revision", () => {
    // A trace observes wire shape. A literal revision string is a claim about the
    // client's code or its docs, so `basis: "constant"` is not something a capture
    // can ever justify.
    const evidence = traceToOAuthProfile(loadTrace()).oauthSpecVersion;
    expect(evidence?.status).toBe("verified");
    if (evidence?.status === "verified") {
      expect(evidence.value.basis).toBe("behavioral");
      if (evidence.value.basis === "behavioral") {
        expect(evidence.value.minimumRevision).toBe("2025-06-18");
      }
      expect(evidence.source).toContain("FLOOR");
    }
  });

  it("never settles authModel from a trace", () => {
    // The field means "every model the client supports, in preference order". A
    // trace shows the ONE path taken against ONE server's capabilities.
    const evidence = traceToOAuthProfile(loadTrace()).authModel;
    expect(evidence?.status).toBe("unverifiable");
    if (evidence?.status === "unverifiable") {
      expect(evidence.reason).toContain("cannot enumerate what else it supports");
    }
    // The `unverifiable` arm carries no value at all — unverified lore is
    // unrepresentable, not merely discouraged.
    expect("value" in (evidence ?? {})).toBe(false);
  });

  it("verifies dcrIdentity and flags the User-Agent expressiveness gap", () => {
    const evidence = traceToOAuthProfile(loadTrace()).dcrIdentity;
    expect(evidence?.status).toBe("verified");
    if (evidence?.status === "verified") {
      expect(evidence.value.clientName).toBe("MCPJam SDK OAuth Conformance");
      expect(evidence.value.redirectUris).toEqual([
        "http://127.0.0.1:{port}/callback",
      ]);
      // MCPJam's OAuth runs in a browser, which forbids scripts from setting
      // User-Agent — so there is nothing to record, and the target type has no way
      // to distinguish that from "we didn't look". The caveat says so out loud.
      expect(evidence.value.userAgent).toBeUndefined();
      expect(evidence.source).toContain("no single `User-Agent`");
      expect(evidence.source).toContain("`{port}`");
    }
  });

  it("preserves every observation the target type cannot express", () => {
    // A schema gap must never cost a finding.
    const extensions = traceToOAuthProfile(loadTrace()).extensions as Record<
      string,
      unknown
    >;

    expect(Object.keys(extensions).sort()).toEqual([
      "tracePkce",
      "traceAuthPath",
      "traceDcrIdentity",
      "traceProtocolVersion",
      "traceProvenance",
      "traceResourceIndicator",
      "traceUserAgent",
    ].sort());

    // The two-headed protocol-version finding survives whole, even though
    // `protocolVersionPinning` could only carry one arm of it.
    const pv = extensions.traceProtocolVersion as Record<string, unknown>;
    expect(pv.initializeBody).toEqual({ state: "present", value: "2025-11-25" });
    expect(pv.headerOnMcpTraffic).toEqual({
      state: "present",
      value: ["2025-11-25"],
    });
    expect(pv.wiresDisagree).toBe(false);

    // Provenance points back at the artifact, including the staleness stamp.
    const provenance = extensions.traceProvenance as Record<string, unknown>;
    expect(provenance.traceId).toBe(
      "mcpjam/in-memory-dcr-authcode-prm/2026-07-29/emulator",
    );
    expect(provenance.oauthImplementation).toEqual({
      state: "present",
      value: { kind: "first-party" },
    });
  });

  it("marks dcrIdentity unverifiable when no registration happened", () => {
    const trace = loadTrace();
    const noDcr = reobserve({
      ...trace,
      wire: trace.wire.filter((exchange) => exchange.leg !== "dcr-register"),
    });

    const evidence = traceToOAuthProfile(noDcr).dcrIdentity;
    expect(evidence?.status).toBe("unverifiable");
    if (evidence?.status === "unverifiable") {
      // And the reason explains that this may be correct rather than a failure.
      expect(evidence.reason).toContain("CIMD or a pre-registered client_id");
    }
  });
});
