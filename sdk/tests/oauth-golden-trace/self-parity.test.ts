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
  classifyLeg,
  deriveObservations,
  diffGoldenTraces,
  findObservationDrift,
  findRedactionViolations,
  formatHarIngestReportHuman,
  formatTraceDiffHuman,
  formatTraceSummaryHuman,
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

  it("reports drift from an ADDED observation key, not just a changed one", () => {
    // The drift walk used to iterate the DERIVED shape's keys only, so a tamper
    // whose sole edit was an extra top-level key produced an empty array — and
    // empty reads as "clean" to `readTrace`, which then trusts the trace.
    const golden = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as GoldenTrace;
    const tampered = {
      ...golden,
      observations: {
        ...golden.observations,
        smuggledConclusion: { state: "present", value: "definitely conformant" },
      },
    } as unknown as GoldenTrace;

    const drift = findObservationDrift(tampered);
    expect(drift).not.toEqual([]);
    expect(drift.join("\n")).toContain("smuggledConclusion");
    expect(drift.join("\n")).toContain("added by hand");
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
    // these are separate fields. `present: false`, not a bare `false`: both wires
    // were captured, which is what makes "they agree" a claim we can make.
    expect(protocolVersion.wiresDisagree).toEqual({
      state: "present",
      value: false,
    });

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
   * One baseline capture, shared by every case below.
   *
   * Every `captureSelfTrace()` call runs a full handshake through the real state
   * machine, and no case here needs a FRESH one: each either mutates through
   * `perturb`, which deep-clones `trace.wire` before the mutator ever sees it, or
   * builds its `golden` by spreading NEW objects over the baseline. `perturb`,
   * `deriveObservations`, `withObservedLoopbackPorts` and `diffGoldenTraces` are all
   * pure with respect to their inputs, which is what makes one capture enough.
   *
   * The tests that are ABOUT what a fresh capture produces — the byte-identical
   * re-capture and the redaction scan in the suite above — keep their own calls,
   * since a shared artifact cannot say anything about two independent runs.
   */
  let baseline: GoldenTrace;
  /** Serialized once, so the guard below compares against the pristine capture. */
  let baselineJson: string;

  beforeAll(async () => {
    baseline = await captureSelfTrace();
    baselineJson = JSON.stringify(baseline);
  });

  /**
   * The shared fixture's whole risk, checked rather than assumed.
   *
   * A case that mutated the baseline in place instead of going through `perturb`
   * would corrupt every case scheduled after it — passing or failing depending on
   * run order, which is the worst failure mode a suite can have. This turns that
   * into an immediate, named failure in the case that caused it.
   */
  afterEach(() => {
    expect(JSON.stringify(baseline)).toBe(baselineJson);
  });

  /**
   * Each case describes a client that diverges in one specific way, then asserts
   * the differ catches it in the right dimension. Without these, every test above
   * would still pass against a differ hardcoded to return parity.
   */
  it("catches a dropped RFC 8707 `resource` param", () => {
    const candidate = baseline;
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

  it("catches a different `MCP-Protocol-Version` on the OAuth wire only", () => {
    const candidate = baseline;
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
    expect(golden.observations.protocolVersion.wiresDisagree).toEqual({
      state: "present",
      value: true,
    });
    expect(candidate.observations.protocolVersion.wiresDisagree).toEqual({
      state: "present",
      value: false,
    });
    expect(
      diff.findings.find(
        (finding) =>
          finding.path === "observations.protocolVersion.wiresDisagree",
      )?.severity,
    ).toBe("difference");
  });

  it("catches a client that sends the header on OAuth discovery but not on MCP traffic", () => {
    // The VS Code shape. `absent` vs `present` must be a DIFFERENCE, not a gap —
    // "sends nothing here" is a positive, citable finding.
    const candidate = baseline;
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

  it("catches a changed DCR client_name", () => {
    const candidate = baseline;
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

  it("catches reordered legs — a client that tries OAuth before probing unauthenticated", () => {
    // Goose connects unauthenticated FIRST and falls back to OAuth on a 401, the
    // opposite ordering from Claude and ChatGPT. Ordering is a finding, so it is
    // compared rather than merely displayed.
    const candidate = baseline;
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

  it("does NOT flag differing ephemeral loopback ports as a difference", () => {
    // Two runs of the same client legitimately differ here. A `difference` would
    // make every diff fail for a reason nobody can act on.
    const candidate = baseline;
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

  it("refuses to compare traces captured against different scenarios", () => {
    const candidate = baseline;
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

  it("refuses to compare traces of different hosts", () => {
    const candidate = baseline;
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

  it("reports a gap, never a match, when one side never observed a leg", () => {
    const candidate = baseline;
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

  it("reports a per-leg header only one side ever recorded as a gap, not as silence", () => {
    const candidate = baseline;
    // A golden capture that stopped before the MCP handshake. Its `headerByLeg`
    // then has no `mcp-initialize` KEY AT ALL — and a missing map key used to make
    // the differ skip the comparison, dropping exactly the asymmetry a reviewer
    // most wants named.
    const golden = perturb(candidate, (wire) =>
      wire.filter((exchange) => exchange.leg !== "mcp-initialize"),
    );
    expect(
      "mcp-initialize" in golden.observations.protocolVersion.headerByLeg,
    ).toBe(false);

    const diff = diffGoldenTraces(golden, candidate);

    const header = diff.findings.find(
      (finding) =>
        finding.path === "observations.protocolVersion.headerByLeg.mcp-initialize",
    );
    expect(header?.severity).toBe("gap");
    expect(String(header?.golden)).toContain("records no `mcp-initialize` leg");

    const ua = diff.findings.find(
      (finding) => finding.path === "observations.userAgent.byLeg.mcp-initialize",
    );
    expect(ua?.severity).toBe("gap");
  });

  it("does not report endpoints beyond a truncated capture as both a gap and a difference", () => {
    const candidate = baseline;
    // A golden capture that BOTH stopped early (no /token, no initialize) and hit a
    // discovery path the candidate does not. The second condition is what used to
    // skip the early return and report the beyond-truncation extras a second time
    // as a difference — failing parity on the very artifact the gap excuses.
    const golden = perturb(candidate, (wire) =>
      wire
        .filter(
          (exchange) =>
            exchange.leg !== "token" && exchange.leg !== "mcp-initialize",
        )
        .map((exchange) => {
          if (exchange.leg === "as-metadata-discovery") {
            exchange.request.url = exchange.request.url.replace(
              "/.well-known/oauth-authorization-server",
              "/.well-known/openid-configuration",
            );
          }
          return exchange;
        }),
    );

    const diff = diffGoldenTraces(golden, candidate);
    const endpoints = diff.findings.filter(
      (finding) => finding.path === "observations.endpointsHit",
    );

    // The extras are excused exactly once, as a gap...
    const gaps = endpoints.filter((finding) => finding.severity === "gap");
    expect(gaps.length).toBe(1);
    expect(gaps[0].message).toContain("beyond where the golden capture stopped");

    // ...and never re-reported as a difference. Missing endpoints, which the golden
    // side demonstrably DID hit, are still reported on their own.
    const differences = endpoints.filter(
      (finding) => finding.severity === "difference",
    );
    expect(differences.length).toBe(1);
    expect(differences[0].message).toContain("never hit");
    expect(differences[0].candidate).toBe(null);
  });

  it("catches a param that differs only on a RETRY inside a leg", () => {
    const captured = baseline;
    // Both sides retry /token; only the golden side's SECOND attempt differs.
    // Comparing occurrence 0 alone reported parity for this.
    const withTokenRetry = (mutate: (retry: TraceExchange) => void): GoldenTrace =>
      perturb(captured, (wire) => {
        const out: TraceExchange[] = [];
        for (const exchange of wire) {
          out.push(exchange);
          if (exchange.leg !== "token") continue;
          const retry = JSON.parse(JSON.stringify(exchange)) as TraceExchange;
          mutate(retry);
          out.push(retry);
        }
        return out;
      });

    const golden = withTokenRetry((retry) => {
      if (retry.request.body?.encoding === "form") {
        retry.request.body.fields.scope = ["mcp:read"];
      }
    });
    const candidate = withTokenRetry(() => {});

    const diff = diffGoldenTraces(golden, candidate);
    expect(diff.parity).toBe(false);

    // The retry is compared under a `#1` slot...
    const retryField = diff.findings.find(
      (finding) => finding.path === "wire[leg=token#1].request.body.scope",
    );
    expect(retryField?.severity).toBe("difference");
    expect(retryField?.message).toContain("(occurrence 2)");

    // ...while the FIRST occurrence keeps its bare path and still matches, so the
    // common single-request case reads exactly as it always did.
    expect(
      diff.findings.find(
        (finding) => finding.path === "wire[leg=token].request.body.grant_type",
      )?.severity,
    ).toBe("match");
  });

  it("reports an unequal occurrence count rather than pairing mismatched attempts", () => {
    const candidate = baseline;
    const golden = perturb(candidate, (wire) => {
      const out: TraceExchange[] = [];
      for (const exchange of wire) {
        out.push(exchange);
        if (exchange.leg === "token") {
          out.push(JSON.parse(JSON.stringify(exchange)) as TraceExchange);
        }
      }
      return out;
    });

    const diff = diffGoldenTraces(golden, candidate);
    const occurrences = diff.findings.find(
      (finding) => finding.path === "wire[leg=token].occurrences",
    );
    expect(occurrences?.severity).toBe("difference");
    expect(occurrences?.golden).toBe(2);
    expect(occurrences?.candidate).toBe(1);
  });

  it("catches a changed VALUE of a DCR field this schema does not model", () => {
    const candidate = baseline;
    // `client_uri` is real, sent, and unmodelled. Retaining only field NAMES made
    // two register bodies that differ here report DCR parity — the JSON body is not
    // compared field by field anywhere else, so nothing else would catch it.
    const golden = perturb(candidate, (wire) =>
      wire.map((exchange) => {
        if (
          exchange.leg === "dcr-register" &&
          exchange.request.body?.encoding === "json"
        ) {
          const json = exchange.request.body.json as Record<string, unknown>;
          json.client_uri = "https://example.invalid/some-other-client";
        }
        return exchange;
      }),
    );

    const diff = diffGoldenTraces(golden, candidate);
    expect(diff.parity).toBe(false);
    const extra = diff.findings.find(
      (finding) => finding.path === "observations.dcrIdentity.extraFields",
    );
    expect(extra?.severity).toBe("difference");
    expect(extra?.dimension).toBe("dcr-body");
  });

  it("flags a golden trace that cannot name the dependency version that produced it", () => {
    const candidate = baseline;
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

/**
 * The derivation's own honesty rules, checked at the observation level.
 *
 * These are upstream of the differ: each one is a case where the summary used to
 * state something the capture could not support, and where the differ would then
 * faithfully report a fabricated finding.
 */
describe("HP-44 observations claim only what the capture supports", () => {
  it("does not read a malformed DCR field as an omitted one", async () => {
    const clean = await captureSelfTrace();
    const malformed = perturb(clean, (wire) =>
      wire.map((exchange) => {
        if (
          exchange.leg === "dcr-register" &&
          exchange.request.body?.encoding === "json"
        ) {
          (exchange.request.body.json as Record<string, unknown>).client_name = 42;
        }
        return exchange;
      }),
    );

    const dcr = malformed.observations.dcrIdentity;
    // NOT `absent`. `absent` would assert the client omitted `client_name`, which
    // it demonstrably did not.
    expect(dcr.clientName.state).toBe("not-observed");
    if (dcr.clientName.state === "not-observed") {
      expect(dcr.clientName.reason).toContain("a number, not a string");
    }
    expect(dcr.malformedFields).toEqual({
      state: "present",
      value: ["client_name"],
    });

    // And the differ names the malformed field as the difference, while the field
    // itself is a gap rather than "the emulator sends a value the host does not".
    const diff = diffGoldenTraces(malformed, clean);
    expect(
      diff.findings.find(
        (finding) => finding.path === "observations.dcrIdentity.malformedFields",
      )?.severity,
    ).toBe("difference");
    expect(
      diff.findings.find(
        (finding) => finding.path === "observations.dcrIdentity.clientName",
      )?.severity,
    ).toBe("gap");
  });

  it("refuses to read PKCE evidence out of an opaque /token body", async () => {
    const structured = await captureSelfTrace();
    expect(structured.observations.pkce.verifierSentOnToken).toEqual({
      state: "present",
      value: true,
    });

    const opaque = perturb(structured, (wire) =>
      wire.map((exchange) => {
        if (exchange.leg === "token") {
          exchange.request.body = {
            encoding: "opaque",
            contentType: "application/x-www-form-urlencoded",
            byteLength: 321,
          };
        }
        return exchange;
      }),
    );

    // A body we could not parse is not a body that lacked `code_verifier`.
    // Reporting `false` here would manufacture "this client skips PKCE".
    expect(opaque.observations.pkce.verifierSentOnToken.state).toBe("not-observed");

    const diff = diffGoldenTraces(opaque, structured);
    expect(
      diff.findings.find(
        (finding) => finding.path === "observations.pkce.verifierSentOnToken",
      )?.severity,
    ).toBe("gap");
  });

  it("cannot claim User-Agent consistency over a leg whose headers were reconstructed", async () => {
    const trace = await captureSelfTrace();
    // The client hands /authorize to a browser, so that leg carries no observed
    // headers at all — which makes "one UA across every leg" unsayable rather than
    // true.
    expect(trace.observations.userAgent.consistent.state).toBe("not-observed");

    const diff = diffGoldenTraces(
      { ...trace, subject: { ...trace.subject, kind: "real-host" } },
      trace,
    );
    expect(
      diff.findings.find(
        (finding) => finding.path === "observations.userAgent.consistent",
      )?.severity,
    ).toBe("gap");
    // A gap, never a difference: two identical traces must not disagree here.
    expect(diff.parity).toBe(true);
  });

  it("does not pull a same-origin sibling endpoint into the MCP wire", () => {
    const mcpServerUrl = "https://mcp.example.test/mcp";
    const legOf = (url: string): string =>
      classifyLeg({ method: "POST", url, headers: {}, mcpServerUrl }).leg;

    expect(legOf("https://mcp.example.test/mcp")).toBe("mcp-unauthenticated");
    expect(legOf("https://mcp.example.test/mcp/")).toBe("mcp-unauthenticated");
    // A descendant of the endpoint still belongs to it.
    expect(legOf("https://mcp.example.test/mcp/messages")).toBe(
      "mcp-unauthenticated",
    );
    // `/mcp-admin` shares every character of `/mcp` and is a DIFFERENT endpoint.
    // Misclassifying it drags its headers into the MCP-wire rollups, where it can
    // flip `headerOnMcpTraffic` from `absent` — a citable finding — to `present`.
    expect(legOf("https://mcp.example.test/mcp-admin")).toBe("unknown");
    expect(legOf("https://mcp.example.test/mcpx")).toBe("unknown");
    // And the same path on another origin is not this server.
    expect(legOf("https://other.example.test/mcp")).toBe("unknown");
  });
});

/**
 * What the human report is allowed to SAY.
 *
 * Both cases here were the report asserting something the artifact does not: an
 * emulator that was never part of a drift comparison, and a credential rendered
 * out of a URL the trace itself had redacted.
 */
describe("HP-44 human rendering states only what the diff found", () => {
  it("never names an emulator in a drift diff of two same-kind captures", async () => {
    const captured = await captureSelfTrace();
    const asRealHost: GoldenTrace = {
      ...captured,
      subject: { ...captured.subject, kind: "real-host" },
    };
    // HP-38's shape: the SAME subject captured twice. There is no emulator on
    // either side, so blaming one would be a fabricated finding.
    const drift = diffGoldenTraces(asRealHost, {
      ...asRealHost,
      traceId: `${asRealHost.traceId}/recaptured`,
    });
    expect(drift.mode).toBe("drift");

    const rendered = formatTraceDiffHuman(drift);
    expect(rendered).toContain("drift diff");
    expect(rendered).toContain("golden (baseline capture)");
    expect(rendered).toContain("candidate (re-capture)");
    // Every value line and every message, with the trace ids removed — those carry
    // the subject kind in their own text and are not the report's own prose.
    const prose = rendered
      .split("\n")
      .filter(
        (line) =>
          !line.includes(drift.goldenTraceId) &&
          !line.includes(drift.candidateTraceId),
      )
      .join("\n");
    expect(prose).toContain("baseline capture:");
    expect(prose).toContain("re-capture:");
    expect(prose).not.toContain("emulator");
    expect(prose).not.toContain("real host");

    // Parity mode keeps its concrete wording, where both labels are true.
    const parity = formatTraceDiffHuman(
      diffGoldenTraces(asRealHost, captured, { mode: "parity" }),
    );
    expect(parity).toContain("golden (real host)");
    expect(parity).toContain("candidate (emulator)");
  });

  it("distinguishes `absent` from `not-observed` in the one-line summary", async () => {
    const trace = await captureSelfTrace();
    const summaryOf = (subject: GoldenTrace["subject"]): string =>
      formatTraceSummaryHuman({ ...trace, subject });

    expect(
      summaryOf({ ...trace.subject, hostVersion: { state: "absent" } }),
    ).toContain("no version exposed");
    expect(
      summaryOf({
        ...trace.subject,
        hostVersion: { state: "not-observed", reason: "nobody read it" },
      }),
    ).toContain("version not observed");
  });

  it("renders a dropped HAR entry's origin and path, never its query string", () => {
    // A dropped entry never went through the normalizer, so its query may still
    // carry a live credential. The trace is redacted; this report must not undo it.
    const rendered = formatHarIngestReportHuman({
      totalEntries: 2,
      keptEntries: 1,
      dropped: [
        {
          url: "https://vendor.example/callback?code=hp44-live-code&state=abc#frag",
          reason: "not on a scenario origin",
        },
      ],
      missingLegs: [],
      warnings: [],
    });

    expect(rendered).toContain("https://vendor.example/callback");
    expect(rendered).not.toContain("hp44-live-code");
    expect(rendered).not.toContain("code=");
    expect(rendered).not.toContain("frag");
  });
});
