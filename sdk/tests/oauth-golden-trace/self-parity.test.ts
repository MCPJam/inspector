/**
 * HP-44 — the self-diff that proves the oracle.
 *
 * `mcpjam` is first-party, fully source-verified, and runnable end to end today,
 * so it is the one host whose golden trace we can produce without a proxy or a
 * credential. Diffing a fresh emulator run against a COMMITTED golden trace of
 * ourselves establishes three things no amount of design review could:
 *
 *   1. the capture path works against real state-machine code, not a mock;
 *   2. the normalizer actually removes every run-to-run volatile value — if it
 *      missed one, two runs of identical code would report a difference;
 *   3. the differ reports parity when parity holds.
 *
 * And the negative tests below establish the fourth, which is the one that
 * matters most: the differ reports a DIFFERENCE when behavior actually diverges.
 * A differ that always returns green would pass every test above.
 *
 * Regenerate the fixture with:
 *   HP44_WRITE_FIXTURE=1 npx vitest run tests/oauth-golden-trace/self-parity.test.ts
 * Regeneration is a deliberate, explicit act: a fixture that silently rewrites
 * itself on every run is not evidence of anything.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OAuthConformanceTest } from "../../src/oauth-conformance/index.js";
import {
  captureEmulatorTrace,
  deriveObservations,
  diffGoldenTraces,
  findObservationDrift,
  findRedactionViolations,
  formatTraceDiffHuman,
  observedValue,
  withObservedLoopbackPorts,
} from "../../src/oauth-golden-trace/index.js";
import type {
  GoldenTrace,
  TraceExchange,
} from "../../src/oauth-golden-trace/index.js";
import { createScenarioFixture } from "./scenario.js";
import type { ScenarioOverrides } from "./scenario.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(
  HERE,
  "..",
  "fixtures",
  "golden-traces",
  "mcpjam-in-memory-dcr-authcode-prm.json",
);

/** Fixed so the artifact is reproducible rather than stamped with "today". */
const CAPTURED_AT = "2026-07-29";

async function captureSelfTrace(
  overrides: ScenarioOverrides = {},
): Promise<GoldenTrace> {
  const fixture = createScenarioFixture(overrides);
  const test = new OAuthConformanceTest(fixture.config, fixture.deps as never);
  const result = await test.run();

  expect(result.passed).toBe(true);

  return captureEmulatorTrace({
    result,
    hostId: "mcpjam",
    scenario: fixture.scenario,
    capturedAt: CAPTURED_AT,
    stateMachine: "debug-oauth-2025-11-25",
    notes: [
      "Captured in-process against the in-memory scenario in tests/oauth-golden-trace/scenario.ts. No network, no credentials.",
    ],
  });
}

/**
 * The committed golden trace, with its volatile stamp neutralized.
 *
 * `subject.hostVersion` and `capture.method.sdkVersion` are the SDK version,
 * which changes on every release. Pinning them into the fixture would make this
 * test fail on every version bump for no behavioral reason — so they are
 * normalized for the comparison and asserted separately.
 */
function neutralizeVersionStamp(trace: GoldenTrace): GoldenTrace {
  return {
    ...trace,
    subject: {
      ...trace.subject,
      hostVersion: { state: "present", value: "{sdk_version}" },
    },
    capture: {
      ...trace.capture,
      method:
        trace.capture.method.via === "mcpjam-emulator"
          ? { ...trace.capture.method, sdkVersion: "{sdk_version}" }
          : trace.capture.method,
    },
  };
}

