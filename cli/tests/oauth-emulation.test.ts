import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertOAuthEmulationEnabled,
  emulationExitCode,
  loadOAuthGoldenFile,
  loadOAuthProfileFile,
  OAUTH_EMULATION_FLAG,
  parseStaticCredential,
  renderEmulationResult,
  writeEmulationTraceFile,
} from "../src/lib/oauth-emulation.js";

function tempFile(contents: string, name = "profile.json"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mcpjam-oauth-emulation-"));
  const filePath = path.join(dir, name);
  writeFileSync(filePath, contents, "utf-8");
  return filePath;
}

const VERIFIED = {
  status: "verified",
  value: ["oauth2-dcr"],
  source: "https://example.test/capture#L1",
  capturedAt: "2026-07-30",
};

test("the emulator is off unless the rollout flag is set", () => {
  assert.throws(
    () => assertOAuthEmulationEnabled({}),
    /behind a feature flag/,
  );
  // A truthy-but-wrong value must not enable it either.
  assert.throws(
    () => assertOAuthEmulationEnabled({ [OAUTH_EMULATION_FLAG]: "true" }),
    /behind a feature flag/,
  );
  assert.doesNotThrow(() =>
    assertOAuthEmulationEnabled({ [OAUTH_EMULATION_FLAG]: "1" }),
  );
});

test("the flag message names the side effects it is guarding", () => {
  try {
    assertOAuthEmulationEnabled({});
    assert.fail("expected a usage error");
  } catch (error) {
    const message = (error as Error).message;
    assert.match(message, /registers a client/);
    assert.match(message, /token/);
  }
});

test("a profile is canonicalized on load, so an invalid one fails loudly", () => {
  const valid = tempFile(
    JSON.stringify({ profileVersion: 2, authModel: VERIFIED }),
  );
  const profile = loadOAuthProfileFile(valid);
  assert.equal(profile.profileVersion, 2);

  // Unverifiable evidence may not carry a value — the same rule the backend
  // canonicalizer enforces, applied here rather than half-emulated later.
  const invalid = tempFile(
    JSON.stringify({
      profileVersion: 2,
      authModel: { status: "unverifiable", reason: "closed", value: ["none"] },
    }),
  );
  assert.throws(() => loadOAuthProfileFile(invalid), /value must be omitted/);
});

test("profile loading rejects unreadable, non-JSON, and non-object inputs", () => {
  assert.throws(
    () => loadOAuthProfileFile("/definitely/not/here.json"),
    /Cannot read OAuth profile/,
  );
  assert.throws(
    () => loadOAuthProfileFile(tempFile("{not json")),
    /is not valid JSON/,
  );
  assert.throws(
    () => loadOAuthProfileFile(tempFile("[]")),
    /must be a JSON object/,
  );
});

test("a golden without a profile binding is refused before any run", () => {
  const unbound = tempFile(
    JSON.stringify({ capturedAt: "2026-08-01", steps: [] }),
    "golden.json",
  );
  assert.throws(() => loadOAuthGoldenFile(unbound), /profileDigest/);

  const bound = tempFile(
    JSON.stringify({
      profileDigest: "d",
      capturedAt: "2026-08-01",
      steps: [],
    }),
    "golden.json",
  );
  assert.equal(loadOAuthGoldenFile(bound).profileDigest, "d");
});

test("static credentials parse as Header-Name: value", () => {
  assert.deepEqual(parseStaticCredential("X-Acme-Key: s3cret"), {
    headerName: "X-Acme-Key",
    value: "s3cret",
  });
  // A value containing a colon keeps it.
  assert.deepEqual(parseStaticCredential("Authorization: Bearer a:b"), {
    headerName: "Authorization",
    value: "Bearer a:b",
  });
  assert.throws(() => parseStaticCredential("no-separator"), /format/);
  assert.throws(() => parseStaticCredential(": value"), /format/);
  assert.throws(() => parseStaticCredential("Header:  "), /non-empty/);
});

test("exit codes separate a pass, a finding, and an unestablished run", () => {
  const notCompared = {
    status: "not_compared" as const,
    qualifiers: [],
    differences: [],
    declaredSubstitutions: [],
  };
  assert.equal(
    emulationExitCode({ outcome: "completed", comparison: notCompared }),
    0,
  );
  assert.equal(
    emulationExitCode({ outcome: "static_credential_ok", comparison: notCompared }),
    0,
  );
  assert.equal(
    emulationExitCode({ outcome: "unauthenticated_ok", comparison: notCompared }),
    0,
  );
  assert.equal(
    emulationExitCode({ outcome: "blocked", comparison: notCompared }),
    1,
  );
  assert.equal(
    emulationExitCode({ outcome: "error", comparison: notCompared }),
    1,
  );
  // Stopping at the human leg establishes nothing — it is not a pass.
  assert.equal(
    emulationExitCode({ outcome: "stopped_at_redirect", comparison: notCompared }),
    3,
  );
});

