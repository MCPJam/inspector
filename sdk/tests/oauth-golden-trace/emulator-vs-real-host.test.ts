/**
 * HP-44 — the diff this whole harness exists to run.
 *
 * Every other test either proves a mechanism in isolation or validates one
 * artifact. This one does the actual job: take the recorded handshake of a REAL
 * third-party host, run our emulator configured to reproduce that host against
 * the same server, and diff the two field by field.
 *
 * The golden side is `claude-code` 2.1.220, captured by pointing a headless Claude
 * Code at `tests/support/oauth-capture-server.ts` (committed at
 * `fixtures/golden-traces/claude-code-http-capture-dcr-authcode-prm.json`).
 *
 * The candidate side is produced here, live, by driving `runOAuthStateMachine`
 * directly — not through `OAuthConformanceTest` — because:
 *
 *   - the conformance runner does not plumb `allowLoopbackMetadataFetch`, so it
 *     cannot talk to a loopback test server at all (a real HP-39 gap, noted in the
 *     coverage doc); and
 *   - HP-43's per-host emulator will not route through the conformance runner
 *     either, so capturing from a raw flow record is the shape that will actually
 *     be used.
 *
 * **What this test asserts is deliberately NOT "parity".** Configuring the DCR
 * body by hand is a stand-in for HP-43, which does not exist yet, so a green
 * parity result here would be meaningless — it would only prove that the fields I
 * typed in match the fields I read out. What it asserts instead is that the
 * ORACLE WORKS ON REAL DATA: that it finds the differences that genuinely remain,
 * attributes them to the right dimension, and reports the unobserved legs as gaps
 * rather than as either passes or failures.
 *
 * The remaining differences are the concrete work list for HP-43.
 */

import { runOAuthStateMachine } from "../../src/oauth/state-machines/runner.js";
import type {
  OAuthDynamicRegistrationMetadata,
  OAuthFlowState,
} from "../../src/oauth/state-machines/types.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";
import {
  captureEmulatorTraceFromFlow,
  diffGoldenTraces,
  formatTraceDiffHuman,
} from "../../src/oauth-golden-trace/index.js";
import type { GoldenTrace } from "../../src/oauth-golden-trace/index.js";
import { startCaptureServer } from "../support/oauth-capture-server.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GOLDEN = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "golden-traces",
  "claude-code-http-capture-dcr-authcode-prm.json",
);

/**
 * The DCR identity the real capture showed Claude Code sending.
 *
 * Hand-configured here BECAUSE HP-43 does not exist. When it does, these values
 * come from the host profile — which `traceToOAuthProfile` generates from the very
 * trace this test diffs against, closing the loop.
 */