describe("HP-44 golden-trace self-parity", () => {
  it("captures mcpjam against itself and matches the committed golden trace", async () => {
    const captured = await captureSelfTrace();

    if (process.env.HP44_WRITE_FIXTURE === "1") {
      mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
      writeFileSync(
        FIXTURE_PATH,
        `${JSON.stringify(neutralizeVersionStamp(captured), null, 2)}\n`,
        "utf8",
      );
    }

    expect(existsSync(FIXTURE_PATH)).toBe(true);
    const golden = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as GoldenTrace;

    const diff = diffGoldenTraces(
      golden,
      neutralizeVersionStamp(captured),
      { mode: "drift" },
    );

    if (!diff.parity) {
      // eslint-disable-next-line no-console
      console.error(formatTraceDiffHuman(diff));
    }

    expect(diff.counts.difference).toBe(0);
    expect(diff.counts.incomparable).toBe(0);
    expect(diff.parity).toBe(true);
  });

  it("produces byte-identical traces across two runs, proving normalization is complete", async () => {
    // The strongest statement the normalizer can make about itself. Any leaked
    // nonce, state, PKCE value, timestamp or ephemeral port would break this.
    const first = neutralizeVersionStamp(await captureSelfTrace());
    const second = neutralizeVersionStamp(await captureSelfTrace());

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("records no live secrets", async () => {
    const captured = await captureSelfTrace();
    expect(findRedactionViolations(captured)).toEqual([]);

    // The token, code and verifier were all real values on the wire; assert they
    // are gone rather than trusting the shape-based scan alone.
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain("hp44-access-token-value");
    expect(serialized).not.toContain("hp44-refresh-token-value");
    expect(serialized).not.toContain("hp44-authorization-code");
  });

  it("keeps the committed fixture's observations derivable from its own wire", () => {
    const golden = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as GoldenTrace;
    // Guards against a hand-edited trace: observations must still follow from the
    // wire they claim to summarize.
    expect(findObservationDrift(golden)).toEqual([]);
  });

  it("captures the facts HP-44 exists to settle", async () => {
    const trace = await captureSelfTrace();
    const { protocolVersion, resourceIndicator, dcrIdentity, pkce } =
      trace.observations;

    // The two-headed protocol-version field, recorded as two fields.
    expect(protocolVersion.initializeBody).toEqual({
      state: "present",
      value: "2025-11-25",
    });
    expect(protocolVersion.headerOnOAuthDiscovery).toEqual({
      state: "present",
      value: ["2025-11-25"],
    });
    expect(protocolVersion.headerOnMcpTraffic).toEqual({
      state: "present",
      value: ["2025-11-25"],
    });
    // MCPJam agrees across both wires — unlike Goose, which is the whole reason
    // these are separate fields.
    expect(protocolVersion.wiresDisagree).toBe(false);

    // RFC 8707 on both legs, which is the claim four hosts got wrong.
    expect(resourceIndicator.onAuthorize.state).toBe("present");
    expect(resourceIndicator.onToken.state).toBe("present");

    expect(dcrIdentity.clientName).toEqual({
      state: "present",
      value: "MCPJam SDK OAuth Conformance",
    });
    // The loopback port is placeheld in the wire but retained as a finding.
    expect(dcrIdentity.redirectUris).toEqual({
      state: "present",
      value: ["http://127.0.0.1:{port}/callback"],
    });
    expect(dcrIdentity.observedLoopbackPorts).toEqual({
      state: "present",
      value: [33418],
    });

    // Shape survived the placeholder: 43 chars is S256 over a 32-byte verifier.
    expect(pkce.challengeMethod).toEqual({ state: "present", value: "S256" });
    expect(pkce.challengeLength).toEqual({ state: "present", value: 43 });
  });

  it("reports the /authorize headers as unobserved, not absent", async () => {
    const trace = await captureSelfTrace();

    // The client hands the authorize URL to a browser, so its headers were never
    // on a wire we recorded. Claiming `absent` here would be a fabricated finding
    // — and would then "differ" from any proxy capture that did see them.
    expect(trace.observations.protocolVersion.headerByLeg.authorize?.state).toBe(
      "not-observed",
    );
    expect(trace.observations.userAgent.byLeg.authorize?.state).toBe(
      "not-observed",
    );

    // The params, by contrast, ARE fully known — they are in the URL.
    const authorize = trace.wire.find((exchange) => exchange.leg === "authorize");
    expect(authorize?.request.query?.resource).toEqual([
      "https://mcp.example.test/mcp".replace(
        "https://mcp.example.test",
        "{mcp_server}",
      ),
    ]);
    expect(authorize?.request.query?.code_challenge_method).toEqual(["S256"]);
  });
});

/**
 * Rewrite a trace's wire and re-derive its observations, producing a trace of a
 * HYPOTHETICAL client that behaves differently.
 *
 * Perturbing the artifact rather than the server stub is the right level: the
 * stub only sees what the emulator sends, so mutating it there cannot change what
 * the emulator RECORDS, and the diff would come out green no matter what the stub
 * did. Perturbing the trace is also a truer simulation of the real case — a
 * golden trace from another host arrives as an artifact, not as a live client.
 *
 * Observations are re-derived rather than hand-edited so the perturbed trace stays
 * internally consistent, which `findObservationDrift` would otherwise flag.
 */
function perturb(
  trace: GoldenTrace,
  mutate: (wire: TraceExchange[]) => TraceExchange[],
): GoldenTrace {
  const wire = mutate(
    JSON.parse(JSON.stringify(trace.wire)) as TraceExchange[],
  ).map((exchange, index) => ({ ...exchange, ordinal: index }));

  return {
    ...trace,
    subject: { ...trace.subject, kind: "real-host" },
    wire,
    observations: withObservedLoopbackPorts(
      deriveObservations({ wire, scenario: trace.scenario }),
      observedValue(trace.observations.dcrIdentity.observedLoopbackPorts) ?? [],
    ),
  };
}

describe("HP-44 oracle is not vacuous", () => {
  /**
   * Each case describes a client that diverges in one specific way, then asserts
   * the differ catches it in the right dimension. Without these, every test above
   * would still pass against a differ hardcoded to return parity.
   */
  it("catches a dropped RFC 8707 `resource` param", async () => {
    const candidate = await captureSelfTrace();
    // A "real host" that omits `resource` on both legs — the exact claim that was
    // asserted about Claude and ChatGPT and turned out to be false for both.
    const golden = perturb(candidate, (wire) =>
      wire.map((exchange) => {
        if (exchange.request.query?.resource) delete exchange.request.query.resource;
        if (exchange.request.body?.encoding === "form") {
          delete exchange.request.body.fields.resource;
        }
        return exchange;
      }),
    );

    const diff = diffGoldenTraces(golden, candidate);
    expect(diff.parity).toBe(false);

    expect(
      diff.findings.filter(
        (finding) =>
          finding.dimension === "resource-indicator" &&
          finding.severity === "difference",
      ).length,
    ).toBeGreaterThan(0);

    const onToken = diff.findings.find(
      (finding) => finding.path === "observations.resourceIndicator.onToken",
    );
    expect(onToken?.severity).toBe("difference");
    // The message names which side sends it, so a reviewer knows the direction.
    expect(onToken?.message).toContain("the real host sends nothing");
  });

  it("catches a different `MCP-Protocol-Version` on the OAuth wire only", async () => {
    const candidate = await captureSelfTrace();
    // Exactly the `rmcp` shape: 2024-11-05 hardcoded on OAuth discovery while the
    // MCP wire negotiates something newer. If the harness collapsed the two wires
    // into one field, this test could not exist.
    const golden = perturb(candidate, (wire) =>
      wire.map((exchange) => {
        if (
          exchange.leg === "prm-discovery" ||
          exchange.leg === "as-metadata-discovery"
        ) {
          if (exchange.request.headers["mcp-protocol-version"]) {
            exchange.request.headers["mcp-protocol-version"] = "2024-11-05";
          }
        }
        return exchange;
      }),
    );

    const diff = diffGoldenTraces(golden, candidate);
    expect(diff.parity).toBe(false);

    const discovery = diff.findings.find(
      (finding) =>
        finding.path === "observations.protocolVersion.headerOnOAuthDiscovery",
    );
    expect(discovery?.severity).toBe("difference");

    // The MCP wire must still MATCH. The point is that the two wires are tracked
    // apart — not that a change anywhere trips everything.
    const mcpWire = diff.findings.find(
      (finding) =>
        finding.path === "observations.protocolVersion.headerOnMcpTraffic",
    );
    expect(mcpWire?.severity).toBe("match");

    // And the split-revision flag flips, which is the legible one-line summary.
    expect(golden.observations.protocolVersion.wiresDisagree).toBe(true);
    expect(candidate.observations.protocolVersion.wiresDisagree).toBe(false);
    expect(
      diff.findings.find(
        (finding) =>
          finding.path === "observations.protocolVersion.wiresDisagree",
      )?.severity,
    ).toBe("difference");
  });

  it("catches a client that sends the header on OAuth discovery but not on MCP traffic", async () => {
    // The VS Code shape. `absent` vs `present` must be a DIFFERENCE, not a gap —
    // "sends nothing here" is a positive, citable finding.
    const candidate = await captureSelfTrace();
    const golden = perturb(candidate, (wire) =>
      wire.map((exchange) => {
        if (
          exchange.leg === "mcp-initialize" ||
          exchange.leg === "mcp-authenticated" ||
          exchange.leg === "mcp-unauthenticated"
        ) {
          delete exchange.request.headers["mcp-protocol-version"];
        }
        return exchange;
      }),
    );

    expect(golden.observations.protocolVersion.headerOnMcpTraffic.state).toBe(
      "absent",
    );

    const diff = diffGoldenTraces(golden, candidate);
    const mcpWire = diff.findings.find(
      (finding) =>
        finding.path === "observations.protocolVersion.headerOnMcpTraffic",
    );
    expect(mcpWire?.severity).toBe("difference");
    expect(mcpWire?.golden).toBe("<absent on the wire>");
  });

  it("catches a changed DCR client_name", async () => {
    const candidate = await captureSelfTrace();
    const golden = perturb(candidate, (wire) =>
      wire.map((exchange) => {
        if (
          exchange.leg === "dcr-register" &&
          exchange.request.body?.encoding === "json"
        ) {
          const json = exchange.request.body.json as Record<string, unknown>;
          json.client_name = "Some Other Client";
        }
        return exchange;
      }),
    );

    const diff = diffGoldenTraces(golden, candidate);
    expect(diff.parity).toBe(false);
    const clientName = diff.findings.find(
      (finding) => finding.path === "observations.dcrIdentity.clientName",
    );
    expect(clientName?.severity).toBe("difference");
    expect(clientName?.dimension).toBe("dcr-body");
  });

  it("catches reordered legs — a client that tries OAuth before probing unauthenticated", async () => {
    // Goose connects unauthenticated FIRST and falls back to OAuth on a 401, the
    // opposite ordering from Claude and ChatGPT. Ordering is a finding, so it is
    // compared rather than merely displayed.
    const candidate = await captureSelfTrace();
    const golden = perturb(candidate, (wire) => [
      ...wire.filter((exchange) => exchange.leg !== "mcp-unauthenticated"),
      ...wire.filter((exchange) => exchange.leg === "mcp-unauthenticated"),
    ]);

    const diff = diffGoldenTraces(golden, candidate);
    expect(diff.parity).toBe(false);
    const ordering = diff.findings.find(
      (finding) => finding.path === "observations.legOrder",
    );
    expect(ordering?.severity).toBe("difference");
    expect(ordering?.dimension).toBe("request-ordering");
  });

  it("does NOT flag differing ephemeral loopback ports as a difference", async () => {
    // Two runs of the same client legitimately differ here. A `difference` would
    // make every diff fail for a reason nobody can act on.
    const candidate = await captureSelfTrace();
    const golden: GoldenTrace = {
      ...candidate,
      subject: { ...candidate.subject, kind: "real-host" },
      observations: {
        ...candidate.observations,
        dcrIdentity: {
          ...candidate.observations.dcrIdentity,
          observedLoopbackPorts: { state: "present", value: [51999] },
        },
      },
    };

    const diff = diffGoldenTraces(golden, candidate);
    const ports = diff.findings.find(
      (finding) =>
        finding.path === "observations.dcrIdentity.observedLoopbackPorts",
    );
    expect(ports?.severity).toBe("match");
    expect(ports?.message).toContain("context, not a parity difference");
    expect(diff.parity).toBe(true);
  });

  it("refuses to compare traces captured against different scenarios", async () => {
    const candidate = await captureSelfTrace();
    // Same host, but the golden side was captured against a server publishing no
    // PRM document. A client that omits `resource` when PRM discovery fails is
    // behaving CORRECTLY, so reporting the resulting field differences as parity
    // failures would be the harness lying about a conformant client.
    const golden: GoldenTrace = {
      ...candidate,
      subject: { ...candidate.subject, kind: "real-host" },
      scenario: {
        ...candidate.scenario,
        capabilities: {
          ...candidate.scenario.capabilities,
          publishesPrm: false,
          prmResource: undefined,
        },
      },
    };

    const diff = diffGoldenTraces(golden, candidate);
    expect(diff.counts.incomparable).toBeGreaterThan(0);
    expect(diff.parity).toBe(false);
    expect(diff.findings[0].dimension).toBe("scenario");
    // Exactly one blocking finding, not a cascade of forty bogus ones.
    expect(diff.findings.length).toBe(1);
  });

  it("refuses to compare traces of different hosts", async () => {
    const candidate = await captureSelfTrace();
    const golden: GoldenTrace = {
      ...candidate,
      subject: { ...candidate.subject, kind: "real-host", hostId: "vscode" },
    };

    const diff = diffGoldenTraces(golden, candidate);
    expect(diff.counts.incomparable).toBeGreaterThan(0);
    expect(
      diff.findings.some((finding) => finding.path === "subject.hostId"),
    ).toBe(true);
  });

  it("reports a gap, never a match, when one side never observed a leg", async () => {
    const candidate = await captureSelfTrace();
    const golden = perturb(candidate, (wire) =>
      wire.filter((exchange) => exchange.leg !== "token"),
    );

    const diff = diffGoldenTraces(golden, candidate);
    const onToken = diff.findings.find(
      (finding) => finding.path === "observations.resourceIndicator.onToken",
    );
    expect(onToken?.severity).toBe("gap");
    expect(diff.counts.gap).toBeGreaterThan(0);

    // A gap does not fail parity: our own missing capture is not evidence the
    // emulator diverged. But it is counted, and callers needing full coverage
    // assert on it.
    expect(
      diff.findings.filter((finding) => finding.severity === "gap").length,
    ).toBeGreaterThan(0);
  });

  it("flags a golden trace that cannot name the dependency version that produced it", async () => {
    const candidate = await captureSelfTrace();
    const golden: GoldenTrace = {
      ...candidate,
      subject: {
        ...candidate.subject,
        kind: "real-host",
        oauthImplementation: {
          state: "not-observed",
          reason: "no resolved OAuth implementation was supplied at ingest",
        },
      },
    };

    const diff = diffGoldenTraces(golden, candidate);
    const stamp = diff.findings.find((finding) =>
      finding.path.startsWith("subject.oauthImplementation"),
    );
    expect(stamp?.severity).toBe("gap");
    expect(stamp?.message).toContain("dependency");
  });
});
