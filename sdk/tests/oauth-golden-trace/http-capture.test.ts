/**
 * HP-44 — cross-validate the two capture paths on one handshake.
 *
 * The harness has two independent ways to record a dance: `captureEmulatorTrace*`
 * reads the client's own `httpHistory`, and `captureHarTrace` reads a HAR. If they
 * disagree about the same bytes, one of them is wrong and every diff built on it
 * is untrustworthy.
 *
 * So: run ONE handshake against the recording server, capture it from both sides,
 * and diff. Whatever remains is a genuine, explainable difference in what the two
 * vantage points can see — and the test pins exactly what that is, so a NEW
 * disagreement fails the build.
 */

import {
  captureEmulatorTraceFromFlow,
  captureHarTrace,
  diffGoldenTraces,
  formatTraceDiffHuman,
} from "../../src/oauth-golden-trace/index.js";
import { startCaptureServer } from "../support/oauth-capture-server.js";
import { runEmulatorAgainst } from "../support/oauth-emulator-driver.js";

/**
 * Every path the two vantage points are EXPECTED to disagree on.
 *
 * Pinned as an exact set rather than a `>=` budget, so BOTH directions fail: a
 * new disagreement is a regression, and a disappearing one means either a fix
 * that should shrink this list or a comparison that silently stopped running.
 *
 * The whole list is the same story told in three places. A client-side capture
 * records the headers the client CODE set; a server-side capture records what
 * ARRIVED, after undici appended its own. `diff.ts`'s `TRANSPORT_HEADERS` already
 * suppresses `host`, `connection`, `content-length`, `accept-encoding` and the
 * `sec-fetch-*` family for exactly this reason — these three escape it, and
 * deliberately so:
 *
 *   - `user-agent` is a first-class HP-44 finding (a host's UA is one of the
 *     things the golden traces exist to record), so it must not be silently
 *     ignored on same-vantage diffs. Cross-vantage it always diverges, because
 *     the state machine sets no UA and undici sends `node`. It shows up twice per
 *     leg: once on the wire, once in the `userAgent.byLeg` rollup derived from it.
 *   - `accept-language: *` is undici's default and is never set by the client.
 *   - `accept` diverges only on the three legs where the client sets none
 *     (`as-metadata-discovery`, `dcr-register`, `token`) and undici defaults to
 *     the wildcard. On `prm-discovery`, `mcp-unauthenticated` and `mcp-initialize` the
 *     client sets `accept` explicitly, and both sides agree — which is the
 *     control proving this is a stack default and not a lost header.
 *
 * `subject.hostVersion` is an artifact of THIS TEST's inputs: `captureHarTrace`
 * is handed a literal `"test"` below (a HAR carries no host version), while the
 * client-side capture stamps the real SDK version. Not a capture-path defect.
 *
 * The `authorize` leg contributes nothing here: the client side never observed
 * its headers at all, so every header on it is a `gap`, which the second test
 * pins directly.
 */
const EXPECTED_VANTAGE_DIVERGENCE = [
  "subject.hostVersion",
  "observations.userAgent.byLeg.as-metadata-discovery",
  "observations.userAgent.byLeg.dcr-register",
  "observations.userAgent.byLeg.mcp-initialize",
  "observations.userAgent.byLeg.mcp-unauthenticated",
  "observations.userAgent.byLeg.prm-discovery",
  "observations.userAgent.byLeg.token",
  "wire[leg=as-metadata-discovery].request.headers.user-agent",
  "wire[leg=dcr-register].request.headers.user-agent",
  "wire[leg=mcp-initialize].request.headers.user-agent",
  "wire[leg=mcp-unauthenticated].request.headers.user-agent",
  "wire[leg=prm-discovery].request.headers.user-agent",
  "wire[leg=token].request.headers.user-agent",
  "wire[leg=as-metadata-discovery].request.headers.accept-language",
  "wire[leg=dcr-register].request.headers.accept-language",
  "wire[leg=mcp-initialize].request.headers.accept-language",
  "wire[leg=mcp-unauthenticated].request.headers.accept-language",
  "wire[leg=prm-discovery].request.headers.accept-language",
  "wire[leg=token].request.headers.accept-language",
  "wire[leg=as-metadata-discovery].request.headers.accept",
  "wire[leg=dcr-register].request.headers.accept",
  "wire[leg=token].request.headers.accept",
];

/**
 * Divergence that is NOT a vantage artifact — a real defect, recorded here so the
 * set above stays honest about what it is claiming.
 *
 * `debug-oauth-2025-11-25.ts` pushes an `authenticatedRequest` into `httpHistory`
 * whose headers include `MCP-Protocol-Version` (~line 2112), then executes the
 * request WITHOUT it (~line 2170). So the client-side trace reports a header the
 * client never put on the wire, and the server-side trace — which is the one
 * telling the truth — shows it absent. `debug-oauth-2025-06-18.ts` has the same
 * split; `debug-oauth-2026-07-28.ts` sets it in both places and is the correct
 * shape to copy.
 *
 * Kept separate from `EXPECTED_VANTAGE_DIVERGENCE` on purpose: this entry is a bug
 * record, not an approval. When the state machine is fixed these two paths move to
 * matches and this list becomes empty, which is the outcome the assertion wants.
 *
 * Note that the ROLLUP (`observations.protocolVersion.headerOnMcpTraffic`) still
 * matches, because the unauthenticated probe does send the header and the rollup
 * unions the legs. Only the per-leg field catches this — which is the argument for
 * `headerByLeg` existing at all.
 */