const CLAUDE_CODE_DCR: Partial<OAuthDynamicRegistrationMetadata> = {
  client_name: "Claude Code (hp44capture)",
  redirect_uris: ["http://localhost:3118/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  scope: "mcp:read mcp:write",
};

describe("HP-44 emulator vs real host", () => {
  it("diffs our emulator against the recorded claude-code handshake", async () => {
    const server = await startCaptureServer();
    try {
      let state: OAuthFlowState = {
        ...EMPTY_OAUTH_FLOW_STATE,
        serverUrl: server.mcpUrl,
      };

      const run = await runOAuthStateMachine({
        protocolVersion: "2025-11-25",
        registrationStrategy: "dcr",
        serverUrl: server.mcpUrl,
        serverName: "hp44capture",
        redirectUrl: "http://localhost:3118/callback",
        state,
        getState: () => state,
        updateState: (updates) => {
          state = { ...state, ...updates };
        },
        dynamicRegistration: CLAUDE_CODE_DCR,
        customScopes: "mcp:read mcp:write",
        authMode: "headless",
        // A real fetch. The state machine records each request into
        // `state.httpHistory`, which is the wire the trace is built from — so what
        // gets diffed is what actually went over the socket.
        requestExecutor: async (request) => {
          const response = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            ...(request.body != null
              ? {
                  body:
                    typeof request.body === "string"
                      ? request.body
                      : JSON.stringify(request.body),
                }
              : {}),
            redirect: request.redirect === "manual" ? "manual" : "follow",
          });
          const text = await response.text();
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : undefined;
          } catch {
            // Non-JSON bodies pass through as text; the trace records them opaque.
          }
          const headers: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            headers[key] = value;
          });
          return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers,
            body,
          };
        },
        // The test server IS loopback. Without this the SSRF guard refuses every
        // metadata fetch — which is exactly why the conformance runner cannot be
        // used against a local test server today.
        allowLoopbackMetadataFetch: true,
        onAuthorizationRequest: async ({ authorizationUrl }) => {
          // Follow the 302 ourselves, standing in for the browser.
          const response = await fetch(authorizationUrl, { redirect: "manual" });
          const location = response.headers.get("location");
          const code = location
            ? new URL(location).searchParams.get("code")
            : null;
          if (!code) throw new Error(`no code in redirect: ${location}`);
          return { type: "authorization_code", authorizationCode: code };
        },
      });

      // eslint-disable-next-line no-console
      console.log(
        `emulator run: completed=${run.completed} step=${state.currentStep} error=${run.error?.message ?? "none"} | server saw ${server.requestCount()} requests`,
      );

      const candidate = captureEmulatorTraceFromFlow({
        flow: {
          httpHistory: state.httpHistory ?? [],
          ...(run.authorizationUrl ? { authorizationUrl: run.authorizationUrl } : {}),
        },
        // Emulating claude-code, so the trace must say so — otherwise the differ
        // correctly refuses to compare it against a claude-code golden trace.
        hostId: "claude-code",
        scenario: server.scenario,
        capturedAt: "2026-07-29",
        hostVersion: "2.1.220",
        stateMachine: "debug-oauth-2025-11-25",
        notes: [
          "Emulator side, driven via runOAuthStateMachine with claude-code's captured DCR identity. Stands in for HP-43's per-host emulator, which does not exist yet.",
        ],
      });

      const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as GoldenTrace;

      // Both sides used a freshly-bound ephemeral server port, and the golden trace
      // was captured on a different one. Rewrite the candidate's scenario onto the
      // golden trace's so the scenario GATE compares like with like — the
      // capabilities are identical by construction (same server module).
      const aligned: GoldenTrace = {
        ...candidate,
        scenario: golden.scenario,
        wire: JSON.parse(
          JSON.stringify(candidate.wire).split(server.origin).join("http://127.0.0.1:3999"),
        ),
      };

      const diff = diffGoldenTraces(golden, aligned, { mode: "parity" });
      // eslint-disable-next-line no-console
      console.log(formatTraceDiffHuman(diff));

      // The oracle must actually be running — not short-circuited by an
      // `incomparable` gate, which would make every other assertion vacuous.
      expect(diff.counts.incomparable).toBe(0);

      // It must find real matches on the legs both sides observed.
      expect(diff.counts.match).toBeGreaterThan(10);

      // The DCR body is what HP-43 will drive from the host profile, and it is the
      // part a hand-configured stand-in can already get right. Prove the oracle
      // confirms it rather than merely failing to notice.
      const clientName = diff.findings.find(
        (finding) => finding.path === "observations.dcrIdentity.clientName",
      );
      expect(clientName?.severity).toBe("match");
      const authMethod = diff.findings.find(
        (finding) =>
          finding.path === "observations.dcrIdentity.tokenEndpointAuthMethod",
      );
      expect(authMethod?.severity).toBe("match");

      // The golden capture stopped before /token, so anything downstream of it is a
      // GAP — not a difference, and above all not a pass. This is the assertion
      // that keeps a partial golden trace from silently certifying the emulator.
      const onToken = diff.findings.find(
        (finding) => finding.path === "observations.resourceIndicator.onToken",
      );
      expect(onToken?.severity).toBe("gap");

      // eslint-disable-next-line no-console
      console.log(
        `HP-43 work list — ${diff.counts.difference} difference(s):\n${diff.findings
          .filter((f) => f.severity === "difference")
          .map((f) => `  - [${f.dimension}] ${f.path}`)
          .join("\n")}`,
      );
    } finally {
      await server.close();
    }
  }, 60_000);
});
