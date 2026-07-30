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
