/**
 * HP-44 — the conformance-run ingest path.
 *
 * The case under test is the one that makes a trace mean different things
 * depending on a flag nobody thought was about tracing: with
 * `oauthConformanceChecks` enabled, the runner deliberately sends malformed
 * traffic AFTER the handshake completes, and records it in `httpAttempts` exactly
 * like real traffic. If those probes reach the wire, the same host produces two
 * different traces depending on whether checks happened to be on — which would
 * make every parity result unreproducible.
 */

import { describe, expect, it } from "vitest";
import { collectHttpHistory } from "../../src/oauth-golden-trace/index.js";
import type {
  ConformanceResult,
  ConformanceStepId,
  StepResult,
} from "../../src/oauth-conformance/types.js";
import type { HttpHistoryEntry } from "../../src/oauth/types.js";

function attempt(url: string): HttpHistoryEntry {
  return {
    step: "token_request",
    timestamp: 1_800_000_000_000,
    request: { method: "POST", url, headers: {} },
  };
}

function step(id: ConformanceStepId, attempts: HttpHistoryEntry[]): StepResult {
  return {
    step: id,
    title: id,
    summary: id,
    status: "passed",
    durationMs: 0,
    logs: [],
    httpAttempts: attempts,
  };
}

function result(steps: StepResult[]): ConformanceResult {
  return {
    passed: true,
    protocolVersion: "2025-06-18",
    registrationStrategy: "dcr",
    serverUrl: "https://mcp.example.test/mcp",
    steps,
    summary: "ok",
    durationMs: 0,
  };
}

describe("collectHttpHistory", () => {
  it("keeps handshake traffic and drops post-flow conformance-check probes", () => {
    const history = collectHttpHistory(
      result([
        step("token_request", [attempt("https://as.example.test/token")]),
        // Two real checks, each of which really does send HTTP: a DCR with a bad
        // redirect_uri and a token request with a bogus client_id. Both would
        // otherwise add extra `token`/`dcr-register` legs and shift `legOrder`.
        step("oauth_dcr_http_redirect_uri", [
          attempt("https://as.example.test/register"),
        ]),
        step("oauth_invalid_client", [attempt("https://as.example.test/token")]),
      ]),
    );

    expect(history.map((entry) => entry.request.url)).toEqual([
      "https://as.example.test/token",
    ]);
  });

  it("preserves execution order across the handshake steps it keeps", () => {
    const history = collectHttpHistory(
      result([
        step("discovery", [attempt("https://mcp.example.test/.well-known/x")]),
        step("oauth_invalid_client", [attempt("https://as.example.test/token")]),
        step("token_request", [attempt("https://as.example.test/token")]),
      ]),
    );

    expect(history.map((entry) => entry.request.url)).toEqual([
      "https://mcp.example.test/.well-known/x",
      "https://as.example.test/token",
    ]);
  });

  it("does not read an Object.prototype member as a conformance check", () => {
    // The classification is `Object.hasOwn(CONFORMANCE_CHECK_METADATA, step)`, not
    // `in`. With `in`, a step id colliding with a prototype member would be
    // filtered out as a "check" and its real traffic would vanish from the trace.
    const history = collectHttpHistory(
      result([
        step("constructor" as ConformanceStepId, [
          attempt("https://as.example.test/token"),
        ]),
      ]),
    );

    expect(history).toHaveLength(1);
  });
});