const KNOWN_RECORDED_VS_SENT_DIVERGENCE = [
  "wire[leg=mcp-initialize].request.headers.mcp-protocol-version",
  "observations.protocolVersion.headerByLeg.mcp-initialize",
];

describe("HP-44 capture-path cross-validation", () => {
  it("agrees between the client-side and server-side views of one handshake", async () => {
    const server = await startCaptureServer();
    try {
      const run = await runEmulatorAgainst(server);
      expect(run.completed, `flow ended at ${run.finalStep}: ${run.error ?? ""}`).toBe(
        true,
      );

      const clientSide = captureEmulatorTraceFromFlow({
        flow: run.flow,
        hostId: "mcpjam",
        scenario: server.scenario,
        capturedAt: "2026-07-29",
      });

      const { trace: serverSide, report } = captureHarTrace({
        har: server.har(),
        hostId: "mcpjam",
        scenario: server.scenario,
        capturedAt: "2026-07-29",
        hostVersion: "test",
        oauthImplementation: { kind: "first-party" },
      });

      // Nothing was dropped, and the server saw a complete dance.
      expect(report.dropped).toEqual([]);
      expect(report.missingLegs).toEqual([]);

      const diff = diffGoldenTraces(serverSide, clientSide, { mode: "drift" });
      if (diff.counts.difference > 0) {
        // eslint-disable-next-line no-console
        console.log(formatTraceDiffHuman(diff));
      }

      // The divergence budget, pinned as a SET. Logging it (above) told CI nothing:
      // twenty-four differences read exactly like zero to a green checkmark. See
      // EXPECTED_VANTAGE_DIVERGENCE for why each one is legitimate, and
      // KNOWN_RECORDED_VS_SENT_DIVERGENCE for the one that is not.
      const differing = diff.findings
        .filter((finding) => finding.severity === "difference")
        .map((finding) => finding.path)
        .sort();
      expect(differing).toEqual(
        [
          ...EXPECTED_VANTAGE_DIVERGENCE,
          ...KNOWN_RECORDED_VS_SENT_DIVERGENCE,
        ].sort(),
      );

      // Both sides must see the same stages in the same order. This is the core
      // agreement claim: if the HAR ingest mis-classified a leg, or the client-side
      // dedupe collapsed one it shouldn't, this breaks.
      expect(serverSide.observations.legOrder).toEqual(
        clientSide.observations.legOrder,
      );

      // Both must agree on the facts the harness exists to capture.
      expect(serverSide.observations.dcrIdentity.clientName).toEqual(
        clientSide.observations.dcrIdentity.clientName,
      );
      expect(serverSide.observations.resourceIndicator.onToken).toEqual(
        clientSide.observations.resourceIndicator.onToken,
      );
      expect(serverSide.observations.pkce.challengeMethod).toEqual(
        clientSide.observations.pkce.challengeMethod,
      );
      expect(serverSide.observations.protocolVersion.initializeBody).toEqual(
        clientSide.observations.protocolVersion.initializeBody,
      );

      expect(diff.counts.incomparable).toBe(0);
      expect(diff.counts.match).toBeGreaterThan(20);
    } finally {
      await server.close();
    }
  }, 60_000);

  it("sees the /authorize headers from the server side that the client side cannot", async () => {
    // The one asymmetry that is real rather than a bug. The client hands the
    // authorize URL to a browser, so a client-side capture can only RECONSTRUCT
    // that leg and must mark its headers unobserved. A server-side capture
    // intercepts the request and sees them. The harness has to represent that
    // honestly from both vantage points instead of pretending one of them is wrong.
    const server = await startCaptureServer();
    try {
      const run = await runEmulatorAgainst(server);
      expect(run.completed).toBe(true);

      const clientSide = captureEmulatorTraceFromFlow({
        flow: run.flow,
        hostId: "mcpjam",
        scenario: server.scenario,
        capturedAt: "2026-07-29",
      });
      const { trace: serverSide } = captureHarTrace({
        har: server.har(),
        hostId: "mcpjam",
        scenario: server.scenario,
        capturedAt: "2026-07-29",
        hostVersion: "test",
      });

      // Client side: reconstructed, headers unobserved.
      const clientAuthorize = clientSide.wire.find((e) => e.leg === "authorize");
      expect(clientAuthorize?.request.headersObserved).toBe(false);
      expect(clientSide.observations.userAgent.byLeg.authorize?.state).toBe(
        "not-observed",
      );

      // Server side: intercepted, so headers ARE observed — and the params agree
      // with the client's reconstruction, which is what makes the reconstruction
      // trustworthy in the first place.
      const serverAuthorize = serverSide.wire.find((e) => e.leg === "authorize");
      // Asserted before the header check below, which would otherwise pass
      // vacuously on `undefined` — a server-side capture that lost the authorize
      // leg entirely would read as "headers observed" and this test would be
      // green about the one asymmetry it exists to pin down.
      expect(serverAuthorize).toBeDefined();
      expect(serverAuthorize?.request.headersObserved).not.toBe(false);
      expect(serverAuthorize?.request.query?.resource).toEqual(
        clientAuthorize?.request.query?.resource,
      );
      expect(serverAuthorize?.request.query?.code_challenge_method).toEqual(
        clientAuthorize?.request.query?.code_challenge_method,
      );

      // And the differ reports the header asymmetry as a GAP, not a difference.
      const diff = diffGoldenTraces(serverSide, clientSide, { mode: "drift" });
      const authorizeHeaders = diff.findings.find(
        (finding) => finding.path === "wire[leg=authorize].request.headers",
      );
      expect(authorizeHeaders?.severity).toBe("gap");
    } finally {
      await server.close();
    }
  }, 60_000);
});