test("a mismatched comparison fails the run even when the dance completed", () => {
  assert.equal(
    emulationExitCode({
      outcome: "completed",
      comparison: {
        status: "mismatched",
        qualifiers: [],
        differences: [
          { index: 0, kind: "body", detail: "request body differs" },
        ],
        declaredSubstitutions: [],
      },
    }),
    1,
  );
});

test("the summary keeps the three dimensions separate and never hides a qualifier", () => {
  const output = renderEmulationResult({
    serverUrl: "https://mcp.example.com/mcp",
    protocolVersion: "2025-11-25",
    outcome: "completed",
    coverage: {
      sendsResourceIndicator: "modeled",
      oauthSpecVersion: "modeled",
      protocolVersionPinning: "not_modeled",
      scopeRequest: "modeled",
      dcrIdentity: "modeled",
      tokenEndpointAuthMethod: "modeled",
      authModel: "modeled",
    },
    coverageSummary: "partial",
    comparison: {
      status: "matched",
      qualifiers: ["partial_coverage", "stale_capture"],
      differences: [],
      declaredSubstitutions: [],
    },
    trace: [],
    bindings: {},
    attempts: [
      { kind: "oauth", status: "ok", registrationStrategy: "dcr" },
    ],
    divergences: [
      { kind: "redirect-uri-appended", detail: "callback appended" },
    ],
    sideEffects: { dcrRegistrations: 1, tokensIssued: 1 },
  });

  assert.match(output, /Outcome:\s+completed/);
  assert.match(output, /Coverage:\s+partial/);
  // The unmodeled field is named, not just counted.
  assert.match(output, /protocolVersionPinning/);
  // A qualified match must never print as bare parity.
  assert.match(output, /Compared:\s+matched \[partial_coverage, stale_capture\]/);
  assert.match(output, /1 client registration\(s\), 1 token\(s\) issued/);
  assert.match(output, /redirect-uri-appended/);
});

test("the summary prints the authorization URL when a human is required", () => {
  const output = renderEmulationResult({
    serverUrl: "https://mcp.example.com/mcp",
    protocolVersion: "2025-11-25",
    outcome: "stopped_at_redirect",
    coverage: {
      sendsResourceIndicator: "not_modeled",
      oauthSpecVersion: "not_modeled",
      protocolVersionPinning: "not_modeled",
      scopeRequest: "not_modeled",
      dcrIdentity: "not_modeled",
      tokenEndpointAuthMethod: "not_modeled",
      authModel: "not_modeled",
    },
    coverageSummary: "partial",
    comparison: {
      status: "not_compared",
      reason: "no_golden",
      qualifiers: [],
      differences: [],
      declaredSubstitutions: [],
    },
    trace: [],
    bindings: {},
    attempts: [{ kind: "oauth", status: "redirected" }],
    divergences: [],
    sideEffects: { dcrRegistrations: 1, tokensIssued: 0 },
    authorizationUrl: "https://as.example.com/authorize?client_id=x",
  });

  assert.match(output, /Compared:\s+not_compared \(no_golden\)/);
  assert.match(output, /a human must visit it/);
  assert.match(output, /https:\/\/as\.example\.com\/authorize/);
});

test("a captured trace is written already bound to its profile", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mcpjam-oauth-trace-"));
  const outPath = path.join(dir, "nested", "golden.json");
  const written = await writeEmulationTraceFile(
    outPath,
    {
      trace: [
        {
          step: "token_request",
          method: "POST",
          url: "https://as.example.com/token",
          headers: {},
        },
      ],
    },
    "profile-digest-abc",
    new Date("2026-08-03T12:00:00Z"),
  );

  const golden = JSON.parse(readFileSync(written, "utf-8"));
  assert.equal(golden.profileDigest, "profile-digest-abc");
  assert.equal(golden.capturedAt, "2026-08-03");
  assert.equal(golden.steps.length, 1);
  // It must round-trip through the loader it will be read back with.
  assert.equal(loadOAuthGoldenFile(written).profileDigest, "profile-digest-abc");
});
